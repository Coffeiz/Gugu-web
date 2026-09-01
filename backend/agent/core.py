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
from datetime import datetime, timezone
from uuid import uuid4
from typing import Any, AsyncGenerator, Awaitable, Callable

from agent.llm import genstream
from agent import loop_drivers
from agent.tools import registry
from app.core.errors import RetryableError
from app.core.redaction import diag_log
from app.core.tz import now_utc
from agent.interactions.stream_events import encode_event
from agent.tools.tool_contract import invalid_tool_call_payload, normalize_tool_name

_log = logging.getLogger("agent.core")

# ⑦ 慢尾兜底：LLM 瞬时错误（限流 429 / 超时 / 网络 / 5xx）退避重试——贴着并发上限跑时
# 把偶发 429 吸收成短延迟、不丢消息。只在「本轮还没吐 token 前」重试（已吐过再重试会重复输出）。
_RETRY_BACKOFF = [1, 2, 4]   # 退避秒数；最多重试 3 次


def _provider_context_usage(driver: Any, result: Any) -> int:
    """返回用于上下文阈值判断的完整 provider 输入量。

    Anthropic 兼容接口把缓存命中单独放在 ``cache_tokens``，而
    ``usage_in`` 只包含 fresh input；OpenAI 兼容接口的 ``usage_in`` 已经
    包含缓存命中，不能再次相加。
    """
    usage_in = max(0, int(getattr(result, "usage_in", 0) or 0))
    if getattr(driver, "api_format", "") == "anthropic":
        usage_in += max(0, int(getattr(result, "cache_tokens", 0) or 0))
    return usage_in


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


def _inject_pending_confirmation(tool_input: Any, adapter_target: str | None,
                                 confirmation: dict[str, Any] | None) -> tuple[Any, bool]:
    """把刚确认的凭证续接到同名工具的一次调用中。

    返回 ``(参数, 是否消费凭证)``。确认续接集中在这里，避免 direct tool 与
    ``call_tool`` 两条 dispatch 分支各自维护一套容易漂移的安全判断。
    """
    if not confirmation or not confirmation.get("confirm_token"):
        return tool_input, False

    original = _resolve_adapter_arguments(tool_input) if adapter_target else tool_input
    if not isinstance(original, dict):
        return tool_input, False
    confirm_value = original.get("confirm")
    explicitly_denied = isinstance(confirm_value, str) and confirm_value.strip().lower() in {"false", "0", "no"}
    if explicitly_denied or original.get("confirm_token"):
        return tool_input, True

    merged = {**original, "confirm": True, "confirm_token": confirmation["confirm_token"]}
    if adapter_target:
        if isinstance(tool_input, dict) and isinstance(tool_input.get("arguments"), dict):
            return {**tool_input, "arguments": merged}, True
        return {"name": adapter_target, **merged}, True
    return merged, True


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
MAX_ROUNDS = 30
_GOAL_DONE_MARKER = "<!-- GUGU_GOAL_DONE -->"
_GOAL_POLICY = (
    "\n\n[内部目标任务规则] 当前会话处于目标任务模式。"
    "除非用户主动暂停或取消，不要因为完成一个子任务就结束整个目标。"
    "只有确认用户声明的完整目标已经完成时，才在最终答复末尾单独输出 "
    f"{_GOAL_DONE_MARKER}；未完成时不要输出该标记，并继续推进剩余工作。"
    "不要向用户解释这个内部标记。"
)
# 一个 run 内模型实际请求的工具调用总数。工具自身仍可有更细的专用额度。
MAX_TOOL_CALLS = 10
_CANCEL_CHECK_EVERY = 24   # 流式途中每 N 个 token 协作检查一次取消（单轮长回答只能在这里掐断）

# ── 自我核实：成功做了增删改后，立刻跑一轮核实（用查询工具查证真生效/完整），
# 没做成/不完整就补做；最多 MAX_VERIFY 轮（每次对话回合计，非整 session），避免仅凭操作回执遗漏部分结果。
MAX_VERIFY = 5
# 最后一轮核实允许模型在完成最后一次查询后输出收束文本。
MAX_VERIFY_LLM_ROUNDS = MAX_VERIFY + 1
_TOOL_BUDGET_EXHAUSTED = "工具调用额度已用完。请不要再调用工具，直接根据已经获得的结果回复用户。"
_TOOL_BUDGET_STOP_PROMPT = (
    "用户选择不继续执行超出工具额度的请求。请不要再调用工具，"
    "直接根据已经获得的结果，清楚说明已完成内容和未执行内容。"
)


def _goal_mode_enabled(session: Any) -> bool:
    """读取会话级长任务标记；缺失或旧数据一律按普通模式处理。"""
    context = getattr(session, "session_context", None)
    return (
        isinstance(context, dict)
        and bool(str(context.get("goal_text") or "").strip())
        and context.get("goal_status", "active") != "paused"
        and bool(context.get("goal_mode", False))
    )


def _unlimited_mode_enabled(session: Any) -> bool:
    """读取仅解除单次工具调用上限的会话标记，不进入目标任务循环。"""
    context = getattr(session, "session_context", None)
    if not isinstance(context, dict):
        return False
    until = context.get("tool_budget_unlimited_until")
    if isinstance(until, str):
        try:
            expires_at = datetime.fromisoformat(until.replace("Z", "+00:00"))
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if expires_at > now_utc():
                return True
        except ValueError:
            pass
    # 兼容旧版本把 /unlimited 错写进 goal_mode 的状态，但只在没有目标正文时视为旧无限模式。
    return bool(context.get("unlimited_mode") or (context.get("goal_mode") and not context.get("goal_text")))


def _goal_completed(text: str) -> bool:
    """只接受模型显式完成标记，避免把子任务完成误判成整个目标完成。"""
    return _GOAL_DONE_MARKER in (text or "")


def _strip_goal_marker(text: str) -> str:
    """移除仅供 Runner 判定的完成标记，不让它进入用户可见回复。"""
    return (text or "").replace(_GOAL_DONE_MARKER, "").rstrip()
_VERIFY_PROMPT = (
    "【内部核验 · 请执行】你刚才执行了增删改操作。现在用对应的查询工具检查结果是否生效且完整："
    "查询工具一般是 `list_*` / `get_*` / `read_*`（建项目用 `get_project` 看阶段待办、定时任务用 `list_scheduled_tasks` 看 cron/内容……照此类推）。"
    "**尤其改了文件正文（`edit_file`/`create_document`）：必须用 `read_file` 把内容读回来逐字比对；按行编辑还要确认目标行已更新/删除且其它行未被移动或覆盖——`list_files` 只能看文件在不在，光看那个不算核实。**"
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
    "对照确认：真生效、内容完整、**没把别的内容覆盖丢**（尤其 `edit_file` 的整篇 `target_lines=all` 容易冲掉其它段落）。"
    "查证是内部步骤，不要只回复“核对完成/复查完成”；最后按用户当前的正式/活泼、简短/详细偏好，"
    "自然说明实际做了什么、成功了什么，以及仍失败或未完成的部分。"
)

# 查询工具命名前缀：核实轮必须真调这类工具，不许凭印象说"确认了"。
# 思维笔记的只读工具不带通用 read_/search_ 前缀，必须显式纳入，避免明明读回了
# 数据却被误判成没有观察，白白多跑复查回合。
_READ_PREFIXES = ("read_", "list_", "get_", "find_", "search_")
_READ_TOOL_NAMES = {"note_get", "note_search"}

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


def _loaded_skill_slugs(messages) -> dict[str, str]:
    """从 Skill 的结构化使用标记找出已经进入上下文的正文。

    不扫描正文、不做关键词匹配；只读取 provider history 中 role=tool 或 tool_result
    block 的 `_capability_usage` 标记和正文指纹。旧版没有指纹的标记视为过期。
    """
    import json as _json

    loaded: dict[str, str] = {}

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
            digest = marker.get("content_digest")
            if isinstance(slug, str) and slug and isinstance(digest, str) and digest:
                loaded[slug] = digest

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
        generation = self._run_provider(
            user_id, system_text, messages, use_anthropic=use_anthropic,
            model_cfg=ai, session_id=session_id, session=session,
            on_interaction=on_interaction,
        )
        return self._recover_interrupted_continuation(
            generation, user_id, system_text, messages,
            use_anthropic=use_anthropic, model_cfg=ai,
            session_id=session_id, session=session,
        )

    def _run_provider(
        self, user_id, system_text: str | None, messages: list, *,
        use_anthropic: bool, model_cfg, session_id: int | None, session=None,
        on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> AsyncGenerator[str, None]:
        """启动一条未包装的 provider 流，续轮恢复只能调用这里。"""
        ai = model_cfg if model_cfg is not None else self.settings.ai
        if (getattr(ai, "provider", "") or "").lower() == "ollama" and \
                getattr(ai, "ollama_api_mode", "native") == "native":
            return self._run_ollama(
                user_id, messages, ai, session_id=session_id,
                session=session, on_interaction=on_interaction,
            )
        if use_anthropic:
            return self._run_anthropic(
                user_id, system_text, messages, ai, session_id=session_id,
                session=session, on_interaction=on_interaction,
            )
        return self._run_openai(
            user_id, messages, ai, session_id=session_id,
            session=session, on_interaction=on_interaction,
        )

    async def _recover_interrupted_continuation(
        self, generation: AsyncGenerator[str, None], user_id, system_text,
        messages: list, *, use_anthropic: bool, model_cfg, session_id: int | None,
        session=None,
    ) -> AsyncGenerator[str, None]:
        """统一处理工具续轮生成器提前结束。

        ``_new_round`` 表示工具结果已经写回 messages，后续模型轮次必须继续。
        如果 provider 流在 ``round_start`` 前异常结束，复用同一批已变更消息重试一次；
        第二次仍未启动则输出错误，禁止网关把半截工具过程当成成功回复。
        """
        retried = False
        continuation_pending = False
        while True:
            async for line in generation:
                try:
                    event = json.loads(line[6:])
                except Exception:
                    yield line
                    continue
                event_type = event.get("type")
                if event_type == "_new_round":
                    continuation_pending = True
                elif event_type == "round_start":
                    continuation_pending = False
                elif event_type in {"_cancelled", "error"}:
                    continuation_pending = False
                yield line

            if not continuation_pending:
                return
            if retried:
                yield f"data: {json.dumps({'type': 'error', 'detail': '工具结果已返回，但后续回复没有完成，请重试。'}, ensure_ascii=False)}\n\n"
                return
            retried = True
            _log.warning("工具续轮未开始，复用已提交工具结果恢复 LLM 请求 session=%s", session_id)
            generation = self._run_provider(
                user_id, system_text, messages, use_anthropic=use_anthropic,
                model_cfg=model_cfg, session_id=session_id, session=session,
            )
            continuation_pending = False

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
        # 入口统一提升为带固定前缀边界的消息容器。直接调用 runner 的测试和少量
        # 内部调用仍可能传入普通 list，但运行中的追加、压缩和审计必须走同一套批次语义。
        if not hasattr(messages, "append_batch"):
            from agent.context.assembly import PromptMessages
            messages = PromptMessages(messages)
        # 每轮对话只允许 inspect_images 对网络图片发起一次读取；历史附件不占用该额度。
        from agent.tools import search as search_tools
        search_tools.reset_image_inspection_budget()
        goal_mode = _goal_mode_enabled(session)
        unlimited_mode = _unlimited_mode_enabled(session)
        if goal_mode:
            if system_text:
                system_text = f"{system_text}{_GOAL_POLICY}"
            else:
                messages.insert(0, {"role": "system", "content": _GOAL_POLICY.strip()})
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
        guard_retry_pending = False
        guard_retry_buf: list[str] = []
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
        # 交互确认只对“刚刚被用户确认的同一个破坏性工具”续接一次。
        # 确认结果会进入 tool_result，但模型有时不会把凭证原样带回下一次调用；
        # 若不在运行时续接，就会再次触发同一个确认门。
        pending_confirmation: dict[str, Any] | None = None
        total_in = total_out = total_cache = 0
        # 一个 run 内 provider 每次返回的是该次请求的 context input；压缩判定使用
        # 这个 run 观察到的最高值，不能把多次请求相加，否则工具轮数越多越会误触发。
        run_context_usage = 0
        hard_budget_retries = 0
        compaction_applied = False
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

        def drain_round_text() -> list[str]:
            """取出已确认可展示的普通轮文字，并清空本轮缓冲。"""
            text = list(_round_text_buf)
            _round_text_buf.clear()
            return text

        async def compact_after_provider_overflow() -> bool:
            """仅在 provider overflow 后压缩旧 history，并让当前 round 重试。"""
            nonlocal messages, compaction_applied
            from agent.context import compaction

            conversation = getattr(messages, "conversation", messages)
            before_count = len(conversation)
            before_summary = [
                item for item in conversation
                if isinstance(item, dict) and "<compacted-summary>" in str(item.get("content") or "")
            ]
            protected_from = next(
                (index for index, item in enumerate(conversation)
                 if item is _run_start_message),
                max(0, len(conversation) - 1),
            )
            try:
                result = await compaction.compact_context(
                    list(conversation), system_text or "", getattr(ai, "context_tokens", 256000),
                    session_id=session_id, user_id=user_id,
                    fixed_prefix_size=getattr(messages, "fixed_prefix_size", 0),
                    overhead_tokens=0,
                    protected_from=protected_from,
                    force=True,
                )
            except Exception as exc:
                # 压缩失败时由调用方继续走确定性截断；不能让原始 overflow 变成
                # “开小差”并丢掉本轮已有输出。
                diag_log("agent.context.compaction.provider_overflow", exc)
                _log.warning("上下文压缩失败，继续使用确定性截断：%s", type(exc).__name__)
                return False
            if hasattr(result, "messages"):
                compacted_messages, changed = result.messages, result.changed
            else:
                # 兼容旧的压缩适配器和回归 mock，避免 provider overflow
                # 路径因结果形状差异丢失本轮回复。
                compacted_messages, changed = result
            after_summary = [
                item for item in compacted_messages
                if isinstance(item, dict) and "<compacted-summary>" in str(item.get("content") or "")
            ]
            try:
                from agent.runtime.loopscope_trace.state import record_context_compaction
                record_context_compaction(
                    phase="completed",
                    reason=str(getattr(result, "return_reason", "unknown") or "unknown"),
                    changed=bool(changed),
                    before_messages=before_count,
                    after_messages=len(compacted_messages),
                    before_summary_count=len(before_summary),
                    after_summary_count=len(after_summary),
                    before_summary_chars=sum(len(str(item.get("content") or "")) for item in before_summary),
                    after_summary_chars=sum(len(str(item.get("content") or "")) for item in after_summary),
                    protected_from=protected_from,
                )
            except Exception:
                pass
            if not changed:
                return False
            if hasattr(messages, "replace_conversation"):
                messages.replace_conversation(compacted_messages)
            else:
                messages = compacted_messages
            compaction_applied = True
            yield_event = {"type": "_context_compaction", "applied": True,
                           "reason": getattr(result, "return_reason", "compacted")}
            # 事件由调用方发送，避免 helper 自己消费生成器控制流。
            _context_compaction_event[0] = yield_event
            return True

        async def compact_after_usage_threshold() -> bool:
            """统一检查 run 级 provider context usage，达到 90% 后压缩旧 history。"""
            # 90% 观察线只在 provider usage 层维护一份，避免 core 再复制预算语义。
            from agent.context.compress_conv import BASELINE_UPDATE_RATIO

            context_tokens = max(1, int(getattr(ai, "context_tokens", 0) or 0))
            if run_context_usage < int(context_tokens * BASELINE_UPDATE_RATIO) or compaction_applied:
                return False
            return await compact_after_provider_overflow()

        async def compact_after_usage_threshold_safely() -> bool:
            """run 已有最终回复后执行压缩；失败不能覆盖成功回复。"""
            try:
                return await compact_after_usage_threshold()
            except Exception as exc:
                diag_log("agent.context.compaction.after_response", exc)
                _log.warning("回复完成后的上下文压缩失败，保留本轮回复：%s", type(exc).__name__)
                return False

        _context_compaction_event = [None]

        while True:
            # 核实轮拥有独立预算，但不能把 MAX_VERIFY 误加到普通任务轮次上。
            # 最后一轮额外留给模型输出核实后的收束文本。
            if verify_mode:
                if verify_rounds >= MAX_VERIFY_LLM_ROUNDS:
                    break
                verify_rounds += 1
            else:
                if task_rounds >= MAX_ROUNDS:
                    from app.services.interactions import create_goal_mode_prompt

                    interaction = await create_goal_mode_prompt(
                        user_id=user_id, session_id=session_id,
                    )
                    if interaction is None:
                        yield f"data: {json.dumps({'type': 'token', 'content': '本次已达到 30 轮。想继续的话，请发送 /unlimited 开启无限工具调用模式，再发送“继续”。'}, ensure_ascii=False)}\n\n"
                        return
                    prompt, options = interaction
                    yield stream_event(
                        "interaction_required",
                        round_id=round_id if round_number else None,
                        prompt_id=prompt.id,
                        kind=prompt.kind,
                        title=prompt.title,
                        body=prompt.body,
                        options=options,
                        expires_at=prompt.expires_at.isoformat(),
                        force_display=True,
                    )
                    from app.services.interactions import wait_for_resolution
                    answer = await wait_for_resolution(
                        user_id=user_id,
                        prompt_id=prompt.id,
                        heartbeat=lambda: genstream.touch(session_id),
                        cancel_check=lambda: _im_cancelled(session_id),
                    )
                    if isinstance(answer, dict) and answer.get("status") == "cancelled":
                        yield f"data: {json.dumps({'type': '_cancelled'}, ensure_ascii=False)}\n\n"
                        return
                    if answer is None:
                        yield f"data: {json.dumps({'type': 'error', 'detail': '这次继续操作已过期，请重新发起任务。'}, ensure_ascii=False)}\n\n"
                        return
                    if answer.get("option_id") in {"continue", "goal"}:
                        # 该按钮的语义是解除本次 run 的工具调用限制，不创建 goal
                        # 目标任务；清零轮次后回到同一主循环继续执行。
                        unlimited_mode = True
                        task_rounds = 0
                        yield stream_event(
                            "_new_round",
                            round_id=round_id if round_number else "round-0",
                            next_round=round_number + 1,
                        )
                        continue
                    return
                task_rounds += 1
            # 用户中途「算了」→ 轮间协作中断（单次 LLM 流式调用本身切不了，故粒度是轮与轮之间）
            if await _im_cancelled(session_id):
                yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                return

            _tok = 0
            result = None
            round_number += 1
            round_id = f"round-{round_number}"
            yield stream_event("round_start", round_id=round_id)
            _verify_buf = []   # 核实轮缓冲区：先攒着，回合结束按"有没有补做"决定 flush 还是丢弃
            _progress_buf: list[str] = []
            _progress_pending = False
            # 普通轮在 provider 流结束前无法确定是否包含工具调用。先缓冲文字，
            # 避免工具轮的计划/自述先进入用户流，随后又被下一轮最终回复覆盖。
            _round_text_buf: list[str] = []
            try:
                # 每次 provider 请求前刷新 selected tools。工具调用/结果由驱动构造批次，
                # 再由核心循环一次性提交到 history；这里仅更新原生 tools 参数。
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
                    elif goal_mode:
                        # 等待完成标记判定，避免把内部标记流给用户。
                        pass
                    elif guard_retry_pending:
                        # 守卫追问后的正文先不展示；只有该轮真的发起工具调用时，
                        # 才说明守卫生效并丢弃这段自我辩解。
                        guard_retry_buf.append(_val)
                    else:
                        # 对可能是“正在查询”占位话术的前缀暂存到 round 结束；如果后续
                        # 变成正常句子则原样 flush，只有确认是纯占位且无 tool call 时丢弃。
                        if _progress_pending:
                            candidate = "".join(_progress_buf) + _val
                            if _could_be_tool_progress(candidate):
                                _progress_buf.append(_val)
                            else:
                                _round_text_buf.extend(_progress_buf)
                                _progress_buf.clear()
                                _progress_pending = False
                                _round_text_buf.append(_val)
                        elif _could_be_tool_progress(_val):
                            _progress_pending = True
                            _progress_buf.append(_val)
                        else:
                            _round_text_buf.append(_val)
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
                from agent.context.budget import enforce_provider_overflow_fallback, is_context_overflow_error
                overflow = is_context_overflow_error(e) or is_context_overflow_error(e.cause) if e.cause else is_context_overflow_error(e)
                if overflow and hard_budget_retries < 1:
                    if await compact_after_provider_overflow():
                        hard_budget_retries += 1
                        _event = _context_compaction_event[0]
                        _context_compaction_event[0] = None
                        if _event:
                            yield f"data: {json.dumps(_event, ensure_ascii=False)}\n\n"
                        if verify_mode:
                            verify_rounds -= 1
                        else:
                            task_rounds -= 1
                        _log.warning("[core] provider overflow 后完成历史压缩，重试当前 round")
                        continue
                    hard_result = enforce_provider_overflow_fallback(
                        messages, system_text or "", getattr(ai, "context_tokens", 256000),
                        protected_from=next(
                            (index for index, item in enumerate(getattr(messages, "conversation", messages))
                             if item is _run_start_message),
                            max(0, len(getattr(messages, "conversation", messages)) - 1),
                        ),
                    )
                    if hard_result.changed:
                        compaction_applied = True
                        yield f"data: {json.dumps({'type': '_context_compaction', 'applied': True, 'reason': 'provider_overflow_fallback'}, ensure_ascii=False)}\n\n"
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
                yield f"data: {json.dumps({'type': 'error', 'detail': detail, 'message_key': 'chatUi.genericError' if not busy else 'chatUi.networkError'}, ensure_ascii=False)}\n\n"
                return
            except Exception as e:
                from agent.context.budget import enforce_provider_overflow_fallback, is_context_overflow_error
                if is_context_overflow_error(e) and hard_budget_retries < 1:
                    if await compact_after_provider_overflow():
                        hard_budget_retries += 1
                        _event = _context_compaction_event[0]
                        _context_compaction_event[0] = None
                        if _event:
                            yield f"data: {json.dumps(_event, ensure_ascii=False)}\n\n"
                        if verify_mode:
                            verify_rounds -= 1
                        else:
                            task_rounds -= 1
                        _log.warning("[core] provider overflow 后完成历史压缩，重试当前 round")
                        continue
                    hard_result = enforce_provider_overflow_fallback(
                        messages, system_text or "", getattr(ai, "context_tokens", 256000),
                        protected_from=next(
                            (index for index, item in enumerate(getattr(messages, "conversation", messages))
                             if item is _run_start_message),
                            max(0, len(getattr(messages, "conversation", messages)) - 1),
                        ),
                    )
                    if hard_result.changed:
                        compaction_applied = True
                        yield f"data: {json.dumps({'type': '_context_compaction', 'applied': True, 'reason': 'provider_overflow_fallback'}, ensure_ascii=False)}\n\n"
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
                yield f"data: {json.dumps({'type': 'error', 'detail': detail, 'message_key': 'chatUi.genericError'}, ensure_ascii=False)}\n\n"
                return

            total_in  += result.usage_in
            total_out += result.usage_out
            total_cache += result.cache_tokens
            run_context_usage = max(run_context_usage, _provider_context_usage(driver, result))
            # 发送单个 provider 请求的脱敏 usage；run 结束时的 _usage 仍保留为
            # 本次 run 累计值，诊断和观测层可据此区分“当前上下文”与“累计消耗”。
            yield stream_event(
                "_provider_usage",
                round_id=round_id,
                input=int(result.usage_in or 0),
                context_input=int(_provider_context_usage(driver, result) or 0),
                output=int(result.usage_out or 0),
                cache_read=int(result.cache_tokens or 0),
            )

            _requires_tools = result.requires_tools
            if _requires_tools is None:
                _requires_tools = bool(result.tool_calls)

            if initial_volatile_indices:
                loop_drivers._collapse_volatile_messages(messages, initial_volatile_indices)
                initial_volatile_indices = set()

            if result.tool_calls:
                if guard_retry_pending:
                    guard_retry_pending = False
                    guard_retry_buf.clear()
                if _progress_pending:
                    # 工具轮的所有普通文字都属于模型过程叙述，不能因为看起来像
                    # “正在查询”就提前泄漏；真正的工具状态通过 tool_call 事件展示。
                    _progress_buf.clear()
                    _progress_pending = False
                _round_text_buf.clear()
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
                remaining_tool_calls = (
                    None if (goal_mode or unlimited_mode) else max(0, MAX_TOOL_CALLS - tool_calls_used)
                )
                round_limit_exceeded = (
                    not (goal_mode or unlimited_mode)
                    and task_rounds >= MAX_ROUNDS
                )
                tool_budget_exceeded = (
                    remaining_tool_calls is not None
                    and len(result.tool_calls) > remaining_tool_calls
                )
                tool_budget_stop_requested = False
                if round_limit_exceeded or tool_budget_exceeded:
                    # 两种限制都必须在 dispatch 前暂停整批待执行请求。用户点击继续后，
                    # 先放行这批请求，再解除对应的后续上限，避免模型看到“工具结果已失败”
                    # 后直接总结，或把同一批工具重新规划一遍。
                    if round_limit_exceeded:
                        _log.warning("[core] LLM 轮次达到上限：rounds=%s limit=%s", task_rounds, MAX_ROUNDS)
                        from app.services.interactions import create_goal_mode_prompt
                        interaction = await create_goal_mode_prompt(
                            user_id=user_id, session_id=session_id,
                        )
                    else:
                        _log.warning("[core] 工具调用达到 run 上限：used=%s limit=%s", tool_calls_used, MAX_TOOL_CALLS)
                        from app.services.interactions import create_tool_budget_prompt
                        interaction = await create_tool_budget_prompt(
                            user_id=user_id, session_id=session_id,
                        )
                    if interaction is None:
                        detail = (
                            "本次已达到 30 轮。想继续的话，请发送 /unlimited 开启无限工具调用模式，再发送“继续”。"
                            if round_limit_exceeded
                            else "这次查询步骤有点多，咕咕先停在这里了；前面已经获得的结果仍然有效。"
                        )
                        event_type = "token" if round_limit_exceeded else "error"
                        yield f"data: {json.dumps({'type': event_type, 'content' if event_type == 'token' else 'detail': detail}, ensure_ascii=False)}\n\n"
                        return
                    prompt, options = interaction
                    yield stream_event(
                        "interaction_required",
                        round_id=round_id,
                        prompt_id=prompt.id,
                        kind=prompt.kind,
                        title=prompt.title,
                        body=prompt.body,
                        options=options,
                        expires_at=prompt.expires_at.isoformat(),
                        force_display=True,
                    )
                    from app.services.interactions import wait_for_resolution
                    answer = await wait_for_resolution(
                        user_id=user_id,
                        prompt_id=prompt.id,
                        heartbeat=lambda: genstream.touch(session_id),
                        cancel_check=lambda: _im_cancelled(session_id),
                    )
                    if (
                        isinstance(answer, dict)
                        and answer.get("status") == "cancelled"
                        and answer.get("option_id") != "cancel"
                    ):
                        yield f"data: {json.dumps({'type': '_cancelled'}, ensure_ascii=False)}\n\n"
                        return
                    if answer is None:
                        yield f"data: {json.dumps({'type': 'error', 'detail': '这次继续操作已过期，请重新发起任务。'}, ensure_ascii=False)}\n\n"
                        return
                    if answer.get("option_id") == "continue":
                        # 继续执行同一批原始 tool call，不重新交给模型判断是否总结；
                        # 同时解除轮次和工具调用上限，保持“继续”语义一致。
                        unlimited_mode = True
                        task_rounds = 0
                        remaining_tool_calls = None
                        round_limit_exceeded = False
                        tool_budget_exceeded = False
                    elif round_limit_exceeded:
                        # 轮次限制下用户选择停止时，当前工具批次尚未写入历史，直接收尾；
                        # 不再额外请求模型，避免把“停止”变成一次新的空续轮。
                        yield f"data: {json.dumps({'type': 'token', 'content': '已先停在这里，前面成功执行的调整仍然有效。'}, ensure_ascii=False)}\n\n"
                        return
                    else:
                        # 拒绝时阻止这整批尚未执行的请求，并让模型在无工具模式下
                        # 基于已取得的结果生成说明，而不是静默结束。
                        tool_budget_stop_requested = True
                        task_rounds = 0
                        remaining_tool_calls = 0
                        tool_budget_exceeded = False
                        driver.update_tools(ctx, [])
                for call_index, tc in enumerate(result.tool_calls):
                    adapter_target = None
                    protocol_error = None
                    raw_call_name = getattr(tc, "name", None)
                    if not isinstance(raw_call_name, str):
                        protocol_error = invalid_tool_call_payload()
                    elif raw_call_name == "call_tool" and isinstance(tc.input, dict):
                        raw_target_name = tc.input.get("name")
                        if raw_target_name is not None and normalize_tool_name(raw_target_name) is None:
                            protocol_error = invalid_tool_call_payload(
                                reason="call_tool.name 必须是字符串"
                            )
                        else:
                            adapter_target = normalize_tool_name(raw_target_name)
                            if adapter_target:
                                # 固定 Adapter 为了兼容旧模型允许扁平参数，但不能把只有
                                # name 的调用静默降级成目标工具的空对象，否则错误会伪装成
                                # 业务 Schema 缺字段，也会诱发模型重复发送同一个空调用。
                                has_arguments = "arguments" in tc.input
                                has_flattened_arguments = any(key != "name" for key in tc.input)
                                if not has_arguments and not has_flattened_arguments:
                                    protocol_error = invalid_tool_call_payload(
                                        path="arguments",
                                        rule="required",
                                        reason="call_tool.arguments 是必填字段",
                                    )
                                elif has_arguments and not isinstance(tc.input.get("arguments"), dict):
                                    protocol_error = invalid_tool_call_payload(
                                        path="arguments",
                                        reason="call_tool.arguments 必须是 JSON object",
                                    )
                    effective_tool_name = adapter_target or (
                        raw_call_name if isinstance(raw_call_name, str) else "invalid_tool_call"
                    )
                    label = self._label(effective_tool_name)
                    if verify_mode:   # 复查前缀后端拼接（可在「状态命名」面板改 _verify_prefix；支持多候选随机）
                        label = self._label("_verify_prefix", "复查 · ") + label
                    if tool_budget_stop_requested or (
                        remaining_tool_calls is not None and call_index >= remaining_tool_calls
                    ):
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
                    if protocol_error is not None:
                        tool_call_id = getattr(tc, "id", None) or f"{round_id}-tool-{call_index + 1}"
                        yield stream_event(
                            "tool_call", round_id=round_id, tool_call_id=tool_call_id,
                            name=effective_tool_name, label=label, input={}, verify=verify_mode,
                            status="invalid",
                        )
                        protocol_result = json.dumps(protocol_error, ensure_ascii=False)
                        yield stream_event(
                            "tool_done", round_id=round_id, tool_call_id=tool_call_id,
                            name=effective_tool_name, label=label, verify=verify_mode,
                            status="error", result=protocol_result,
                        )
                        dispatched.append((tc, protocol_result))
                        continue
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
                    # Skill 正文第一次通过 use_skill 进入 history 后，正文指纹一致时复用；
                    # 文件更新或 history 中仍是旧版标记时，重新加载正文。
                    skill_slug = None
                    if tc.name == "use_skill":
                        from agent.skills import resolve_skill_slug
                        requested_skill = str((tc.input or {}).get("name") or "")
                        skill_slug = resolve_skill_slug(requested_skill) or requested_skill.strip().lower()
                    current_skill_digest = None
                    if skill_slug:
                        capability_context = self.capability_context
                        if capability_context is not None:
                            current_skill_digest = capability_context.skill_digest(skill_slug)
                        if not current_skill_digest:
                            from agent.skills import skill_content_digest
                            current_skill_digest = skill_content_digest(skill_slug)
                    if (
                        skill_slug
                        and current_skill_digest
                        and loaded_skill_slugs.get(skill_slug) == current_skill_digest
                    ):
                        res = json.dumps({
                            "skill": skill_slug,
                            "already_loaded": True,
                            "message": "该技能正文已在当前上下文中，无需重复加载。",
                        }, ensure_ascii=False)
                        artifact = None
                    else:
                        dispatch_input = tc.input
                        confirmation = pending_confirmation
                        if confirmation and confirmation.get("tool_name") == effective_tool_name:
                            dispatch_input, consumed = _inject_pending_confirmation(
                                tc.input, adapter_target, confirmation,
                            )
                            if consumed:
                                # 凭证是一次性的，仅供本次同名工具调用尝试使用。
                                pending_confirmation = None
                        if adapter_target is not None:
                            from agent.tools.base import set_dispatch_session, reset_dispatch_session
                            _dispatch_token = set_dispatch_session(session_id, session, run_id)
                            try:
                                res, artifact = await registry.dispatch(
                                    user_id, adapter_target, _resolve_adapter_arguments(dispatch_input)
                                )
                            finally:
                                reset_dispatch_session(_dispatch_token)
                        else:
                            from agent.tools.base import set_dispatch_session, reset_dispatch_session
                            _dispatch_token = set_dispatch_session(session_id, session, run_id)
                            try:
                                res, artifact = await registry.dispatch(user_id, tc.name, dispatch_input)
                            finally:
                                reset_dispatch_session(_dispatch_token)
                        if skill_slug and _is_successful_tool_result(res) and current_skill_digest:
                            loaded_skill_slugs[skill_slug] = current_skill_digest
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
                            pending_interaction = (prompt.id, tool_call_id, effective_tool_name)
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
                        pending_interaction = (interaction["prompt_id"], tool_call_id, effective_tool_name)
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
                from agent.context.assembly import NewMessageBatch
                from agent.context.canonical_tool_history import canonical_tool_round

                # 工具结果里的图片块只能发给明确支持视觉输入的本轮模型。不能只看
                # 工具本身是否成功，否则 GLM 等文本模型会收到 image_url 并被 provider
                # 以 400 拒绝，导致工具结果已经返回却无法继续对话。
                from agent import providers
                allow_tool_images = bool(providers.capability_snapshot(ai).get("vision", False))
                provider_round = driver.build_tool_round(
                    result, dispatched, allow_images=allow_tool_images,
                )
                if getattr(driver, "api_format", "") == "anthropic":
                    try:
                        from agent.runtime.loopscope_trace.state import record_anthropic_structure_probe
                        record_anthropic_structure_probe(
                            provider=getattr(getattr(ctx, "adapter", None), "name", ""),
                            model=getattr(ctx, "model", ""),
                            response_blocks=getattr(result, "raw", []),
                            provider_messages=provider_round,
                        )
                    except Exception:
                        pass
                batch = NewMessageBatch.from_canonical_messages(
                    canonical_tool_round(result, dispatched),
                    provider_messages=provider_round,
                    metadata={"round_id": round_id},
                )
                try:
                    from agent.runtime.loopscope_trace.state import record_canonical_batch
                    record_canonical_batch(
                        digest=batch.batch_digest,
                        round_id=round_id,
                        message_count=len(batch.canonical_messages),
                    )
                except Exception:
                    pass
                if getattr(self.capability_context, "fixed_adapter", False):
                    from agent.context.canonical_tool_history import (
                        SkillSchemaEvent, ToolDiscoveryEvent, append_event, tool_schema_event,
                    )
                    # canonical event 也先进入同一批次，不能在工具 round 提交后再单独
                    # 修改 history；否则下一次重建时消息粒度和顺序可能发生变化。
                    batch_history = list(getattr(messages, "conversation", messages)) + batch.messages

                    def add_event(event) -> None:
                        before = len(batch_history)
                        append_event(batch_history, event)
                        if len(batch_history) > before:
                            event_message = batch_history[-1]
                            # Schema/discovery 是 capability context，不是工具回执。
                            # 必须保持独立的 canonical user message，禁止并入
                            # tool_result，否则 sanitize/reload 后消息边界会漂移。
                            batch.append(event_message)

                    for tc, _res in dispatched:
                        if tc.name == "get_tool_schema":
                            try:
                                declaration = json.loads(_res) if isinstance(_res, str) else _res
                            except (TypeError, ValueError):
                                declaration = None
                            declared = (
                                declaration.get("tool_schemas", ())
                                if isinstance(declaration, dict) else ()
                            )
                            valid_names = tuple(
                                name for name in declared
                                if isinstance(name, str)
                                and name in getattr(self.capability_context.snapshot, "tools", {})
                            )
                            if valid_names:
                                add_event(ToolDiscoveryEvent(valid_names))
                                for name in valid_names:
                                    tool = registry.get(name)
                                    if tool is not None:
                                        add_event(tool_schema_event(tool))
                            continue
                        if tc.name == "use_skill":
                            skill_name = str((tc.input or {}).get("name") or "").strip()
                            resolved_skill = None
                            from agent.skills import resolve_skill_slug
                            resolved_skill = resolve_skill_slug(skill_name) or skill_name
                            skill_meta = getattr(self.capability_context, "snapshot", None)
                            skill_meta = getattr(skill_meta, "skills", {}).get(resolved_skill)
                            related = tuple(getattr(skill_meta, "related_tools", ()) or ())
                            if related:
                                add_event(SkillSchemaEvent(skill_name, related))
                                for name in related:
                                    tool = registry.get(name)
                                    if tool is not None:
                                        add_event(tool_schema_event(tool))
                            continue
                        target_name = None
                        if tc.name == "call_tool" and isinstance(tc.input, dict):
                            target_name = str(tc.input.get("name") or "").strip() or None
                        if not target_name and tc.name != "call_tool":
                            try:
                                error_payload = json.loads(_res) if isinstance(_res, str) else _res
                            except (TypeError, ValueError):
                                error_payload = None
                            recovery = (
                                error_payload.get("_schema_recovery")
                                if isinstance(error_payload, dict) else None
                            )
                            if isinstance(recovery, dict) and recovery.get("needed") is True:
                                # 动态 Provider 直接调用业务工具且参数校验失败时，
                                # 也把当前工具 Schema 写入 canonical history；下一轮
                                # 不再让模型继续凭记忆猜参数。
                                target_name = tc.name
                        if target_name:
                            tool = registry.get(target_name)
                            if tool is not None:
                                add_event(tool_schema_event(tool))
                messages.append_batch(batch)
                if pending_interaction is not None:
                    from app.services.interactions import wait_for_resolution
                    prompt_id, pending_tool_call_id, pending_tool_name = pending_interaction
                    answer = await wait_for_resolution(
                        user_id=user_id, prompt_id=prompt_id,
                        heartbeat=lambda: genstream.touch(session_id),
                        cancel_check=lambda: _im_cancelled(session_id),
                    )
                    if isinstance(answer, dict) and answer.get("status") == "cancelled":
                        yield f"data: {json.dumps({'type': '_cancelled'}, ensure_ascii=False)}\n\n"
                        return
                    if answer is None:
                        yield f"data: {json.dumps({'type': 'error', 'detail': '这次交互已过期，请重新告诉我你的选择。'}, ensure_ascii=False)}\n\n"
                        return
                    if (
                        isinstance(answer, dict)
                        and answer.get("status") == "confirmed"
                        and isinstance(answer.get("confirm_token"), str)
                    ):
                        pending_confirmation = {
                            "tool_name": pending_tool_name,
                            "confirm_token": answer["confirm_token"],
                        }
                    _replace_tool_result(
                        messages,
                        tool_call_id=pending_tool_call_id,
                        result=answer,
                    )
                    if await compact_after_usage_threshold():
                        _event = _context_compaction_event[0]
                        _context_compaction_event[0] = None
                        if _event:
                            yield f"data: {json.dumps(_event, ensure_ascii=False)}\n\n"
                    yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                    continue
                if tool_budget_stop_requested:
                    messages.append_batch(driver.build_followup(
                        result, _TOOL_BUDGET_STOP_PROMPT,
                    ))
                    yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                    continue
                # 工具结果已经入历史，直接接复查 prompt。旧流程会先多请求一次模型来生成
                # "已完成"，随后才开始复查；这轮没有新信息，只会徒增一次等待。
                if did_mutate and verify_count < MAX_VERIFY:
                    verify_count += 1
                    did_mutate = False
                    verify_mode = True
                    verify_queried = False
                    messages.append_batch([{"role": "user", "content": _VERIFY_PROMPT}])
                if await compact_after_usage_threshold():
                    _event = _context_compaction_event[0]
                    _context_compaction_event[0] = None
                    if _event:
                        yield f"data: {json.dumps(_event, ensure_ascii=False)}\n\n"
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
                messages.append_batch(driver.build_followup(
                    result, _VERIFY_FORCE_PROMPT if _need_force else _VERIFY_PROMPT,
                ))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue

            # 核验提示已经要求模型在查询后直接总结；如果当前轮已经给出可交付的结果，
            # 不再重复发一轮最终收束请求。只有“我确认一下/已核实”这类过程播报才需要
            # 追加收束轮，避免它被直接展示给用户。
            if (verify_mode and verify_queried and not finalize_pending
                    and _is_verify_placeholder("".join(_verify_buf))):
                finalize_pending = True
                messages.append_batch(driver.build_followup(result, _FINALIZE_PROMPT))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue

            # 核实阶段结束：不再需要补做/强查 → 把缓冲的核实文字发给用户，退出核实模式。
            if verify_mode and _verify_buf:
                async for _line in genstream.typed_stream(''.join(_verify_buf)):
                    yield _line
            verify_mode = False
            _verify_buf = []

            _final_text = result.text
            if goal_mode:
                completed = _goal_completed(_final_text)
                _final_text = _strip_goal_marker(_final_text)
                if _final_text.strip():
                    async for _line in genstream.typed_stream(_final_text):
                        yield _line
                if not completed:
                    messages.append_batch(driver.build_guard_followup(
                        result,
                        "目标尚未完成。继续执行剩余步骤；只有完整目标全部完成后，才输出内部完成标记。",
                    ))
                    yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                    continue
            if guard_retry_pending:
                # 守卫后的模型仍未真实调用工具：不把“我刚才只是……”之类的
                # 守卫回应作为第二条用户可见消息输出。
                guard_retry_pending = False
                guard_retry_buf.clear()
                yield f"data: {json.dumps({'type': '_usage', 'input': total_in, 'context_input': run_context_usage, 'output': total_out, 'cache_read': total_cache})}\n\n"
                return
            # 只有在确认是正常回复时才把此前暂存的进度片段发给前端；纯占位输出会被
            # 丢弃并重试，避免用户看到“正在查询”后流程已经结束。
            if _progress_pending and not _is_tool_progress_only(_final_text):
                _round_text_buf.extend(_progress_buf)
                _progress_buf.clear()
                _progress_pending = False
            elif _progress_pending:
                _round_text_buf.clear()
                _progress_buf.clear()
                _progress_pending = False
            # 空回复兜底：整轮无正文、没动工具、不在核实阶段 → 先追一轮要正文，仍空给句得体兜底。
            if not _final_text.strip() and not did_mutate and not verify_mode:
                if empty_retry < 1:
                    empty_retry += 1
                    messages.append_batch(driver.build_empty_retry(result))
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
                guard_retry_pending = True
                guard_retry_buf.clear()
                for _text in drain_round_text():
                    yield f"data: {json.dumps({'type': 'token', 'content': _text}, ensure_ascii=False)}\n\n"
                messages.append_batch(driver.build_guard_followup(result, _NARRATION_NUDGE))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # 意图守卫（B）：宣告「我这就去查/建/改…」却本轮零工具 → 逼它当场做（_announces_intent 已排除问句/征询）。只追一次。
            if (not any_tool_called and not verify_mode and intent_retry < 1
                    and _announces_intent(_final_text)):
                intent_retry += 1
                guard_retry_pending = True
                guard_retry_buf.clear()
                for _text in drain_round_text():
                    yield f"data: {json.dumps({'type': 'token', 'content': _text}, ensure_ascii=False)}\n\n"
                messages.append_batch(driver.build_guard_followup(result, _INTENT_NUDGE))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # 若 provider 将显式决策放进 RoundResult，或模型只返回纯进度占位话术，
            # 本轮都不能作为最终回复结束。当前内置驱动的 requires_tools 由 tool_calls
            # 推导，保留该分支供支持显式决策的 provider 适配器使用。
            if (not any_tool_called and not verify_mode and tool_intent_retry < 1
                    and (_requires_tools is True or _is_tool_progress_only(_final_text))):
                tool_intent_retry += 1
                guard_retry_pending = True
                guard_retry_buf.clear()
                for _text in drain_round_text():
                    yield f"data: {json.dumps({'type': 'token', 'content': _text}, ensure_ascii=False)}\n\n"
                messages.append_batch(driver.build_guard_followup(result, _TOOL_REQUIRED_NUDGE))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # P3 决策守卫：用户明确要改、模型零工具却用「不用改/已合理」驳回 → 逼它执行或问清，别擅自不做。
            if (not any_tool_called and not verify_mode and decision_retry < 1
                    and _is_decision_dodge(_user_req, _final_text)):
                decision_retry += 1
                guard_retry_pending = True
                guard_retry_buf.clear()
                for _text in drain_round_text():
                    yield f"data: {json.dumps({'type': 'token', 'content': _text}, ensure_ascii=False)}\n\n"
                messages.append_batch(driver.build_guard_followup(result, _DECISION_NUDGE))
                yield stream_event("_new_round", round_id=round_id, next_round=round_number + 1)
                continue
            # 即时复查时，前面还没有生成过最终说明；保留最终收束轮的确认给用户，
            # 复查过程中的文字仍然一直缓冲、不显示。
            if verify_mode and verify_queried and _final_text.strip():
                async for _line in genstream.typed_stream(_final_text):
                    yield _line

            # 普通最终回复也必须经过同一条 90% 检查。此前这里直接结束，导致没有
            # tool call 的长回复不会触发 baseline 更新；检查发生在最终正文已经确定后，
            # 不会打断输出，且 compaction_applied 防止本 run 重复压缩。
            if await compact_after_usage_threshold_safely():
                _event = _context_compaction_event[0]
                _context_compaction_event[0] = None
                if _event:
                    yield f"data: {json.dumps(_event, ensure_ascii=False)}\n\n"

            for _text in drain_round_text():
                yield f"data: {json.dumps({'type': 'token', 'content': _text}, ensure_ascii=False)}\n\n"

            yield f"data: {json.dumps({'type': '_usage', 'input': total_in, 'context_input': run_context_usage, 'output': total_out, 'cache_read': total_cache})}\n\n"
            return

        # 核实预算耗尽时，最后一轮可能刚完成工具调用，还没有机会生成自然语言收尾。
        # 不能让 runner 把这个正常的安全停止误判成“工具结果已返回，但后续回复没有完成”。
        # 核实阶段的过程文字仍然只留在缓冲区，不能在这里泄漏给用户。
        if verify_rounds >= MAX_VERIFY_LLM_ROUNDS:
            fallback = "已提交前面成功执行的调整；核实轮次已达到上限，未完成的步骤请重新发起。"
            async for _line in genstream.typed_stream(fallback):
                yield _line
            yield f"data: {json.dumps({'type': '_usage', 'input': total_in, 'context_input': run_context_usage, 'output': total_out, 'cache_read': total_cache})}\n\n"
            return
