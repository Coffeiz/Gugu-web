"""/new 命令：清空当前会话的对话上下文。"""
from __future__ import annotations

from sqlalchemy import delete, select, update

from agent.commands.help import command_help, is_help_arg
from app.core.tz import now_utc


async def handle(user_id, session_id: int | None, arg: str) -> str:
    if is_help_arg(arg):
        return command_help("new")
    if not session_id:
        return "当前还没有可重置的对话。"

    from agent.security.shell_policy import session_shell_lock
    from app.db import session as db_session
    from app.models import ConversationMessage, ConversationSession, InteractionAction, InteractionPrompt
    from app.services.conversation_cleanup import cleanup_storage_refs, remove_messages_with_attachments

    async with session_shell_lock(session_id):
        async with db_session._SessionLocal() as db:
            session = await db.get(ConversationSession, session_id)
            if session is None or session.user_id != user_id:
                return "当前会话不存在。"

            message_ids = list((await db.execute(
                select(ConversationMessage.id).where(ConversationMessage.session_id == session_id)
            )).scalars().all())
            refs = await remove_messages_with_attachments(db, message_ids, commit=False)

            # 交互提示属于旧 Run 的控制状态，不能在新上下文里继续恢复。
            await db.execute(
                update(InteractionPrompt)
                .where(
                    InteractionPrompt.session_id == session_id,
                    InteractionPrompt.status == "active",
                )
                .values(status="cancelled", resolved_at=now_utc())
            )
            await db.execute(
                update(InteractionAction)
                .where(
                    InteractionAction.prompt_id.in_(
                        select(InteractionPrompt.id).where(
                            InteractionPrompt.session_id == session_id,
                        )
                    ),
                    InteractionAction.status == "pending",
                )
                .values(status="cancelled", consumed_at=now_utc())
            )
            await db.execute(
                delete(ConversationMessage).where(ConversationMessage.session_id == session_id)
            )

            # 保留 workspace_id、用户设置和权限；下次 run 会重新生成业务 snapshot。
            session.summary = ""
            session.baseline_message_id = 0
            session.baseline_message_hash = None
            session.session_context = None
            session.session_info_hash = None
            session.snapshot_hash = None
            session.snapshot_expires_at = None
            session.context_epoch = (session.context_epoch or 0) + 1
            session.history_provider = None
            session.history_api_format = None
            await db.commit()
            await cleanup_storage_refs(refs)

    return "已开启新对话，旧的对话上下文已清空。工作区绑定和账号设置保持不变。"
