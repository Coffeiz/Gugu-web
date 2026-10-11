"""统一构造一次 LLM run 的上下文与消息。

Web、IM 和定时任务可以保留不同的传输协议，但不应分别维护消息顺序、RAG
尾部和 provider 清洗逻辑。该模块只负责组装，不负责发送、持久化或 baseline。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent.context import audit, compress_conv, assembly, session_history
from agent.context import dynamic_tail, session_snapshot
from agent.context.history import build_history_parts
from agent.context.references import prepend_reference_context
from app.core.chat_attach import build_user_content, image_ready


@dataclass
class PreparedRun:
    """供 LLMRunner 消费的已组装上下文。"""

    rag_context: dict
    stance_to_persist: str | None
    message_area: Any


def _history_stance_digest(history: list) -> str | None:
    """读取最近一次已落库的姿态事件，作为跨 Run 去重的事实来源。"""
    for message in reversed(history or []):
        content = getattr(message, "content_json", None)
        blocks = content if isinstance(content, list) else []
        for block in reversed(blocks):
            if not isinstance(block, dict) or block.get("type") != "stance-context":
                continue
            stored_digest = str(block.get("digest") or "").strip()
            if stored_digest:
                return stored_digest
            text = str(block.get("text") or "")
            if text.startswith("[system-reminder]"):
                text = text[len("[system-reminder]"):]
            if text.endswith("[/system-reminder]"):
                text = text[:-len("[/system-reminder]")]
            return assembly.stance_digest(text.strip())
    return None


def _is_legacy_persisted_time_context(message: Any) -> bool:
    """识别误持久化的独立 time-context canonical 行。

    普通用户消息的时间现在统一以真实 ``ConversationMessage.sent_at`` 为事实源，
    history restore 会在原 user row 前重新生成相同 reminder。因此历史中任何只包含
    ``time-context`` 的独立 canonical 行都属于旧实现/回归产生的冗余投影：继续恢复
    会形成 ``sent_at time -> user -> persisted time`` 的重复前缀。

    这里只过滤“整行都是 time-context”的附属 canonical 消息，不会过滤真实用户行，
    也不会碰包含工具、RAG、runtime-context 等其它 canonical 事件的消息。
    """
    content = getattr(message, "content_json", None)
    if not isinstance(content, list) or not content:
        return False
    blocks = [block for block in content if isinstance(block, dict)]
    if len(blocks) != len(content) or not blocks:
        return False
    return all(block.get("type") == "time-context" for block in blocks)


def _effective_history(history: list, user_message: Any = None,
                       resume_interaction: bool = False) -> list:
    """返回本轮可恢复的历史，不重复当前已提交的用户行。"""
    current_message_id = (
        getattr(user_message, "id", None)
        if user_message is not None and not resume_interaction else None
    )
    return [
        message for message in history
        if not _is_legacy_persisted_time_context(message)
        and (
            current_message_id is None
            or getattr(message, "id", None) != current_message_id
        )
    ]


def _bind_persisted_user_message(batch, user_message: Any, resume_interaction: bool) -> None:
    if user_message is not None and not resume_interaction:
        batch.update_area_entry(
            "current_user", persisted_message_id=getattr(user_message, "id", None),
        )


async def _build_rag_context(
    req: Any, *, effective_history: list, snapshot_text: str,
    current_message_id: int | None,
) -> dict:
    """在当前任务上下文中构建 RAG，并绑定本轮 conversation 排他水位。"""
    from agent.rag import context as rag_request_context
    from agent.rag.injection import build_automatic_rag_context

    watermark_token = rag_request_context.set_conversation_before_message_id(
        current_message_id
    )
    try:
        return await build_automatic_rag_context(
            req, req.message, history=effective_history, snapshot_text=snapshot_text,
        )
    finally:
        rag_request_context.reset_conversation_before_message_id(watermark_token)


async def build_run_rag_context(
    req: Any, *, history: list, snapshot_text: str, user_message: Any = None,
    resume_interaction: bool = False,
) -> dict:
    """为准备阶段提前启动 RAG；有效历史和水位规则与消息组装保持一致。"""
    effective_history = _effective_history(
        history, user_message=user_message, resume_interaction=resume_interaction,
    )
    current_message_id = (
        getattr(user_message, "id", None)
        if user_message is not None and not resume_interaction else None
    )
    return await _build_rag_context(
        req, effective_history=effective_history, snapshot_text=snapshot_text,
        current_message_id=current_message_id,
    )


def assemble_run_area(
    *, system_prompt, fixed_parts, history, render_options, use_anthropic,
    current_user, stance=None, previous_stance_digest=None, message_time=None,
    conversation_tail=(), extra_reminder=None, message_area=None,
):
    """统一固定前缀、历史和本轮消息布局；协议差异只影响 system 的承载位置。"""
    prefix = list(fixed_parts)
    if not use_anthropic:
        prefix.insert(0, {"role": "system", "content": system_prompt})
    assembled = assembly.assemble(
        fixed_parts=prefix, history=history, message_area=message_area,
        render_options=render_options,
    )
    batch, _ = assembly.assemble_turn(
        stance=stance, previous_stance_digest=previous_stance_digest,
        message_time=message_time, current_user=current_user,
        conversation_tail=conversation_tail, extra_reminder=extra_reminder,
    )
    return assembled, batch


async def prepare_run(
    *,
    system_prompt: str,
    snapshot_context: str,
    history: list,
    req: Any,
    user_tz: str,
    strip_thinking: bool,
    use_anthropic: bool,
    current_text: str,
    images: list | None,
    media: list | None,
    model_cfg: Any,
    stance_text: str | None,
    snapshot_injection: Any | None,
    extra_reminder: str | None = None,
    user_message: Any = None,
    resume_interaction: bool = False,
    session: Any = None,
    snapshot: Any = None,
    history_stats: Any = None,
    prepared_rag_context: dict | None = None,
) -> PreparedRun:
    """按固定顺序组装消息，并返回本轮 RAG 持久化信息。"""
    fixed_parts = compress_conv.fixed_context_parts(snapshot_injection)
    # 兼容曾经误写入 canonical history 的动态 now/message-time 行。数据库旧行可以
    # 留给后续压缩/清理，但运行时只认真实 user row 的 sent_at，避免重复时间块污染
    # provider 前缀和 RAG 输入。
    # Web 后台任务在提交用户消息后会重新读取 history。当前用户行已经落库，
    # 但本轮必须由 ``current_user`` 统一构造（图片、媒体、引用等 provider 投影
    # 只有这里是完整版本），否则会先恢复一份纯文本历史，再追加一份图文消息，
    # 造成同一正文重复并改变 cache prefix。按主键排除，不能按正文排除：连续两条
    # 相同文本是合法对话。
    effective_history = _effective_history(
        history, user_message=user_message, resume_interaction=resume_interaction,
    )
    restored_area = session_history.restore_canonical_area(effective_history)
    from agent import providers
    render_options = {
        "api_format": providers.adapter_for(model_cfg).protocol_format(model_cfg),
        "allow_tool_images": image_ready(model_cfg),
        "request": req,
        "user_tz": user_tz,
        "strip_thinking": strip_thinking,
    }
    current_message_id = (
        getattr(user_message, "id", None)
        if user_message is not None and not resume_interaction else None
    )
    from agent.context.retention import protected_message_ids
    prior_run_message_ids = protected_message_ids(effective_history)
    history_parts, prior_run_parts_start = build_history_parts(
        effective_history, req, use_anthropic=use_anthropic, user_tz=user_tz,
        strip_thinking=strip_thinking,
        allow_tool_images=render_options["allow_tool_images"],
        protected_message_ids=prior_run_message_ids,
        return_protected_start=True,
    )
    message_time = None
    if user_message is not None and not resume_interaction:
        message_time = dynamic_tail.message_time_reminder(
            user_message.sent_at, user_tz,
        )

    # Web/IM 可以在 MCP 工具发现期间预先启动这项独立召回；不提供预计算结果的
    # 调用方仍走相同水位和有效历史规则。
    rag_context = prepared_rag_context
    if rag_context is None:
        rag_context = await _build_rag_context(
            req, effective_history=effective_history, snapshot_text=snapshot_context,
            current_message_id=current_message_id,
        )
    images = images or []
    media = media or []

    session_context = getattr(session, "session_context", None)
    # history 是已经成功持久化的事实；session_context 只作为没有历史事件时
    # 的兼容水位，不能反过来覆盖 history，避免失败 Run 提前推进姿态。
    previous_stance_digest = _history_stance_digest(history)
    if not previous_stance_digest and isinstance(session_context, dict):
        previous_stance_digest = session_context.get("stance_digest")

    current_user = None if resume_interaction else {
        "role": "user",
        "content": prepend_reference_context(
            build_user_content(
                current_text, images, use_anthropic, media=media,
                image_detail=getattr(model_cfg, "image_detail", "auto"),
            ),
            getattr(req, "reference_context", None),
        ),
    }
    current_stance_digest = assembly.stance_digest(stance_text)
    stance_changed = current_stance_digest != (previous_stance_digest or "")
    assembled, turn_batch = assemble_run_area(
        system_prompt=system_prompt, fixed_parts=fixed_parts, history=history_parts,
        message_area=restored_area, render_options=render_options, use_anthropic=use_anthropic,
        stance=stance_text, previous_stance_digest=previous_stance_digest,
        message_time=message_time, current_user=current_user,
        conversation_tail=rag_context["tail"], extra_reminder=extra_reminder,
    )
    if prior_run_parts_start is not None:
        assembled.protected_history_start = (
            assembled.fixed_prefix_size + prior_run_parts_start
        )
    _bind_persisted_user_message(turn_batch, user_message, resume_interaction)
    assembled.append_batch(turn_batch)
    audit.context_layout_audit(
        phase="assembled", session=session, snapshot=snapshot,
        history=effective_history, messages=assembled.provider_projection(),
        fixed_prefix_count=assembled.fixed_prefix_size,
        turn_batch_count=turn_batch.message_count,
        history_stats=history_stats,
    )
    return PreparedRun(
        rag_context=rag_context,
        stance_to_persist=stance_text if stance_changed else None,
        message_area=assembled,
    )
