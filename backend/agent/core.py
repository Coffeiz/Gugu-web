"""LLM 主循环（迁自原 agent.py 的 _loop_anthropic / _loop_openai）。

`LLMRunner._run_loop`（PRD-LLM-1 Phase 2）：工具调用/核实阶段状态机/三条防幻觉守卫/
空回复兜底/轮次上限——这套控制流对 Anthropic 块格式和 OpenAI 格式完全一样，原来是
两条逐字复制的循环（`_run_anthropic`/`_run_openai`），现在收成一条共享循环，"怎么跟
这个 provider 打交道"（流式事件形状/工具参数解析/历史消息格式/缓存记账）收进
`agent/loop_drivers.py` 的 `AnthropicDriver`/`OpenAIDriver`。`_run_anthropic`/
`_run_openai` 两个方法名和外部签名原样保留（`runner.py`/`gateway/web.py` 等调用点、
以及 `tests/test_core_loop_characterization.py` 都按名字直接调用它们），内部只是转发
给 `_run_loop`。
"""
import asyncio
import json
import logging
import random
import re as _re_mod
from uuid import uuid4
from typing import Any, AsyncGenerator, Awaitable, Callable

from agent.llm import genstream
from agent import loop_drivers
from agent.tools import registry
from app.core.errors import RetryableError
from app.core.redaction import diag_log
from agent.interactions.stream_events import encode_event

_log = logging.getLogger("agent.core")

# ⑦ 慢尾兜底：LLM 瞬时错误（限流 429 / 超时 / 网络 / 5xx）退避重试——贴着并发上限跑时
# 把偶发 429 吸收成短延迟、不丢消息。只在「本轮还没吐 token 前」重试（已吐过再重试会重复输出）。
_RETRY_BACKOFF = [1, 2, 4]   # 退避秒数；最多重试 3 次


def _resolve_adapter_arguments(tool_input: Any) -> dict[str, Any]:
    """取得固定 Adapter 的业务参数。

    规范协议是 ``call_tool(name, arguments)``。部分模型会把目标工具的
    参数错误展开到 ``call_tool`` 顶层，例如 ``{name: "http_get", url: ...}``。
    这里只移除 Adapter 自己的 ``name``，把其余字段交给目标工具原有的
    schema 校验；不在这里猜测或放宽目标工具契约。
    """
    if not isinstance(tool_input, dict):
        return {}
    arguments = tool_input.get("arguments")
    if isinstance(arguments, dict):
        return arguments
    return {key: value for key, value in tool_input.items() if key != "name"}


async def _stream_round(client, kwargs, adapter=None):
    """跑一轮 Anthropic 流式，遇瞬时错误在出 token 前退避重试（P2-b §4-A 标杆模板）。
    yield ('token', delta) 逐字；结束 yield ('final', message)。

    两种「抛出」语义不同，调用方（主循环边界）据此区分：
    - **已吐过 token 中途出错**：不能重试（会重复输出），原样把底层异常抛出去——这不是
      「重试用尽」，是「已产生副作用不敢重试」，按未知/中断处理，不伪装成 RetryableError。
    - **重试用尽、一个 token 都没吐过**：包成 `RetryableError`（真正符合可重试语义：
      幂等——还没输出任何东西，从头重试不会重复）。

    `adapter`（`agent.providers.ProviderAdapter`）可选——不传（`None`）时只用下面这几个
    provider 无关的基础瞬时错误类型；传了就叠加该 provider 专属的容错（PRD-LLM-1）。
    """
    import anthropic
    transient = (anthropic.RateLimitError, anthropic.APITimeoutError,
                 anthropic.APIConnectionError, anthropic.InternalServerError)
    if adapter is not None:
        # 各 provider 专属的「流式响应跟 SDK 期望 schema 对不上」容错，只加给对应 provider——
        # 见 agent/providers.py 里每个适配器 transient_exceptions 的注释（MiniMax 的
        # IndexError/KeyError/AttributeError 是目前唯一非空的一份）。不全局放宽，避免把
        # 跟该 provider 无关的真实 bug 也当"重试就好"吞掉。
        transient = transient + adapter.transient_exceptions
    last = None
    for i in range(len(_RETRY_BACKOFF) + 1):
        emitted = False
        try:
            async with client.messages.stream(**kwargs) as stream:
                async for delta in stream.text_stream:
                    emitted = True
                    yield ("token", delta)
                yield ("final", await stream.get_final_message())
                return
        except transient as e:
            last = e
            if emitted:
                raise   # 已吐 token，重试会重复输出——原样抛给上层当未知/中断处理
            if i >= len(_RETRY_BACKOFF):
                # where 里带上 provider——上次这里崩溃排查时 diag_log 没记 provider，只能靠
                # 静态代码分析猜是哪家（PRD-LLM-1「待确认问题」），这次直接把它写进日志，
                # 下次同类问题不用再猜。
                _provider = adapter.name if adapter is not None else "unknown"
                diag_log(f"agent.core.stream_round provider={_provider}", e)   # 原始 → 受限诊断出口
                _log.warning("LLM 流式调用重试 %d 次后仍失败：%s", i, type(e).__name__)
                raise RetryableError("llm.stream_exhausted", "LLM 调用重试后仍失败",
                                      cause=e, attempt=i) from e
            _log.info("LLM 瞬时错误 %s，%ss 后重试(%d)", type(e).__name__, _RETRY_BACKOFF[i], i + 1)
            await asyncio.sleep(_RETRY_BACKOFF[i])
    if last:
        raise last

# 工具循环最大轮次。普通任务和核实轮分开计数，核实预算不能放大普通任务的上限。
MAX_ROUNDS = 8
# 一个 run 内模型实际请求的工具调用总数。工具自身仍可有更细的专用额度。
MAX_TOOL_CALLS = 10
_CANCEL_CHECK_EVERY = 24   # 流式途中每 N 个 token 协作检查一次取消（单轮长回答只能在这里掐断）

# ── 自我核实：成功做了增删改后，立刻跑一轮核实（用查询工具查证真生效/完整），
# 没做成/不完整就补做；最多 MAX_VERIFY 轮（每次对话回合计，非整 session），避免仅凭操作回执遗漏部分结果。
MAX_VERIFY = 5
# 最后一轮核实允许模型在完成最后一次查询后输出收束文本。
MAX_VERIFY_LLM_ROUNDS = MAX_VERIFY + 1
_TOOL_BUDGET_EXHAUSTED = "工具调用额度已用完。请不要再调用工具，直接根据已经获得的结果回复用户。"
_VERIFY_PROMPT = (
    "【内部核验 · 请执行】你刚才执行了增删改操作。现在用对应的查询工具检查结果是否生效且完整："
    "查询工具一般是 `list_*` / `get_*` / `read_*`（建项目用 `get_project` 看阶段待办、定时任务用 `list_scheduled_tasks` 看 cron/内容……照此类推）。"
    "**尤其改了文件正文（`edit_file`/`create_document`）：必须用 `read_file` 把内容读回来逐字比对——`list_files` 只能看文件在不在、读不到正文，光看那个不算核实。**"
    "**发现没做成或不完整 → 立刻补做，并简要说明补了什么**。"
    "核验过程属于内部步骤，不要把“核对完成”“复查完成”“已确认”等过程标签当成最终回复。"
    "核实后直接总结这次实际做了什么、哪些成功、哪些没做成及原因；数量、文件名、位置和失败原因只能来自工具回执。"
    "表达沿用用户当前的风格偏好和咕咕人设：偏正式时克制准确，偏活泼时自然亲近，偏简短时收束，偏详细时补充必要上下文；不要套用固定口号，也不要把结果写成生硬的逐项统计表。"
)

# 核验查询完成后单独给一轮最终收束，避免模型在长工具历史末尾退回通用寒暄。
_FINALIZE_PROMPT = (
    "【内部最终收束】工具操作和结果核验已经完成。现在只生成给用户看的最终回复："
    "根据本轮用户原始请求、已执行的操作和最新核验结果，直接总结实际完成了什么；"
    "不要再次寒暄，不要说‘在呢’‘怎么了’‘收到’等泛化话，也不要提及工具、核验或内部提示。"
    "如果操作已成功，明确说明结果；如果有失败或未完成，说明具体原因。"
)

# 核实轮只给出"确认/没问题"、却没调用查询工具时，强制再追一轮查询（防止遗漏实际状态）
_VERIFY_FORCE_PROMPT = (
    "【内部核验 · 需要查询】你上一条只回复了\"确认/没问题\"，没有调用查询工具查证。"
    "请调用 `read_file`（改了文件正文）/ `get_project` / `list_*` 等查询工具，把刚改的东西查出来，"
    "对照确认：真生效、内容完整、**没把别的内容覆盖丢**（尤其 `edit_file` replace_all 容易冲掉其它段落）。"
    "查证是内部步骤，不要只回复“核对完成/复查完成”；最后按用户当前的正式/活泼、简短/详细偏好，"
    "自然说明实际做了什么、成功了什么，以及仍失败或未完成的部分。"
)

# 查询工具命名前缀：核实轮必须真调这类工具，不许凭印象说"确认了"。
# 思维笔记保留了 mind_get/mind_search 的历史命名，必须显式纳入，避免明明读回了
# 数据却被误判成没有观察，白白多跑复查回合。
_READ_PREFIXES = ("read_", "list_", "get_", "find_", "search_")
_READ_TOOL_NAMES = {"mind_get", "mind_search"}

# 特殊状态显示名默认值（非工具，无法从 registry 派生）。后台「状态命名」面板可覆盖：
#   _preparing      openai 流式收参数阶段的占位
#   _verify_prefix  复查轮工具标签前缀，后端拼到 label 前再下发
#   _thinking       「思考中」状态的文字（默认空＝显示三个点；填了才显示成文字气泡）
# 任一命名都可填多个（用 | 分隔），显示时随机取一个 —— 见 _pick_label。
SPECIAL_STATE_LABELS = {
    "_preparing":     "咕咕正在整理…",
    "_verify_prefix": "复查 · ",
    "_thinking":      "",
}


def _pick_label(raw: str) -> str:
    """命名值可含多个候选（| 或换行分隔）→ 随机取一个；单个/空原样返回。"""
    if not raw or ("|" not in raw and "\n" not in raw):
        return raw
    parts = [p.strip() for p in _re_mod.split(r"[|\n]", raw) if p.strip()]
    return random.choice(parts) if parts else raw

# 叙事/决策拒绝/意图播报守卫（跟 provider 无关，PRD-LLM-1 FR-LLM-3 搬到了 core_guards.py）：
from agent.security.core_guards import (
    _looks_like_narration, _NARRATION_NUDGE,
    _is_decision_dodge, _DECISION_NUDGE,
    _announces_intent, _INTENT_NUDGE,
    _could_be_tool_progress, _is_tool_progress_only, _TOOL_REQUIRED_NUDGE,
)


def _user_text(content) -> str:
    """从 user 消息 content 取纯文本（content 可能是 str，或带图时的 [{text}, {image}] 列表）。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


# 增删改工具的命名约定：写动词前缀。新功能的工具照此命名（create_/update_/delete_/...），
# 就自动纳入自我核实——这是「新功能直接适配复查」的关键，不用再来这里登记。
_WRITE_PREFIXES = (
    "create_", "update_", "delete_", "add_", "remove_", "edit_", "rename_",
    "move_", "copy_", "set_", "archive_", "restore_", "permanent_delete", "save_",
)


def _mutating_tools(tool_names) -> set:
    """本次可用工具里的「增删改」集合：① 命名约定（写动词前缀，自动覆盖新工具）
    ② 并上 RESOURCE_BY_TOOL 里人工登记的（双保险，防约定外的特例漏判）。"""
    from app.core.events import RESOURCE_BY_TOOL
    by_name = {n for n in tool_names if n.startswith(_WRITE_PREFIXES)}
    return by_name | set(RESOURCE_BY_TOOL)


def _is_successful_tool_result(result: str) -> bool:
    """失败的写调用没有状态可复查，不能为它额外等待一轮模型响应。"""
    try:
        payload = json.loads(result)
    except (TypeError, json.JSONDecodeError):
        return True
    return not isinstance(payload, dict) or not payload.get("error")


def _loaded_skill_slugs(messages) -> set[str]:
    """从 Skill 的结构化使用标记找出已经进入上下文的正文。

    不扫描正文、不做关键词匹配；只读取 provider history 中 role=tool 或 tool_result
    block 的 `_capability_usage` 标记。压缩后标记与正文一起消失，自然允许重新加载。
    """
    import json as _json

    loaded: set[str] = set()

    def read_result(value):
        if isinstance(value, str):
            try:
                value = _json.loads(value)
            except (TypeError, ValueError):
                return
        if not isinstance(value, dict):
            return
        marker = value.get("_capability_usage")
        if isinstance(marker, dict) and marker.get("kind") == "skill" and marker.get("loaded"):
            slug = marker.get("slug")
            if isinstance(slug, str) and slug:
                loaded.add(slug)

    for message in getattr(messages, "conversation", messages) or []:
        if not isinstance(message, dict):
            continue
        if message.get("role") == "tool":
            read_result(message.get("content"))
        for block in message.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                read_result(block.get("content"))
    return loaded


def _is_verify_placeholder(text: str) -> bool:
    """判断核验轮文本是否只是过程播报，而不是可以直接交付的结果摘要。"""
    normalized = _re_mod.sub(r"[\s，。！？、,.!?：:；;‘’“”\"'`~～…]+", "", text or "")
    if not normalized:
        return True
    process_phrases = (
        "确认一下", "核实一下", "检查一下", "看一下", "查一下",
        "正在核实", "正在检查", "正在确认", "已核实", "已确认",
        "核对完成", "复查完成", "都核实过了", "没问题",
    )
    return len(normalized) <= 16 and any(phrase in normalized for phrase in process_phrases)


def _replace_tool_result(messages, *, tool_call_id: str, result: dict) -> bool:
    """更新当前 Run 内存中的 pending tool result，供交互恢复后的下一轮使用。"""
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "tool" and str(message.get("tool_call_id") or "") == tool_call_id:
            message["content"] = json.dumps(result, ensure_ascii=False)
            return True
        blocks = message.get("content")
        if role != "user" or not isinstance(blocks, list):
            continue
        for block in blocks:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            block_id = str(block.get("tool_call_id") or block.get("tool_use_id") or "")
            if block_id == tool_call_id:
                block["content"] = json.dumps(result, ensure_ascii=False)
                return True
    return False


def _is_read_tool(name: str) -> bool:
    """返回该工具能否作为一次有效的状态观察。"""
    return name.startswith(_READ_PREFIXES) or name in _READ_TOOL_NAMES


async def _im_cancelled(session_id: int | None = None) -> bool:
    """检查 IM 与 Web 的生成取消标记。

    Web 生成脱离 HTTP 请求运行，不能依赖请求断开来取消；它通过 genstream 的
    session cancel key 在 round/token 边界协作停止。IM 仍保留原有取消来源。
    """
    from agent.im import imctx
    from agent.runtime import runtime_state as rt
    im = imctx.get_im()
    cancelled = False
    if im and im.get("puid"):
        await rt.refresh_activity(
            im["platform"], im.get("channel_id") or "", im.get("chat_id") or im["puid"], im["puid"]
        )
        cancelled = await rt.is_cancelled(
            im["platform"], im.get("channel_id") or "", im.get("chat_id") or im["puid"], im["puid"]
        )
    if cancelled:
        # 取消标志命中、即将掐断 loop：记录确认（puid 指纹脱敏），供排查「取消是否真的
        # 中断了生成」。只在真正命中时打，不会刷屏。
        from agent.security.logsafe import fingerprint
        from app.core.redaction import diag_log_raw
        diag_log_raw(
            "agent.core.im_cancelled_hit",
            f"platform={im['platform']} puid={fingerprint(im['puid'])}",
        )
    if cancelled or session_id is None:
        return cancelled
    return await genstream.is_cancelled(session_id)


async def _im_set_tool_state(tool_name: str) -> None:
    """据工具名打细粒度状态（web_search→SEARCHING、create_document→GENERATING），
    让网关「还在吗」答得更准。web 路无 imctx 时 no-op。"""
    from agent.im import imctx
    from agent.runtime import runtime_state as rt
    im = imctx.get_im()
    if not im or not im.get("puid"):
        return
    fine = rt.TOOL_STATE.get(tool_name)
    if fine:
        await rt.set_state(
            im["platform"], im.get("channel_id") or "", im.get("chat_id") or im["puid"],
            im["puid"], fine,
        )


class LLMRunner:
    """provider 无关的工具循环执行器。"""

    def __init__(self, tool_names: list[str], settings, capability_context=None):
        self.tool_names = tool_names
        self.settings = settings
        self.capability_context = capability_context
        # 状态显示名 = 特殊状态默认 ← 各工具 label ← 用户在后台「状态命名」面板的覆盖（热读）。
        # 未覆盖的 key 自动回退默认，所以「保留默认」天然成立。
        _ov = getattr(getattr(settings, "state_labels", None), "overrides", None) or {}
        self.labels = {**SPECIAL_STATE_LABELS, **registry.labels(), **{str(k): str(v) for k, v in _ov.items() if v}}

    def _label(self, name: str, default: str | None = None) -> str:
        """取状态显示名：命名含多个候选时随机取一（后端在发 tool_call 时调用）。"""
        return _pick_label(self.labels.get(name, name if default is None else default))

    def run(self, user_id, system_text: str, messages: list,
            use_anthropic: bool, model_cfg=None,
            session_id: int | None = None,
            session=None,
            on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None
            ) -> AsyncGenerator[str, None]:
        # model_cfg：pick_model 解析出的模型配置（预设或 settings.ai）；None 时退回 settings.ai
        ai = model_cfg if model_cfg is not None else self.settings.ai
        if (getattr(ai, "provider", "") or "").lower() == "ollama" and \
                getattr(ai, "ollama_api_mode", "native") == "native":
            return self._run_ollama(user_id, messages, ai, session_id=session_id,
                                    session=session,
                                    on_interaction=on_interaction)
        if use_anthropic:
            return self._run_anthropic(user_id, system_text, messages, ai, session_id=session_id,
                                       session=session,
                                       on_interaction=on_interaction)
        return self._run_openai(user_id, messages, ai, session_id=session_id,
                                session=session,
                                on_interaction=on_interaction)

    async def _run_ollama(self, user_id, messages: list, ai=None,
                          session_id: int | None = None,
                          session=None,
                          on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None
                          ) -> AsyncGenerator[str, None]:
        ai = ai if ai is not None else self.settings.ai
        async for line in self._run_loop(loop_drivers.OllamaDriver(), user_id, messages, ai,
                                          system_text=None, session_id=session_id,
                                          session=session,
                                          on_interaction=on_interaction):
            yield line

    # ── Anthropic（MiniMax / Anthropic）─────────────────────────────────────
    async def _run_anthropic(self, user_id, system_text: str,
                             messages: list, ai=None,
                             session_id: int | None = None,
                             session=None,
                             on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None
                             ) -> AsyncGenerator[str, None]:
        settings = self.settings
        ai = ai if ai is not None else settings.ai
        async for line in self._run_loop(loop_drivers.AnthropicDriver(), user_id, messages, ai,
                                          system_text=system_text, session_id=session_id,
                                          session=session,
                                          on_interaction=on_interaction):
            yield line

    # ── OpenAI ──────────────────────────────────────────────────────────────
    async def _run_openai(self, user_id, messages: list, ai=None,
                          session_id: int | None = None,
                          session=None,
                          on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None
                          ) -> AsyncGenerator[str, None]:
        settings = self.settings
        ai = ai if ai is not None else settings.ai
        async for line in self._run_loop(loop_drivers.OpenAIDriver(), user_id, messages, ai,
                                          system_text=None, session_id=session_id,
                                          session=session,
                                          on_interaction=on_interaction):
            yield line

    # ── 共享主循环（PRD-LLM-1 Phase 2）────────────────────────────────────────
    async def _run_loop(self, driver, user_id, messages: list, ai,
                         system_text: str | None,
                         session_id: int | None = None,
                         session=None,
                         on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None
                         ) -> AsyncGenerator[str, None]:
        """工具调用/核实阶段状态机/三条防幻觉守卫/空回复兜底/轮次上限——Anthropic 和
        OpenAI 两条格式共用同一份控制流，只在"怎么跑一轮/怎么把这轮结果写回历史"这几处
        调用 `driver`（`agent/loop_drivers.py` 的 `AnthropicDriver`/`OpenAIDriver`）。

        合并后有一处行为变化，如实记在这里、不是本次改动的目标而是自然结果：原来
        `_run_openai` 整段没有 try/except 包裹流式调用，一旦 SDK 抛异常会原样往外炸；
        `_run_anthropic` 一直有（靠 RetryableError/通用 Exception 两层兜底）。合并成
        一条共享循环后两边自然共用同一层兜底——OpenAI 路因此从"异常直接炸穿"变成
        "跟 Anthropic 路一样优雅降级成'咕咕开小差了'"，是明确的行为改善，不是意外。
        """
        # 这轮真正要跑的模型配置透传给工具层（见 agent/modelctx.py 文档）——工具判断
        # "当前模型支持什么"必须看这个，不能重新读静态的 get_settings().ai。
        from agent.llm import modelctx
        modelctx.set_model_cfg(ai)
        # 每轮对话只允许 inspect_images 对网络图片发起一次读取；历史附件不占用该额度。
        from agent.tools import search as search_tools
        search_tools.reset_image_inspection_budget()
        initial_tool_names = self.tool_names
        if self.capability_context is not None:
            initial_tool_names = list(self.capability_context.select_for_messages(messages).tool_names)
        client, ctx = driver.prepare(initial_tool_names, ai, messages, system_text)
        # 只把能力上下文挂到 provider request context，供 LoopScope 记录脱敏指标；
        # 不把目录或用户消息复制进 driver。
        if self.capability_context is not None:
            ctx.capability_context = self.capability_context
        loaded_skill_slugs = _loaded_skill_slugs(messages)
        # 当前用户消息是本轮 run 的保护边界。压缩时只处理它之前的历史，
        # 工具调用/结果追加后仍通过对象身份找到同一个起点。
        _run_conversation = getattr(messages, "conversation", messages)
        _run_start_message = _run_conversation[-1] if _run_conversation else None

        _mutset = _mutating_tools(self.tool_names)
        did_mutate = False; verify_count = 0; task_rounds = 0; verify_rounds = 0; empty_retry = 0
        any_tool_called = False; narration_retry = 0; decision_retry = 0; intent_retry = 0
        tool_intent_retry = 0   # “只说正在查询”或显式 requires_tools 未执行的守卫
        tool_calls_used = 0
        _request_conversation = getattr(messages, "conversation", messages)
        _user_req = _user_text(_request_conversation[-1]["content"]) if _request_conversation and _request_conversation[-1].get("role") == "user" else ""
        # 初始用户图片只需要首轮完整发送；首轮结束后折叠成稳定文本，避免下一轮和下一次
        # run 在同一历史位置分别出现 base64 与占位文本，导致 provider 从图片处断缓存。
        initial_volatile_indices = loop_drivers._volatile_message_indices(messages)
        # 自我核实阶段：一旦进入就持续到收尾（含其查证用的 get_* 轮）。期间模型文字先缓冲——
        # 干净通过则整段丢弃（不把"已核实…"那种重复确认刷给用户）；发现并补做了，才在补做那轮发一次说明。
        verify_mode = False; verify_fixed = False; verify_queried = False
        finalize_pending = False
        total_in = total_out = total_cache = 0
        compaction_attempts = 0
        hard_budget_retries = 0
        run_id = f"run-{uuid4().hex[:16]}"
        round_number = 0
        event_seq = 0

        def stream_event(event_type: str, **payload) -> str:
            """统一给兼容 SSE 事件补上可追踪身份；不写入用户正文或工具参数日志。"""
            nonlocal event_seq
            event_seq += 1
            return encode_event(
                event_type,
                run_id=run_id,
                seq=event_seq,
                **payload,
            )

        while True:
            # 核实轮拥有独立预算，但不能把 MAX_VERIFY 误加到普通任务轮次上。
            # 最后一轮额外留给模型输出核实后的收束文本。
            if verify_mode:
                if verify_rounds >= MAX_VERIFY_LLM_ROUNDS:
                    break
                verify_rounds += 1
            else:
                if task_rounds >= MAX_ROUNDS:
                    break
                task_rounds += 1
            # 用户中途「算了」→ 轮间协作中断（单次 LLM 流式调用本身切不了，故粒度是轮与轮之间）
            if await _im_cancelled(session_id):
                yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                return

            # 上下文压缩检测：先尝试 LLM 压缩，压缩无效或仍超安全预算时才截断。
            from agent.context import compaction, tokens
            from agent.context.budget import (
                effective_budget,
                enforce_message_budget,
                estimate_tool_schema_tokens,
            )
            context_tokens = getattr(ai, "context_tokens", 256000)
            overhead_tokens = (
                estimate_tool_schema_tokens(getattr(ctx, "tools", None))
            )
            if overhead_tokens >= int(context_tokens or 0):
                _log.error(
                    "[core] 工具 schema 已超过模型上下文上限：schema_tokens=%s context_tokens=%s",
                    overhead_tokens, context_tokens,
                )
                yield f"data: {json.dumps({'type': 'error', 'detail': '当前工具配置已超过模型处理上限，请减少启用的工具后再试～'}, ensure_ascii=False)}\n\n"
                return
            current_length = await compaction.estimate_context_length(messages, system_text)
            safe_budget = effective_budget(context_tokens, reserved_tokens=overhead_tokens)
            if current_length > safe_budget and compaction_attempts < 1:
                # 压缩摘要本身也是一次 LLM 调用。先检查取消，避免用户发「/stop」后
                # 仍开始下一次摘要请求。
                if await _im_cancelled(session_id):
                    yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                    return
                if compaction_attempts >= 1:
                    _log.error(
                        "[core] 上下文压缩后仍超过预算，停止重复压缩：before=%s attempts=%s",
                        current_length, compaction_attempts,
                    )
                    yield f"data: {json.dumps({'type': 'error', 'detail': '这次内容太多了，压缩后仍然超过处理上限，请拆成几条消息再试试～'}, ensure_ascii=False)}\n\n"
                    return
                yield f"data: {json.dumps({'type': 'compaction', 'detail': '上下文压缩中...'})}\n\n"
                _current_conversation = getattr(messages, "conversation", messages)
                _protected_from = next(
                    (index for index, item in enumerate(_current_conversation)
                     if item is _run_start_message),
                    max(0, len(_current_conversation) - 1),
                )
                compacted_messages, compacted = await compaction.compact_context(
                    list(getattr(messages, "conversation", messages)), system_text, context_tokens,
                    session_id=session_id, user_id=user_id,
                    fixed_prefix_size=getattr(messages, "fixed_prefix_size", 0),
                    overhead_tokens=overhead_tokens,
                    protected_from=_protected_from,
                )
                if await _im_cancelled(session_id):
                    yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                    return
                if hasattr(messages, "replace_conversation"):
                    messages.replace_conversation(compacted_messages)
                else:
                    messages = compacted_messages
                if compacted:
                    compacted_length = await compaction.estimate_context_length(messages, system_text)
                    compaction_attempts += 1
                    if compacted_length >= current_length:
                        _log.error(
                            "[core] 上下文压缩没有取得进展，转入确定性截断：before=%s after=%s",
                            current_length, compacted_length,
                        )
                    elif compacted_length > safe_budget:
                        _log.error(
                            "[core] 上下文压缩后仍超过预算，转入确定性截断：before=%s after=%s",
                            current_length, compacted_length,
                        )
                    else:
                        _log.info("[core] 上下文已压缩，重试当前 round")
                        if verify_mode:
                            verify_rounds -= 1
                        else:
                            task_rounds -= 1
                        continue

            # LLM 压缩没有执行或没有把上下文压到安全预算后，才做本地确定性截断。
            if current_length > safe_budget:
                _current_conversation = getattr(messages, "conversation", messages)
                _protected_from = next(
                    (index for index, item in enumerate(_current_conversation)
                     if item is _run_start_message),
                    max(0, len(_current_conversation) - 1),
                )
                hard_result = enforce_message_budget(
                    messages, system_text or "", context_tokens,
                    overhead_tokens=overhead_tokens,
                    protected_from=_protected_from,
                )
                if hard_result.changed:
                    current_length = await compaction.estimate_context_length(messages, system_text)
                    _log.warning(
                        "[core] 上下文预检超预算，执行确定性截断：before=%s after=%s dropped=%s",
                        hard_result.before_tokens, hard_result.after_tokens,
                        hard_result.dropped_messages,
                    )
                if current_length > safe_budget:
                    yield f"data: {json.dumps({'type': 'error', 'detail': '这次内容太多了，已无法在当前模型上处理，请拆成几条消息再试试～'}, ensure_ascii=False)}\n\n"
                    return

            _tok = 0
            result = None
            round_number += 1
            round_id = f"round-{round_number}"
            yield stream_event("round_start", round_id=round_id)
            _verify_buf = []   # 核实轮缓冲区：先攒着，回合结束按"有没有补做"决定 flush 还是丢弃
            _progress_buf: list[str] = []
            _progress_pending = False
            try:
                # 每次 provider 请求前刷新 selected tools。工具调用/结果仍由下方现有
                # append_tool_round 写入 history；这里仅更新原生 tools 参数。
                if self.capability_context is not None and not getattr(self.capability_context, "fixed_adapter", False):
                    selected = self.capability_context.select_for_messages(messages)
                    driver.update_tools(ctx, list(selected.tool_names))
                _round_gen = driver.run_round(client, ctx, messages)
                async for _kind, _val in _round_gen:
                    if _kind == "done":
                        result = _val
                        break
                    if verify_mode:
                        _verify_buf.append(_val)   # 核实阶段文字不实时发，先缓冲
                    else:
                        # 对可能是“正在查询”占位话术的前缀暂存到 round 结束；如果后续
                        # 变成正常句子则原样 flush，只有确认是纯占位且无 tool call 时丢弃。
                        if _progress_pending:
                            candidate = "".join(_progress_buf) + _val
                            if _could_be_tool_progress(candidate):
                                _progress_buf.append(_val)
                            else:
                                for _pending in _progress_buf:
                                    yield f"data: {json.dumps({'type': 'token', 'content': _pending})}\n\n"
                                _progress_buf.clear()
                                _progress_pending = False
                                yield f"data: {json.dumps({'type': 'token', 'content': _val})}\n\n"
                        elif _could_be_tool_progress(_val):
                            _progress_pending = True
                            _progress_buf.append(_val)
                        else:
                            yield f"data: {json.dumps({'type': 'token', 'content': _val})}\n\n"
                    # 流式途中也协作检查取消：单轮长回答没有「下一轮」，只能在这里掐断；
                    # 退出生成器会关闭 stream、断开上游请求，真正停掉生成（不是只丢弃后续 token）
                    _tok += 1
                    if _tok % _CANCEL_CHECK_EVERY == 0 and await _im_cancelled(session_id):
                        yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                        # 显式关掉 run_round 生成器：Python 3.14 下 async for 提前退出时
                        # close 会被推迟到 GC，LoopScope 的 span 会一直挂着 running。
                        # aclose() 立即注入 GeneratorExit，hooks.traced_round 同步把
                        # span 标成 cancelled，不用等 GC 才收尾。
                        await _round_gen.aclose()
                        return
            except RetryableError as e:
                from agent.context.budget import enforce_message_budget, is_context_overflow_error
                overflow = is_context_overflow_error(e) or is_context_overflow_error(e.cause) if e.cause else is_context_overflow_error(e)
                if overflow and hard_budget_retries < 1:
                    hard_result = enforce_message_budget(
                        messages, system_text or "", getattr(ai, "context_tokens", 256000),
                        overhead_tokens=(
                            estimate_tool_schema_tokens(getattr(ctx, "tools", None))
                        ),
                        protected_from=next(
                            (index for index, item in enumerate(getattr(messages, "conversation", messages))
                             if item is _run_start_message),
                            max(0, len(getattr(messages, "conversation", messages)) - 1),
                        ),
                    )
                    if hard_result.changed:
                        hard_budget_retries += 1
                        if verify_mode:
                            verify_rounds -= 1
                        else:
                            task_rounds -= 1
                        _log.warning("[core] provider 返回上下文超量，执行一次确定性截断重试")
                        continue
                # _stream_round 已经把原始异常记进受限诊断出口、也记过 WARNING 了，这里不重复记；
                # 只根据 cause 类型挑一句降级文案给用户。
                import anthropic
                busy = isinstance(e.cause, getattr(anthropic, "RateLimitError", ()))
                detail = "咕咕这会儿有点忙（接口繁忙），过几秒再发一次试试 🙏" if busy else "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
                yield f"data: {json.dumps({'type': 'error', 'detail': detail}, ensure_ascii=False)}\n\n"
                return
            except Exception as e:
                from agent.context.budget import enforce_message_budget, is_context_overflow_error
                if is_context_overflow_error(e) and hard_budget_retries < 1:
                    hard_result = enforce_message_budget(
                        messages, system_text or "", getattr(ai, "context_tokens", 256000),
                        overhead_tokens=(
                            estimate_tool_schema_tokens(getattr(ctx, "tools", None))
                        ),
                        protected_from=next(
                            (index for index, item in enumerate(getattr(messages, "conversation", messages))
                             if item is _run_start_message),
                            max(0, len(getattr(messages, "conversation", messages)) - 1),
                        ),
                    )
                    if hard_result.changed:
                        hard_budget_retries += 1
                        if verify_mode:
                            verify_rounds -= 1
                        else:
                            task_rounds -= 1
                        _log.warning("[core] provider 返回上下文超量，执行一次确定性截断重试")
                        continue
                # 已吐过 token 中途出错（emitted 就原样抛的路径）或其他未预期异常——按未知处理：
                # 原始进受限诊断出口，可见日志只留类型名，不带原始 str(e)。
                # where 里带上 provider + api_format——2026-07-14 那次 MiniMax AttributeError
                # 故障排查时，diag_log 没记 provider，只能靠静态代码分析猜是哪家（PRD-LLM-1
                # 「待确认问题」），这次直接把它写进日志，下次同类问题一眼就能看出是哪个 provider。
                diag_log(f"agent.core.main_loop provider={getattr(ai, 'provider', '') or 'unknown'} "
                         f"format={driver.api_format}", e)
                _log.error("LLM 调用中途出错：%s", type(e).__name__)
                detail = "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
                yield f"data: {json.dumps({'type': 'error', 'detail': detail}, ensure_ascii=False)}\n\n"
                return

            total_in  += result.usage_in
            total_out += result.usage_out
            total_cache += result.cache_tokens

            _requires_tools = result.requires_tools
            if _requires_tools is None:
                _requires_tools = bool(result.tool_calls)

            if initial_volatile_indices:
                loop_drivers._collapse_volatile_messages(messages, initial_volatile_indices)
                initial_volatile_indices = set()

            if result.tool_calls:
                if _progress_pending:
                    for _pending in _progress_buf:
                        yield f"data: {json.dumps({'type': 'token', 'content': _pending})}\n\n"
                    _progress_buf.clear()
                    _progress_pending = False
                any_tool_called = True   # 本轮真调了工具 → narration 兜底不触发
                # 核实阶段首次补做（本轮调了增删改）→ 把"发现漏了X，补一下"说明发一次；之后的核对文字仍静默
                if verify_mode and not verify_fixed and _verify_buf and any(
                    (str((tc.input or {}).get("name") or "").strip()
                     if tc.name == "call_tool" and isinstance(tc.input, dict) else tc.name) in _mutset
                    for tc in result.tool_calls
                ):
                    async for _line in genstream.typed_stream(''.join(_verify_buf)):   # 逐字流式，与正常回复一致
                        yield _line
                dispatched = []
                pending_interaction = None
                remaining_tool_calls = max(0, MAX_TOOL_CALLS - tool_calls_used)
                tool_budget_exceeded = len(result.tool_calls) > remaining_tool_calls
                for call_index, tc in enumerate(result.tool_calls):
                    adapter_target = None
                    if tc.name == "call_tool" and isinstance(tc.input, dict):
                        adapter_target = str(tc.input.get("name") or "").strip() or None
                    effective_tool_name = adapter_target or tc.name
                    label = self._label(effective_tool_name)
                    if verify_mode:   # 复查前缀后端拼接（可在「状态命名」面板改 _verify_prefix；支持多候选随机）
                        label = self._label("_verify_prefix", "复查 · ") + label
                    if call_index >= remaining_tool_calls:
                        # 仍然为 provider 的每个 tool call 补一个结果，避免留下孤儿 tool_call；
                        # 但不再执行真实工具，随后直接结束本轮，防止模型继续扩张搜索。
                        tool_call_id = getattr(tc, "id", None) or f"{round_id}-tool-{call_index + 1}"
                        yield stream_event("tool_call", round_id=round_id, tool_call_id=tool_call_id,
                                           name=effective_tool_name, label=label, input=tc.input, verify=verify_mode,
                                           status="skipped")
                        yield stream_event("tool_done", round_id=round_id, tool_call_id=tool_call_id,
                                           name=effective_tool_name, label=label, verify=verify_mode,
                                           status="skipped", result=_TOOL_BUDGET_EXHAUSTED)
                        dispatched.append((tc, _TOOL_BUDGET_EXHAUSTED))
                        continue
                    tool_calls_used += 1
                    if tc.parse_error:
                        # OpenAI 路专属：工具参数 JSON 被截断解析失败——别拿空参跑，改回一条错误
                        # tool_result 让模型精简参数后重发；不真 dispatch、不置 did_mutate。
                        tool_call_id = getattr(tc, "id", None) or f"{round_id}-tool-{call_index + 1}"
                        yield stream_event("tool_call", round_id=round_id, tool_call_id=tool_call_id,
                                           name=effective_tool_name, label=label, input={}, verify=verify_mode,
                                           status="invalid")
                        yield stream_event("tool_done", round_id=round_id, tool_call_id=tool_call_id,
                                           name=effective_tool_name, label=label, verify=verify_mode,
                                           status="error", result=loop_drivers.TOOL_ARGS_TRUNCATED_ERROR)
                        dispatched.append((tc, loop_drivers.TOOL_ARGS_TRUNCATED_ERROR))
                        continue
                    await _im_set_tool_state(effective_tool_name)
                    # 自检轮工具照常显示，但打 verify 标记：前端凭 verify 收尾不冒「生成中」点点（否则回复完还在转、像卡住）
                    tool_call_id = getattr(tc, "id", None) or f"{round_id}-tool-{call_index + 1}"
                    yield stream_event("tool_call", round_id=round_id, tool_call_id=tool_call_id,
                                       name=effective_tool_name, label=label, input=tc.input, verify=verify_mode,
                                       status="running")
                    # Skill 正文第一次通过 use_skill 进入 history 后，后续轮次直接复用；
                    # 只有 history 已被压缩/截断时，才会再次真正加载正文。
                    skill_slug = None
                    if tc.name == "use_skill":
                        from agent.skills import resolve_skill_slug
                        skill_slug = resolve_skill_slug(str((tc.input or {}).get("name") or ""))
                    if skill_slug and skill_slug in loaded_skill_slugs:
                        res = json.dumps({
                            "skill": skill_slug,
                            "already_loaded": True,
                            "message": "该技能正文已在当前上下文中，无需重复加载。",
                        }, ensure_ascii=False)
                        artifact = None
                    else:
                        if adapter_target is not None:
                            from agent.tools.base import set_dispatch_session, reset_dispatch_session
                            _dispatch_token = set_dispatch_session(session_id, session)
                            try:
                                res, artifact = await registry.dispatch(
                                    user_id, adapter_target, _resolve_adapter_arguments(tc.input)
                                )
                            finally:
                                reset_dispatch_session(_dispatch_token)
                        else:
                            from agent.tools.base import set_dispatch_session, reset_dispatch_session
                            _dispatch_token = set_dispatch_session(session_id, session)
                            try:
                                res, artifact = await registry.dispatch(user_id, tc.name, tc.input)
                            finally:
                                reset_dispatch_session(_dispatch_token)
                        if skill_slug and _is_successful_tool_result(res):
                            loaded_skill_slugs.add(skill_slug)
                    if tc.name == "ask_user":
                        # ask_user 是唯一会把当前 Run 挂起的普通工具：先把工具往返写进
                        # provider history，等待回答后由 interaction service 替换 pending
                        # result，再从同一 session 继续，而不是把按钮文案伪装成新用户消息。
                        import json as _json
                        try:
                            ask_payload = _json.loads(res) if isinstance(res, str) else res
                        except (TypeError, ValueError):
                            ask_payload = None
                        from app.services.interactions import create_agent_prompt
                        interaction = None
                        if isinstance(ask_payload, dict) and ask_payload.get("_interaction") == "ask_user":
                            interaction = await create_agent_prompt(
                                user_id=user_id,
                                session_id=session_id,
                                tool_call_id=tool_call_id,
                                tool_name=effective_tool_name,
                                payload=ask_payload,
                            )
                        if interaction is not None:
                            prompt, actions = interaction
                            pending_result = _json.dumps({
                                "status": "waiting_input",
                                "prompt_id": prompt.id,
                            }, ensure_ascii=False)
                            dispatched.append((tc, pending_result))
                            pending_interaction = (prompt.id, tool_call_id)
                            yield stream_event("tool_done", round_id=round_id,
                                               tool_call_id=tool_call_id, name=effective_tool_name, label=label,
                                               verify=verify_mode, status="waiting", result=pending_result)
                            yield stream_event(
                                "interaction_required", round_id=round_id,
                                tool_call_id=tool_call_id, prompt_id=prompt.id,
                                kind=prompt.kind, title=prompt.title, body=prompt.body,
                                options=actions, allow_text_input=bool(
                                    (prompt.schema_json or {}).get("allow_text_input", False)
                                ), expires_at=prompt.expires_at.isoformat(),
                            )
                            if on_interaction is not None:
                                await on_interaction({
                                    "prompt_id": prompt.id,
                                    "kind": prompt.kind,
                                    "title": prompt.title,
                                    "body": prompt.body,
                                    "options": actions,
                                    "allow_text_input": bool(
                                        (prompt.schema_json or {}).get("allow_text_input", False)
                                    ),
                                    "expires_at": prompt.expires_at.isoformat(),
                                    "round_id": round_id,
                                    "tool_call_id": tool_call_id,
                                })
                            break
                    # 统一交互桥：保留工具原有确认门，同时向 Guguchat/Web 发出按钮事件。
                    # 桥接失败不能影响工具结果写回模型，因此只在成功创建时发送事件。
                    from app.services.interactions import create_tool_confirmation
                    interaction = await create_tool_confirmation(
                        user_id=user_id, session_id=session_id, tool_name=effective_tool_name,
                        tool_call_id=tool_call_id, result=res,
                    )
                    if interaction:
                        pending_interaction = (interaction["prompt_id"], tool_call_id)
                        dispatched.append((tc, res))
                        yield stream_event("interaction_required", round_id=round_id,
                                           tool_call_id=tool_call_id, **interaction)
                        if on_interaction is not None:
                            await on_interaction({
                                **interaction,
                                "round_id": round_id,
                                "tool_call_id": tool_call_id,
                            })
                        yield stream_event("tool_done", round_id=round_id,
                                           tool_call_id=tool_call_id, name=effective_tool_name, label=label,
                                           verify=verify_mode, status="waiting", result=res)
                        break
                    if effective_tool_name in _mutset and _is_successful_tool_result(res):
                        did_mutate = True   # 本次成功做过增删改 → 立刻强制自我核实
                        if verify_mode:
                            verify_fixed = True   # 核实阶段里补了东西 → 确有遗漏
                    elif verify_mode and _is_read_tool(effective_tool_name):
                        verify_queried = True   # 核实阶段真的用查询工具查证了（不是嘴上确认）
                    yield stream_event("tool_done", round_id=round_id, tool_call_id=tool_call_id,
                                       name=effective_tool_name, label=label, verify=verify_mode,
                                       status="success" if _is_successful_tool_result(res) else "error",
                                       result=res)
                    if artifact:
                        yield f"data: {json.dumps({'type': 'file', 'file': artifact}, ensure_ascii=False)}\n\n"
                    dispatched.append((tc, res))
                driver.append_tool_round(messages, result, dispatched)
                if getattr(self.capability_context, "fixed_adapter", False):
                    from agent.context.canonical_tool_history import (
                        SkillSchemaEvent, append_event, tool_schema_event,
                    )
                    for tc, _res in dispatched:
                        if tc.name == "use_skill":
                            skill_name = str((tc.input or {}).get("name") or "").strip()
                            resolved_skill = None
                            from agent.skills import resolve_skill_slug
                            resolved_skill = resolve_skill_slug(skill_name) or skill_name
                            skill_meta = getattr(self.capability_context, "snapshot", None)
                            skill_meta = getattr(skill_meta, "skills", {}).get(resolved_skill)
                            related = tuple(getattr(skill_meta, "related_tools", ()) or ())
                            if related:
                                append_event(messages, SkillSchemaEvent(skill_name, related))
                                for name in related:
                                    tool = registry.get(name)
                                    if tool is not None:
                                        append_event(messages, tool_schema_event(tool))
                            continue
                        target_name = None
                        if tc.name == "call_tool" and isinstance(tc.input, dict):
                            target_name = str(tc.input.get("name") or "").strip() or None
                        if target_name:
                            tool = registry.get(target_name)
                            if tool is not None:
                                append_event(messages, tool_schema_event(tool))
                if pending_interaction is not None:
                    from app.services.interactions import wait_for_resolution
                    prompt_id, pending_tool_call_id = pending_interaction
                    answer = await wait_for_resolution(
                        user_id=user_id, prompt_id=prompt_id,
                        heartbeat=lambda: genstream.touch(session_id),
                    )
                    if answer is None:
                        yield f"data: {json.dumps({'type': 'error', 'detail': '这次交互已过期，请重新告诉我你的选择。'}, ensure_ascii=False)}\n\n"
                        return
                    _replace_tool_result(
                        messages,
                        tool_call_id=pending_tool_call_id,
                        result=answer,
                    )
                    yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                    continue
                if tool_budget_exceeded:
                    _log.warning("[core] 工具调用达到 run 上限：used=%s limit=%s", tool_calls_used, MAX_TOOL_CALLS)
                    yield f"data: {json.dumps({'type': 'error', 'detail': '这次查询步骤有点多，咕咕先停在这里了；前面已经获得的结果仍然有效。'}, ensure_ascii=False)}\n\n"
                    return
                # 工具结果已经入历史，直接接复查 prompt。旧流程会先多请求一次模型来生成
                # "已完成"，随后才开始复查；这轮没有新信息，只会徒增一次等待。
                if did_mutate and verify_count < MAX_VERIFY:
                    verify_count += 1
                    did_mutate = False
                    verify_mode = True
                    verify_queried = False
                    messages.append({"role": "user", "content": _VERIFY_PROMPT})
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue

            # 自我核实：① 理论上工具结果后会立即注入核实 prompt；这里保留为轮次封顶等
            # 边界状态的兜底；② 已进核实阶段却只嘴上确认、没真调过查询工具（verify_queried=False）→ 强制再追一轮真查。
            # 都受 MAX_VERIFY 封顶防死循环。补做会再置 did_mutate → 触发下一轮核实。
            _need_verify = did_mutate and verify_count < MAX_VERIFY
            _need_force  = verify_mode and not verify_queried and not did_mutate and verify_count < MAX_VERIFY
            if _need_verify or _need_force:
                verify_count += 1
                did_mutate = False
                verify_mode = True   # 进入/保持核实阶段 → 之后文字先缓冲
                driver.append_followup(messages, result, _VERIFY_FORCE_PROMPT if _need_force else _VERIFY_PROMPT)
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue

            # 核验提示已经要求模型在查询后直接总结；如果当前轮已经给出可交付的结果，
            # 不再重复发一轮最终收束请求。只有“我确认一下/已核实”这类过程播报才需要
            # 追加收束轮，避免它被直接展示给用户。
            if (verify_mode and verify_queried and not finalize_pending
                    and _is_verify_placeholder("".join(_verify_buf))):
                finalize_pending = True
                driver.append_followup(messages, result, _FINALIZE_PROMPT)
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue

            # 核实阶段结束：不再需要补做/强查 → 把缓冲的核实文字发给用户，退出核实模式。
            if verify_mode and _verify_buf:
                async for _line in genstream.typed_stream(''.join(_verify_buf)):
                    yield _line
            verify_mode = False
            _verify_buf = []

            _final_text = result.text
            # 只有在确认是正常回复时才把此前暂存的进度片段发给前端；纯占位输出会被
            # 丢弃并重试，避免用户看到“正在查询”后流程已经结束。
            if _progress_pending and not _is_tool_progress_only(_final_text):
                for _pending in _progress_buf:
                    yield f"data: {json.dumps({'type': 'token', 'content': _pending})}\n\n"
                _progress_buf.clear()
                _progress_pending = False
            # 空回复兜底：整轮无正文、没动工具、不在核实阶段 → 先追一轮要正文，仍空给句得体兜底。
            if not _final_text.strip() and not did_mutate and not verify_mode:
                if empty_retry < 1:
                    empty_retry += 1
                    driver.append_empty_retry(messages, result)
                    yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                    continue
                fb = "嗯…我这下没太接住，你再说一遍、或者换个说法，我马上跟上～"
                async for _line in genstream.typed_stream(fb):   # 空回复兜底也走逐字流式
                    yield _line
                _final_text = fb
            # narration 兜底：整段生成一个工具都没真调，但文字在"假装"读/改文件 → 追一轮逼它真调。
            # 只追一次；核实阶段不算（那是另一套）。
            if (not any_tool_called and not verify_mode and narration_retry < 1
                    and _looks_like_narration(_final_text)):
                narration_retry += 1
                driver.append_followup(messages, result, _NARRATION_NUDGE)
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # 意图守卫（B）：宣告「我这就去查/建/改…」却本轮零工具 → 逼它当场做（_announces_intent 已排除问句/征询）。只追一次。
            if (not any_tool_called and not verify_mode and intent_retry < 1
                    and _announces_intent(_final_text)):
                intent_retry += 1
                driver.append_followup(messages, result, _INTENT_NUDGE)
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # 若 provider 将显式决策放进 RoundResult，或模型只返回纯进度占位话术，
            # 本轮都不能作为最终回复结束。当前内置驱动的 requires_tools 由 tool_calls
            # 推导，保留该分支供支持显式决策的 provider 适配器使用。
            if (not any_tool_called and not verify_mode and tool_intent_retry < 1
                    and (_requires_tools is True or _is_tool_progress_only(_final_text))):
                tool_intent_retry += 1
                driver.append_followup(messages, result, _TOOL_REQUIRED_NUDGE)
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # P3 决策守卫：用户明确要改、模型零工具却用「不用改/已合理」驳回 → 逼它执行或问清，别擅自不做。
            if (not any_tool_called and not verify_mode and decision_retry < 1
                    and _is_decision_dodge(_user_req, _final_text)):
                decision_retry += 1
                driver.append_followup(messages, result, _DECISION_NUDGE)
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # 即时复查时，前面还没有生成过最终说明；保留最终收束轮的确认给用户，
            # 复查过程中的文字仍然一直缓冲、不显示。
            if verify_mode and verify_queried and _final_text.strip():
                async for _line in genstream.typed_stream(_final_text):
                    yield _line

            yield f"data: {json.dumps({'type': '_usage', 'input': total_in, 'output': total_out, 'cache_read': total_cache})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'error', 'detail': '这步操作有点多，咕咕没在一口气里全做完，前面几步已经生效了，要我接着把剩下的做完吗？'}, ensure_ascii=False)}\n\n"
