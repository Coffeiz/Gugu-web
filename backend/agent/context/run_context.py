"""统一构造一次 LLM run 的上下文与消息。

Web、IM 和定时任务可以保留不同的传输协议，但不应分别维护消息顺序、RAG
尾部和 provider 清洗逻辑。该模块只负责组装，不负责发送、持久化或 baseline。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent.context import audit, compress_conv, assembly
from agent.context import session_snapshot
from agent.context.history import build_history_parts
from agent.security import sanitize
from app.core.chat_attach import build_user_content


@dataclass
class PreparedRun:
    """供 LLMRunner 消费的已组装上下文。"""

    use_anthropic: bool
    anthr_messages: Any
    anthr_initial_len: int
    oa_messages: Any
    oa_initial_len: int
    rag_context: dict
    stance_to_persist: str | None


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
) -> PreparedRun:
    """按固定顺序组装消息，并返回本轮 RAG 持久化信息。"""
    fixed_parts = compress_conv.fixed_context_parts(snapshot_injection)
    # 兼容曾经误写入 canonical history 的动态 now/message-time 行。数据库旧行可以
    # 留给后续压缩/清理，但运行时只认真实 user row 的 sent_at，避免重复时间块污染
    # provider 前缀和 RAG 输入。
    effective_history = [
        message for message in history
        if not _is_legacy_persisted_time_context(message)
    ]
    history_parts = build_history_parts(
        effective_history, req, use_anthropic=use_anthropic, user_tz=user_tz,
        strip_thinking=strip_thinking,
    )
    message_time = None
    if user_message is not None and not resume_interaction:
        message_time = session_snapshot.message_time_reminder(user_message.sent_at, user_tz)

    # 当前用户消息在进入 Agent 前已经落库。自动 conversation RAG 必须以它的 id
    # 作为排他水位，只允许召回本轮之前的消息；ContextVar 会随自动召回创建的
    # asyncio task 一起复制，因此即使超时后任务后台收尾，也不会串到其它请求。
    from agent.rag import context as rag_request_context
    from agent.rag.injection import build_automatic_rag_context
    current_message_id = (
        getattr(user_message, "id", None)
        if user_message is not None and not resume_interaction else None
    )
    watermark_token = rag_request_context.set_conversation_before_message_id(
        current_message_id
    )
    try:
        rag_context = await build_automatic_rag_context(
            req, req.message, history=effective_history, snapshot_text=snapshot_context,
        )
    finally:
        rag_request_context.reset_conversation_before_message_id(watermark_token)
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
        "content": build_user_content(
            current_text, images, use_anthropic, media=media,
            image_detail=getattr(model_cfg, "vision_detail", "auto"),
        ),
    }
    current_stance_digest = assembly.stance_digest(stance_text)
    stance_changed = current_stance_digest != (previous_stance_digest or "")
    if use_anthropic:
        assembled = assembly.assemble(
            fixed_parts=fixed_parts,
            history=history_parts,
            system_text=system_prompt,
        )
        turn_batch, current_stance_digest = assembly.assemble_turn(
            stance=stance_text,
            previous_stance_digest=previous_stance_digest,
            message_time=message_time,
            current_user=current_user,
            conversation_tail=rag_context["tail"],
            extra_reminder=extra_reminder,
        )
        assembled.append_batch(turn_batch)
        before = len(assembled.conversation)
        fixed_boundary = assembled.fixed_prefix_size
        merged_cross_segment = bool(
            fixed_boundary > 0
            and fixed_boundary < before
            and assembled.conversation[fixed_boundary - 1].get("role")
            == assembled.conversation[fixed_boundary].get("role")
        )
        clean = sanitize.sanitize_messages(assembled.conversation)
        merged_cross_segment = merged_cross_segment and len(clean) < before
        assembled.replace_conversation(clean)
        audit.context_layout_audit(
            phase="assembled", session=session, snapshot=snapshot,
            history=history, messages=assembled,
            fixed_prefix_count=assembled.fixed_prefix_size,
            turn_batch_count=len(turn_batch.messages),
            history_stats=history_stats,
            sanitize_before_count=before,
            sanitize_after_count=len(assembled.conversation),
            merged_cross_segment=merged_cross_segment,
        )
        return PreparedRun(
            use_anthropic=True, anthr_messages=assembled,
            anthr_initial_len=len(assembled),
            oa_messages=[], oa_initial_len=0, rag_context=rag_context,
            stance_to_persist=stance_text if stance_changed else None,
        )

    assembled = assembly.assemble(
        fixed_parts=[{"role": "system", "content": system_prompt}] + fixed_parts,
        history=history_parts,
        system_text=system_prompt,
    )
    turn_batch, current_stance_digest = assembly.assemble_turn(
        stance=stance_text,
        previous_stance_digest=previous_stance_digest,
        message_time=message_time,
        current_user=current_user,
        conversation_tail=rag_context["tail"],
        extra_reminder=extra_reminder,
    )
    assembled.append_batch(turn_batch)
    audit.context_layout_audit(
        phase="assembled", session=session, snapshot=snapshot,
        history=history, messages=assembled,
        fixed_prefix_count=getattr(assembled, "fixed_prefix_size", None),
        turn_batch_count=len(turn_batch.messages),
        history_stats=history_stats,
    )
    return PreparedRun(
        use_anthropic=False, anthr_messages=[], anthr_initial_len=0,
        oa_messages=assembled,
        oa_initial_len=len(assembled),
        rag_context=rag_context,
        stance_to_persist=stance_text if stance_changed else None,
    )
