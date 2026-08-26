"""统一 run 收尾：持久化 canonical turn、裁剪历史并调度 baseline。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Callable


@dataclass(frozen=True)
class FinalizeResult:
    """收尾阶段实际记账的用量。"""

    tokens_in: int
    tokens_out: int


async def finalize_run(
    *,
    session_factory: Callable[[], Any],
    session_id: int,
    user_id: str,
    settings: Any,
    model_cfg: Any,
    rag_context: dict | None,
    messages: list,
    initial_len: int,
    text: str,
    display_timeline: list[dict] | None = None,
    files: list | None,
    tokens_in: int,
    tokens_out: int,
    cache_read: int = 0,
    cache_write: int = 0,
    tools_used: list[str] | None = None,
    context_tokens: int | None = None,
    actual_usage_tokens: int = 0,
    compaction_applied: bool = False,
    session_exists_required: bool = False,
    stance_text: str | None = None,
    user_message_id: int | None = None,
) -> FinalizeResult:
    """用一个契约完成 canonical turn、展示时间线、trim 与 baseline 调度。

    Web/IM 只负责渠道事件和输出清洗；canonical history 与展示时间线分开保存，
    消息结构、配额封顶及 baseline 入口在这里保持一致。
    ``session_exists_required`` 供 Web 删除竞态使用：会话已删除时跳过消息，但仍保留 usage 记账。
    """
    from agent import quota
    from agent.context import assembly, compress_conv
    from agent.context.history import canonicalize_tool_messages
    from app.models import AgentUsage, ConversationMessage, ConversationSession
    from app.core import chat_attach
    from app.services.conversation_retention import trim_session_messages

    async with session_factory() as db:
        session_alive = True
        if session_exists_required:
            from app.models import ConversationSession
            session_alive = await db.get(ConversationSession, session_id) is not None
        if session_alive:
            stance_persisted = False
            if stance_text and user_message_id:
                user_message = await db.get(ConversationMessage, user_message_id)
                if user_message is not None:
                    # 当前用户消息已在生成前写入；把姿态事件排在它之前，保持
                    # provider 首轮的「姿态 → 用户消息」顺序。每次变化都追加，
                    # 不按正文去重；下一轮从 canonical history 稳定恢复。
                    db.add(ConversationMessage(
                        session_id=session_id,
                        role="user",
                        content="",
                        content_json=[{
                            "type": "stance-context",
                            "digest": assembly.stance_digest(stance_text),
                            "text": f"[system-reminder]\n{stance_text}\n[/system-reminder]",
                        }],
                        created_at=user_message.created_at - timedelta(microseconds=1),
                    ))
                    stance_persisted = True
            if stance_persisted:
                session_row = await db.get(ConversationSession, session_id)
                if session_row is not None:
                    context = dict(session_row.session_context or {})
                    context["stance_digest"] = assembly.stance_digest(stance_text)
                    session_row.session_context = context
            for block in (rag_context or {}).get("blocks", []):
                db.add(ConversationMessage(session_id=session_id, role="user", content="", content_json=[block]))
            tool_history = assembly.newly_appended(messages, initial_len)
            for tm in canonicalize_tool_messages(tool_history):
                db.add(ConversationMessage(
                    session_id=session_id,
                    role=tm["role"],
                    content="",
                    content_json=chat_attach.strip_vision_for_history(tm["content"]),
                ))
            if text or files or display_timeline:
                db.add(ConversationMessage(
                    session_id=session_id,
                    role="assistant",
                    content=text,
                    files=files or None,
                    display_timeline=display_timeline or None,
                ))

        cap_in, cap_out = await quota.cap_usage(db, user_id, settings, tokens_in, tokens_out)
        if cap_in or cap_out:
            db.add(AgentUsage(
                user_id=user_id,
                session_id=session_id if session_alive else None,
                tokens_in=cap_in,
                tokens_out=cap_out,
                cache_read=cache_read,
                cache_write=cache_write,
                model=model_cfg.model,
                provider=model_cfg.provider,
                tools_used=tools_used or None,
            ))
        await db.commit()

    await trim_session_messages(session_id)
    compress_conv.schedule_baseline_update(
        session_id,
        user_id,
        settings,
        int(context_tokens or getattr(model_cfg, "context_tokens", settings.ai.context_tokens)),
        actual_usage_tokens=int(actual_usage_tokens or 0),
        compaction_applied=bool(compaction_applied),
    )
    return FinalizeResult(tokens_in=cap_in, tokens_out=cap_out)
