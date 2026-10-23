"""聊天暂存附件的用户态生命周期服务。"""
from __future__ import annotations

from sqlalchemy import delete, select

from app.core import chat_attach
from app.models import ChatAttachment


class DraftAttachmentNotFound(LookupError):
    """指定用户没有该暂存附件。"""


class DraftAttachmentAlreadyUsed(RuntimeError):
    """附件已从草稿态转为消息附件，不能按草稿清理。"""


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
