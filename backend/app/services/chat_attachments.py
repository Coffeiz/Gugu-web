"""聊天暂存附件的用户态生命周期服务。"""
from __future__ import annotations

from sqlalchemy import delete, select

from app.core import chat_attach
from app.models import ChatAttachment, ConversationMessage, ConversationSession


class DraftAttachmentNotFound(LookupError):
    """指定用户没有该暂存附件。"""


class DraftAttachmentAlreadyUsed(RuntimeError):
    """附件已从草稿态转为消息附件，不能按草稿清理。"""


async def is_current_group_session_attachment(
    db,
    user_id,
    attach_id: str,
    *,
    session_id: int,
    platform: str,
    bot_id: str,
    chat_id: str,
) -> bool:
    """确认附件属于当前用户、当前 IM 群及其当前会话的已发送消息。"""
    if not session_id or not platform or not bot_id or not chat_id:
        return False
    linked_session_id = await db.scalar(
        select(ConversationSession.id)
        .join(ConversationMessage, ConversationMessage.session_id == ConversationSession.id)
        .join(ChatAttachment, ChatAttachment.message_id == ConversationMessage.id)
        .where(
            ChatAttachment.user_id == user_id,
            ChatAttachment.attach_id == attach_id,
            ChatAttachment.state == "attached",
            ConversationSession.id == int(session_id),
            ConversationSession.user_id == user_id,
            ConversationSession.source == platform,
            ConversationSession.bot_id == bot_id,
            ConversationSession.chat_id == chat_id,
            ConversationSession.chat_type == "group",
        )
    )
    return linked_session_id is not None


async def delete_draft_attachment(db, user_id, attach_id: str) -> None:
    """仅删除当前用户仍处于 draft 的附件，并在提交后清理未引用字节。"""
    storage_key = await db.scalar(
        select(ChatAttachment.storage_key).where(
            ChatAttachment.user_id == user_id,
            ChatAttachment.attach_id == attach_id,
        )
    )
    if storage_key is None:
        raise DraftAttachmentNotFound

    result = await db.execute(
        delete(ChatAttachment).where(
            ChatAttachment.user_id == user_id,
            ChatAttachment.attach_id == attach_id,
            ChatAttachment.state == "draft",
        )
    )
    if result.rowcount != 1:
        await db.rollback()
        raise DraftAttachmentAlreadyUsed

    await db.commit()
    await chat_attach.try_delete_storage_if_unreferenced(user_id, storage_key)
