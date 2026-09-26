"""统一 AgentEvent 流消费（PRD-LLM-18 LLM18-004，FR-RUN-02/04）。

`consume_agent_events` 是 collect 与 stream 共用的唯一事件消费实现：解析
LLMRunner 的 SSE 流、清洗 token、跟踪用量/文件/工具/交互/压缩/取消/错误，
并把轮次完成语义（含「工具续轮被截断不得伪装成功」守卫）收敛在一处。

历史教训：collect 与 stream 曾各持一份消费实现并发生漂移——stream 漏消费
``_context_compaction``（压缩后 compaction_applied 恒 False）、续轮截断守卫
两边各写一份。本模块就是它们的合并终态。

Sink 形态（LLM18-005）：消费器是 async generator，按 Sink 配置决定是否向外
转发 token/round_end；「攒整段」的 CollectSink 不转发、只经回调通知展示，
「逐字流」的 WebStreamSink 全量转发。QQ/飞书 CardKit 与传输失败 drain 属于
平台层 Sink（见 LLM18-009 边界结论），不在本层。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import AsyncIterator, Callable

from agent.errors import LLMErrorPresentation
from agent.security import sanitize
from agent.models import AgentResponse

EVENT_TOKEN = "token"
EVENT_FINAL = "final"


@dataclass
class RunOutcome:
    """一次 run 的消费结果快照；由 consume_agent_events 填充，收尾层读取。"""

    text: str = ""                       # 最终正文（错误时=错误文案，不入历史）
    round_texts: list = field(default_factory=list)   # 逐轮正文（strip 后，空轮剔除）
    # 流式顺序的展示时间线（assistant 轮次 + tool 项交错，语义与 gateway/web.py 的
    # display_timeline 一致）。收尾层优先用它持久化 display_timeline——此前 IM/定时
    # 路径只存正文轮次，刷新后工具气泡只能走兼容 toolEvents 通道（按 canonical 行
    # id 排序，全部早于末条 assistant 消息），导致工具气泡整体跳到该轮正文前面。
    display_timeline_items: list = field(default_factory=list)
    tokens_in: int = 0
    tokens_out: int = 0
    cache_read: int = 0
    cache_write: int = 0
    context_input: int = 0
    files: list = field(default_factory=list)
    tool_names: list = field(default_factory=list)
    interactions: list = field(default_factory=list)
    tool_events: list = field(default_factory=list)
    mutated: bool = False
    cancelled: bool = False
    errored: bool = False
    errored_text: str = ""
    error_info: LLMErrorPresentation | None = None
    compaction_applied: bool = False

    @property
    def interrupted(self) -> bool:
        """错误或用户取消：终态载荷不进入历史/反思。"""
        return self.errored or self.cancelled


@dataclass(frozen=True)
class CollectSink:
    """攒整段 Sink：QQ/飞书文本/定时任务经 run_collect 消费。

    token 不外发；每轮完成时把出站清洗后的展示文本经 ``on_round`` 通知
    （发送失败不影响 Agent 执行，见 runner._notify_round）。
    """

    on_tool_event: Callable | None = None
    on_round: Callable | None = None
    yield_tokens: bool = False
    yield_round_ends: bool = False


@dataclass(frozen=True)
class WebStreamSink:
    """逐字流 Sink：token 与轮结束原样外发（run_stream 的飞书卡流消费形态）。"""

    on_tool_event: Callable | None = None
    on_round: Callable | None = None
    yield_tokens: bool = True
    yield_round_ends: bool = True


async def consume_agent_events(
    gen,
    *,
    model_cfg,
    outcome: RunOutcome,
    sink: CollectSink | WebStreamSink,
) -> AsyncIterator[tuple]:
    """消费 LLMRunner 事件流，填充 outcome；按 Sink 配置转发 token/round_end。

    生成器正常耗尽或中途 break（error/cancelled）都会返回；续轮截断守卫在
    finally 之后统一判定。
    """
    from agent import providers
    provider_adapter = providers.adapter_for(model_cfg) if model_cfg is not None else None
    san = sanitize.StreamSanitizer(adapter=provider_adapter)
    rounds: list[str] = []
    cur = ""
    continuation_pending = False
    # 当前轮的展示时间线占位（首个 token 时创建）；工具项按流式顺序插在其后，
    # 轮次冲刷时回填清洗后的正文——镜像 gateway/web.py 的 display_timeline 语义。
    active_seg: dict | None = None

    def _close_active_seg(display_round: str) -> None:
        nonlocal active_seg
        if active_seg is None:
            return
        if display_round:
            active_seg["text"] = display_round
        else:
            # 纯工具轮（清洗后无正文）：占位段不落时间线
            try:
                outcome.display_timeline_items.remove(active_seg)
            except ValueError:
                pass
        active_seg = None

    async def flush_current_round() -> None:
        """完成当前轮：出站清洗后通知展示 Sink，并按配置外发 ROUND_END。

        在轮次切换（_new_round）与交互暂停前都要调用——不先冲刷的话，前置说明
        会滞留到下一轮，IM 会先看到选择卡、选完后才看到这段说明。
        """
        nonlocal cur, san
        cur += san.flush()
        rounds.append(cur)
        completed = cur.strip()
        cur = ""
        san = sanitize.StreamSanitizer(adapter=provider_adapter)
        display_round = ""
        if completed:
            from agent.outbound import sanitize_outbound
            display_round = sanitize.strip_disallowed_emoji(sanitize_outbound(completed)).strip()
        _close_active_seg(display_round)
        if not completed:
            return
        if sink.on_round is not None:
            await _notify_round(sink.on_round, display_round)
        if sink.yield_round_ends:
            from agent.interactions.events import ROUND_END
            yield (ROUND_END, completed)

    interrupted = False
    try:
        async for evt_str in gen:
            try:
                evt = json.loads(evt_str[6:])  # strip "data: "
            except Exception:
                continue
            t = evt.get("type")
            if t == "_new_round":
                # 这个事件由核心循环在工具结果写回后发出，表示下一轮 LLM
                # 请求已经被承诺。若生成器随后异常结束，不能把前面已流出的
                # 工具前置说明误当作最终回复。
                async for _ in flush_current_round():
                    yield _
                continuation_pending = True
            elif t == "round_start":
                continuation_pending = False
            elif t == "_usage":
                outcome.tokens_in = evt.get("input", 0)
                outcome.context_input = max(
                    outcome.context_input, int(evt.get("context_input", outcome.tokens_in) or 0))
                outcome.tokens_out = evt.get("output", 0)
                outcome.cache_read = evt.get("cache_read", 0) or 0
                outcome.cache_write = evt.get("cache_write", 0) or 0
            elif t == "_context_compaction":
                outcome.compaction_applied = bool(evt.get("applied")) or outcome.compaction_applied
            elif t == "token":
                token = san.feed(evt.get("content", ""))
                if token:
                    if active_seg is None:
                        active_seg = {"kind": "assistant", "text": ""}
                        outcome.display_timeline_items.append(active_seg)
                    active_seg["text"] += token
                    cur += token
                    if sink.yield_tokens:
                        yield (EVENT_TOKEN, token)
            elif t == "file" and evt.get("file"):
                file = evt["file"]
                outcome.files.append(file)   # 咕咕用 send_file 工具要发的文件
                # 带 display_timeline 的 assistant 行会从 messages 中隐藏，附件必须
                # 同步落入时间线，否则 QQ 虽已收到文件，Web 刷新后无法恢复文件卡。
                outcome.display_timeline_items.append({
                    "kind": "assistant",
                    "runId": evt.get("run_id"),
                    "roundId": evt.get("round_id"),
                    "text": "",
                    "files": [file],
                })
            elif t in {"tool_call", "tool_done"}:
                tool_event = dict(evt)
                outcome.tool_events.append(tool_event)
                await _notify_tool_event(sink.on_tool_event, tool_event)
                name = str(evt.get("name") or "")
                if t == "tool_call":
                    if name and name not in outcome.tool_names:
                        outcome.tool_names.append(name)
                    # 展示时间线：tool 项按流式顺序插入（语义对齐 gateway/web.py）
                    if name and not name.startswith("_"):
                        outcome.display_timeline_items.append({
                            "kind": "tool",
                            "toolCallId": str(evt.get("tool_call_id") or ""),
                            "toolName": name,
                            "toolLabel": str(evt.get("label") or name),
                            "toolInput": evt.get("input"),
                            "toolStatus": str(evt.get("status") or "running"),
                        })
                    # 按工具注册时显式声明的 mutates 判断，不再靠名字前缀猜——猜测式前缀匹配
                    # 会漏掉 remember（写长期记忆）、note_undo（删笔记）这类不落在
                    # create_/update_/delete_/... 词表里的写工具，导致失败后重跑整轮时
                    # 重复执行已经生效的写操作。
                    from agent.tools import registry as _tool_registry
                    tool = _tool_registry.snapshot().get(name)
                    if tool is not None and tool.mutates:
                        outcome.mutated = True
                else:
                    call_id = str(evt.get("tool_call_id") or "")
                    for item in reversed(outcome.display_timeline_items):
                        if item.get("kind") == "tool" and item.get("toolCallId") == call_id:
                            item["toolStatus"] = str(evt.get("status") or "success")
                            if "result" in evt:
                                item["toolResult"] = evt.get("result")
                            break
            elif t == "interaction_required":
                # ask_user 的交互回调会在生成器产出此事件后展示选择卡，并等待用户输入。
                # 若不先冲刷当前轮，前置说明会一直留在 cur，直到用户选择后核心循环才发
                # `_new_round`，导致 IM 先看到选择卡、选完后才看到这段说明。
                # token 只在当前事件中短暂存在，不能写入日志或历史；平台 adapter 负责决定是否展示。
                async for _ in flush_current_round():
                    yield _
                outcome.interactions.append({
                    key: evt[key]
                    for key in ("prompt_id", "kind", "title", "body", "options", "allow_text_input", "custom_input_active", "expires_at", "round_id", "tool_call_id", "force_display")
                    if key in evt
                })
            elif t == "_cancelled":
                outcome.cancelled = True   # 用户中途「算了」：停止收集，网关已回「先不继续」，worker 不再补发
                interrupted = True
                break
            elif t == "error":
                outcome.error_info = LLMErrorPresentation.from_event(evt)
                outcome.errored_text = evt.get("message") or evt.get("detail") or "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
                outcome.errored = True
                interrupted = True
                break
    except BaseException:
        # 生成器异常（含外层提前关闭的 GeneratorExit）：标记后原样向上抛，
        # 绝不吞掉——吞掉会把异常伪装成正常终态。
        outcome.errored = True
        raise

    if interrupted:
        # 错误/取消终态：保留当前进度供响应装配，不做最终轮拼接。
        outcome.round_texts = [r.strip() for r in rounds if r.strip()]
        if outcome.errored:
            outcome.text = outcome.errored_text
        return
    if continuation_pending:
        # 工具结果后的续轮没有真正开始时，禁止把上一轮的过程文字作为成功回复。
        outcome.errored = True
        outcome.errored_text = "工具结果已返回，但后续回复没有完成，请重试。"
        outcome.round_texts = [r.strip() for r in rounds if r.strip()]
        outcome.text = outcome.errored_text
        return
    cur += san.flush()
    rounds.append(cur)
    _close_active_seg(cur.strip())
    outcome.round_texts = [r.strip() for r in rounds if r.strip()]
    outcome.text = ""
    for r in reversed(rounds):
        r = r.strip()
        if r:
            outcome.text = r
            break


async def _notify_tool_event(callback, event: dict) -> None:
    """通知 IM 工具状态展示；展示失败只写受限诊断，不影响 Agent 执行。"""
    if callback is None:
        return
    try:
        await callback(event)
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("agent.im.tool_event_display", exc)


async def _notify_round(callback, text: str) -> bool:
    """通知 IM 展示已完成的正文 round；展示失败不影响 Agent 执行。"""
    if callback is None:
        return False
    try:
        result = await callback(text)
        return result is not False
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("agent.im.round_display", exc)
        return False


def cancelled_response(outcome: RunOutcome, session_id: int) -> AgentResponse:
    """用户中途取消的统一终态：不补发、不入历史（已执行的工具效果保留）。"""
    return AgentResponse(text="", session_id=session_id, tokens_in=outcome.tokens_in,
                         tokens_out=outcome.tokens_out, cancelled=True,
                         interactions=outcome.interactions, tool_events=outcome.tool_events)
