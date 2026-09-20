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
from typing import Any, AsyncGenerator, Awaitable, Callable, NamedTuple

from agent.llm import genstream
from agent import loop_drivers
from agent.providers.openai_responses import OpenAIResponsesDriver
from agent.tools import registry
from app.core.errors import RetryableError
from app.core.redaction import diag_log
from app.core.tz import now_utc
from agent.interactions.stream_events import encode_event
from agent.tools.tool_contract import invalid_tool_call_payload, normalize_tool_name
from agent.context.message_roles import last_user_index, user_text_from_message

_log = logging.getLogger("agent.core")

# provider round、退避表与 usage 语义已迁 `agent/loop/provider.py`（PRD-LLM-25
# LLM25-003）；历史清洗、工具协议解析等 helper 也分别迁回各自的归属模块。
# 这里保留兼容别名：旧测试 `monkeypatch.setattr(core, "_stream_round", ...)` 仍
# 通过本模块属性查找生效（_run_loop 调用时把该名字注入 driver.run_round）。
from agent.loop.provider import provider_context_usage as _provider_context_usage
from agent.loop.provider import stream_round as _stream_round
from agent.context.provider_history import sanitize_anthropic_history as _sanitize_anthropic_history
from agent.tools.tool_contract import (
    MAX_CALL_TOOL_ADAPTER_DEPTH as _MAX_CALL_TOOL_ADAPTER_DEPTH,
    resolve_adapter_arguments as _resolve_adapter_arguments,
    resolve_tool_call as _resolve_tool_call,
)
from agent.tools.base import (
    WRITE_PREFIXES as _WRITE_PREFIXES,
    is_successful_tool_result as _is_successful_tool_result,
    mutating_tools as _mutating_tools,
)
from agent.context.assembly.messages import replace_tool_result as _replace_tool_result
from agent.loop.tools import (
    call_observes as _call_observes,
    call_requires_verification as _call_requires_verification,
    dispatch_in_session as _dispatch_in_session,
    is_read_tool as _is_read_tool,
    pending_tool_signal as _pending_tool_signal,
    RepeatCallBreaker,
    tool_result_payload as _tool_result_payload,
)
from agent.loop.events import artifact_sse as _artifact_sse
from agent.loop.models import PendingInteraction as _PendingInteraction
from agent.loop import rounds as loop_rounds
from agent.loop.interactions import (
    CANCEL_CLOSE_TEXT as _CANCEL_CLOSE_TEXT,
    PAUSE_CLOSE_TEXT as _PAUSE_CLOSE_TEXT,
    classify_interaction_answer,
    closing_frames as _closing_frames,
    user_cancel as _user_cancel,
)
from agent.loop import provider as _loop_provider
_loop_provider.set_driver_stream_round_resolver(lambda: _stream_round)


# 工具循环最大轮次。普通任务和核实轮分开计数，核实预算不能放大普通任务的上限。
MAX_ROUNDS = 30
# unlimited 只解除产品层的普通轮次额度，不能解除服务级安全边界；任何状态机异常
# 都必须在有限请求内收束，避免持续消耗 provider 配额并把 429 放大成后台风暴。
MAX_ABSOLUTE_ROUNDS = 100
from agent.loop.guards import _GOAL_DONE_MARKER, goal_completed as _goal_completed, \
    is_verify_placeholder as _is_verify_placeholder, strip_goal_marker as _strip_goal_marker

_FINALIZE_PROMPT = (
    "【内部最终收束】工具操作和结果核验已经完成。现在只生成给用户看的最终回复："
    "根据本轮用户原始请求、已执行的操作和最新核验结果，直接总结实际完成了什么；"
    "不要再次寒暄，不要说‘在呢’‘怎么了’‘收到’等泛化话，也不要提及工具、核验或内部提示。"
    "如果操作已成功，明确说明结果；如果有失败或未完成，说明具体原因。"
)

_VERIFY_PROMPT = (
    "【内部核验 · 请执行】你刚才执行了增删改操作。现在用对应的查询工具检查结果是否生效且完整："
    "查询工具一般是 `list_*` / `get_*` / `read_*`（建项目用 `get_project` 看阶段待办、定时任务用 `list_scheduled_tasks` 看 cron/内容……照此类推）。"
    "**尤其改了文件正文（`edit_file`/`create_file`）：必须用 `read_file` 把内容读回来逐字比对；按行编辑还要确认目标行已更新/删除且其它行未被移动或覆盖——`list_dir` 只能看文件在不在，光看那个不算核实。**"
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

# 特殊状态显示名默认值（非工具，无法从 registry 派生）。后台「状态命名」面板可覆盖：
#   _preparing      openai 流式收参数阶段的占位
#   _verify_prefix  复查轮工具标签前缀，后端拼到 label 前再下发
#   _thinking       「思考中」状态的文字（默认空＝显示三个点；填了才显示成文字气泡）
#   _context_compaction 自动整理上下文时的状态文字
# 任一命名都可填多个（用 | 分隔），显示时随机取一个 —— 见 _pick_label。
SPECIAL_STATE_LABELS = {
    "_preparing":     "咕咕正在整理…",
    "_verify_prefix": "复查 · ",
    "_thinking":      "",
    "_context_compaction": "正在整理上下文…",
}



# 特殊状态显示名默认值（非工具，无法从 registry 派生）。后台「状态命名」面板可覆盖：
#   _preparing      openai 流式收参数阶段的占位
_GOAL_POLICY = (
    "\n\n[内部目标任务规则] 当前会话处于目标任务模式。"
    "除非用户主动暂停或取消，不要因为完成一个子任务就结束整个目标。"
    "只有确认用户声明的完整目标已经完成时，才在最终答复末尾单独输出 "
    f"{_GOAL_DONE_MARKER}；未完成时不要输出该标记，并继续推进剩余工作。"
    "不要向用户解释这个内部标记。"
)
# 一个 run 内模型实际请求的工具调用总数。工具自身仍可有更细的专用额度。
MAX_TOOL_CALLS = 10
# 同名工具 + 完全相同参数的连续调用熔断阈值：允许前 3 次真实执行，第 4 次起不再
# dispatch，直接回一条引导收束的结果。治「核实阶段反复重读同一资源找确认」的行为
# 死循环（unlimited 模式下轮次上限不生效，这层是唯一的形态级护栏）。
MAX_IDENTICAL_CONSECUTIVE_TOOL_CALLS = 3
_REPEAT_CALL_STOP_RESULT = (
    "检测到你已连续多次以完全相同的参数调用同一工具，结果不会再发生变化。"
    "请不要重复这一调用：基于已经获得的信息执行下一步操作，或直接总结回复用户。"
)
_DEFAULT_BUDGET = object()
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


_REPEAT_ROUND_NUDGE = (
    "你已经连续多轮重复完全相同的工具调用，结果不会变化。请立即停止调用工具，"
    "直接根据已经获得的结果，给用户一段最终文字回复。"
)
_REPEAT_ROUND_LIMIT = 5   # 连续相同轮数达到该值即强制收束（3 轮先提醒，5 轮硬停）


def round_tool_signature(tool_calls) -> str | None:
    """一轮内全部工具调用（含被跳过/占位的）的形态签名；空轮返回 None。

    同轮内的重复调用经 sorted 去重后只影响一处——单轮多相同调用是合法
    形态（2026-09-18 定稿）；跨轮形态完全一致才累积。
    """
    if not tool_calls:
        return None
    try:
        entries = sorted(
            (str(getattr(tc, "name", "") or ""),
             json.dumps(getattr(tc, "input", None) or {}, sort_keys=True,
                        ensure_ascii=False, default=str))
            for tc in tool_calls
        )
        return json.dumps(entries, ensure_ascii=False)
    except Exception:
        return None


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
    """读取会话内临时额度窗口；持久化无限开关统一由用户偏好提供。"""
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
    # 兼容早期 goal 命令留下的无正文控制状态；正式的 /unlimited 开关不再写入会话。
    return bool(context.get("goal_mode") and not context.get("goal_text"))


async def _user_unlimited_mode_enabled(user_id) -> bool:
    """读取用户级无限工具调用开关，供 Web 与 IM 共用。"""
    try:
        from app.db import session as db_session
        from app.services.user_preferences import get_user_unlimited_mode
        if db_session._engine is None:
            db_session._build_engine()
        async with db_session._SessionLocal() as db:
            return await get_user_unlimited_mode(db, user_id)
    except Exception:
        # 偏好读取失败不能阻断普通对话；会话临时额度仍由原逻辑处理。
        return False


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
    _ends_with_colon,
    _is_tool_progress_only, _TOOL_REQUIRED_NUDGE,
    guard_locale,
)


# 增删改工具的命名约定：写动词前缀。新功能的工具照此命名（create_/update_/delete_/...），
# 就自动纳入自我核实——这是「新功能直接适配复查」的关键，不用再来这里登记。
_WRITE_PREFIXES = (
    "create_", "update_", "delete_", "add_", "remove_", "edit_", "rename_",
    "move_", "copy_", "set_", "archive_", "restore_", "permanent_delete", "save_",
)


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
    """据工具名打细粒度状态（web_search→SEARCHING、create_file→GENERATING），
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
    async def _run_loop(self, driver, user_id, messages: list, ai,
                         system_text: str | None,
                         session_id: int | None = None,
                         session=None,
                         on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
                         reasoning_state=None
                         ) -> AsyncGenerator[str, None]:
        """兼容转发：实现体在 `agent.loop.machine.run_loop`（PRD-LLM-25 LLM25-013）。

        本方法必须继续挂在 `LLMRunner` 类上——LoopScope hooks 按类属性替换并
        包裹 `LLMRunner._run_loop`（FR-LLM25-001）。
        """
        from agent.loop.machine import run_loop

        async for line in run_loop(
            self, driver, user_id, messages, ai,
            system_text=system_text,
            session_id=session_id, session=session,
            on_interaction=on_interaction, reasoning_state=reasoning_state,
        ):
            yield line


    def __init__(self, tool_names: list[str], settings, capability_context=None, locale: str | None = None,
                 dynamic_tools=None,
                 max_rounds: int | None | object = _DEFAULT_BUDGET,
                 max_tool_calls: int | None | object = _DEFAULT_BUDGET,
                 max_verify_rounds: int | None | object = _DEFAULT_BUDGET,
                 max_verify_cycles: int | None | object = _DEFAULT_BUDGET,
                 stop_on_budget: bool = False):
        self.tool_names = tool_names
        self.settings = settings
        self.capability_context = capability_context
        self.locale = locale
        self.dynamic_tools = {
            tool.name: tool for tool in (dynamic_tools or ())
            if getattr(tool, "name", None)
        }
        self.max_rounds = MAX_ROUNDS if max_rounds is _DEFAULT_BUDGET else max_rounds
        self.max_tool_calls = MAX_TOOL_CALLS if max_tool_calls is _DEFAULT_BUDGET else max_tool_calls
        self.max_verify_rounds = MAX_VERIFY_LLM_ROUNDS if max_verify_rounds is _DEFAULT_BUDGET else max_verify_rounds
        self.max_verify_cycles = MAX_VERIFY if max_verify_cycles is _DEFAULT_BUDGET else max_verify_cycles
        self.stop_on_budget = stop_on_budget
        # 状态显示名 = 特殊状态默认 ← 各工具 label ← 用户在后台「状态命名」面板的覆盖（热读）。
        # 未覆盖的 key 自动回退默认，所以「保留默认」天然成立。
        _ov = getattr(getattr(settings, "state_labels", None), "overrides", None) or {}
        self.labels = {
            **SPECIAL_STATE_LABELS,
            **registry.labels(),
            **{name: tool.label for name, tool in self.dynamic_tools.items()},
            **{str(k): str(v) for k, v in _ov.items() if v},
        }

    def _provider_tool_names(self, names: list[str]) -> list[str]:
        """按工具注入模式决定是否把动态 MCP 直接声明给 provider。

        简介/固定 Adapter 模式只通过能力目录发现 MCP，再由
        ``get_tool_schema`` → ``call_tool`` 按需调用；全量 Schema 模式仍直接
        声明动态 MCP 工具。
        """
        if not self.dynamic_tools or getattr(self.capability_context, "fixed_adapter", False):
            return list(dict.fromkeys(names))
        return list(dict.fromkeys([*names, *self.dynamic_tools]))

    def _label(self, name: str, default: str | None = None) -> str:
        """取状态显示名：命名含多个候选时随机取一（后端在发 tool_call 时调用）。"""
        return _pick_label(self.labels.get(name, name if default is None else default))

    def run(self, user_id, system_text: str, messages: list,
            use_anthropic: bool, model_cfg=None,
            session_id: int | None = None,
            session=None,
            on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
            reasoning_state=None,
            reasoning_policy="off",
            state_session_factory=None,
            ) -> AsyncGenerator[str, None]:
        # model_cfg：pick_model 解析出的模型配置（预设或 settings.ai）；None 时退回 settings.ai
        ai = model_cfg if model_cfg is not None else self.settings.ai
        if reasoning_state is None and state_session_factory is not None:
            from agent.context.reasoning_runtime import ReasoningStateCoordinator
            from agent.context.reasoning_state import ReasoningPersistencePolicy
            reasoning_state = ReasoningStateCoordinator(
                user_id=user_id, session_id=session_id, model_cfg=ai,
                policy=ReasoningPersistencePolicy.from_value(reasoning_policy),
                session_factory=state_session_factory,
            )
        generation = self._run_provider(
            user_id, system_text, messages, use_anthropic=use_anthropic,
            model_cfg=ai, session_id=session_id, session=session,
            on_interaction=on_interaction, reasoning_state=reasoning_state,
        )
        return self._recover_interrupted_continuation(
            generation, user_id, system_text, messages,
            use_anthropic=use_anthropic, model_cfg=ai,
            session_id=session_id, session=session, reasoning_state=reasoning_state,
            on_interaction=on_interaction,
        )

    def _run_provider(
        self, user_id, system_text: str | None, messages: list, *,
        use_anthropic: bool, model_cfg, session_id: int | None, session=None,
        on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
        reasoning_state=None,
    ) -> AsyncGenerator[str, None]:
        """启动一条未包装的 provider 流，续轮恢复只能调用这里。"""
        ai = model_cfg if model_cfg is not None else self.settings.ai
        if (getattr(ai, "provider", "") or "").lower() == "ollama" and \
                getattr(ai, "ollama_api_mode", "native") == "native":
            return self._run_ollama(
                user_id, messages, ai, session_id=session_id,
                session=session, on_interaction=on_interaction,
                reasoning_state=reasoning_state,
            )
        if str(getattr(ai, "api_format", "") or "").lower() in {"responses", "openai_responses"}:
            return self._run_responses(
                user_id, system_text, messages, ai, session_id=session_id,
                session=session, on_interaction=on_interaction,
                reasoning_state=reasoning_state,
            )
        if use_anthropic:
            return self._run_anthropic(
                user_id, system_text, messages, ai, session_id=session_id,
                session=session, on_interaction=on_interaction,
                reasoning_state=reasoning_state,
            )
        return self._run_openai(
            user_id, messages, ai, session_id=session_id,
            session=session, on_interaction=on_interaction,
            reasoning_state=reasoning_state,
        )

    async def _recover_interrupted_continuation(
        self, generation: AsyncGenerator[str, None], user_id, system_text,
        messages: list, *, use_anthropic: bool, model_cfg, session_id: int | None,
        session=None, on_interaction=None, reasoning_state=None,
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
                on_interaction=on_interaction,
                reasoning_state=reasoning_state,
            )
            continuation_pending = False

    async def _run_ollama(self, user_id, messages: list, ai=None,
                          session_id: int | None = None,
                          session=None,
                          on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
                          reasoning_state=None
    ) -> AsyncGenerator[str, None]:
        ai = ai if ai is not None else self.settings.ai
        kwargs = {"system_text": None, "session_id": session_id, "session": session,
                  "on_interaction": on_interaction}
        if reasoning_state is not None:
            kwargs["reasoning_state"] = reasoning_state
        async for line in self._run_loop(loop_drivers.OllamaDriver(), user_id, messages, ai, **kwargs):
            yield line

    # ── Anthropic（MiniMax / Anthropic）─────────────────────────────────────
    async def _run_anthropic(self, user_id, system_text: str,
                             messages: list, ai=None,
                             session_id: int | None = None,
                             session=None,
                             on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
                             reasoning_state=None
                             ) -> AsyncGenerator[str, None]:
        settings = self.settings
        ai = ai if ai is not None else settings.ai
        kwargs = {"system_text": system_text, "session_id": session_id, "session": session,
                  "on_interaction": on_interaction}
        if reasoning_state is not None:
            kwargs["reasoning_state"] = reasoning_state
        async for line in self._run_loop(loop_drivers.AnthropicDriver(), user_id, messages, ai, **kwargs):
            yield line

    # ── OpenAI ──────────────────────────────────────────────────────────────
    async def _run_openai(self, user_id, messages: list, ai=None,
                          session_id: int | None = None,
                          session=None,
                          on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
                          reasoning_state=None
                          ) -> AsyncGenerator[str, None]:
        settings = self.settings
        ai = ai if ai is not None else settings.ai
        kwargs = {"system_text": None, "session_id": session_id, "session": session,
                  "on_interaction": on_interaction}
        if reasoning_state is not None:
            kwargs["reasoning_state"] = reasoning_state
        async for line in self._run_loop(loop_drivers.OpenAIDriver(), user_id, messages, ai, **kwargs):
            yield line

    async def _run_responses(self, user_id, system_text: str | None,
                             messages: list, ai=None,
                             session_id: int | None = None,
                             session=None,
                             on_interaction: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
                             reasoning_state=None
                             ) -> AsyncGenerator[str, None]:
        settings = self.settings
        ai = ai if ai is not None else settings.ai
        kwargs = {"system_text": system_text, "session_id": session_id, "session": session,
                  "on_interaction": on_interaction}
        if reasoning_state is not None:
            kwargs["reasoning_state"] = reasoning_state
        async for line in self._run_loop(OpenAIResponsesDriver(), user_id, messages, ai, **kwargs):
            yield line

    # ── 共享主循环（PRD-LLM-1 Phase 2）────────────────────────────────────────
