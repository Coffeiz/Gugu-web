"""会话消息及其聊天附件的生命周期清理。"""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import delete, select

from app.core import chat_attach
from app.models import ChatAttachment, ConversationMessage


StorageRef = tuple[object, str]


async def _storage_refs_for_messages(db, message_ids: Iterable[int]) -> list[StorageRef]:
    ids = list(dict.fromkeys(message_ids))
    if not ids:
        return []
    rows = await db.execute(
        select(ChatAttachment.user_id, ChatAttachment.storage_key).where(
            ChatAttachment.message_id.in_(ids)
        )
    )
    return list(dict.fromkeys(rows.all()))


async def remove_messages_with_attachments(
    db,
    message_ids: Iterable[int],
    *,
    commit: bool = True,
) -> list[StorageRef]:
    """删除消息 ownership 和消息记录，并在提交后清理物理附件。

    ``commit=False`` 供删除整个 session 时把消息、附件和 session 放进同一个
    DB 事务；调用方必须在 commit 成功后调用 ``cleanup_storage_refs``。
    """
    ids = list(dict.fromkeys(message_ids))
    refs = await _storage_refs_for_messages(db, ids)
    if ids:
        await db.execute(delete(ChatAttachment).where(ChatAttachment.message_id.in_(ids)))
        await db.execute(delete(ConversationMessage).where(ConversationMessage.id.in_(ids)))
    if commit:
        await db.commit()
        await cleanup_storage_refs(refs)
    return refs


async def cleanup_storage_refs(refs: Iterable[StorageRef]) -> None:
    """在 DB commit 成功后按引用计数尽力删除物理附件。"""
    for user_id, storage_key in dict.fromkeys(refs):
        try:
            await chat_attach.try_delete_storage_if_unreferenced(user_id, storage_key)
        except Exception as exc:
            from app.core.redaction import diag_log

            diag_log("app.services.conversation_cleanup.storage", exc)


async def remove_session_with_attachments(db, session) -> None:
    """在一个 DB 事务内删除 session、消息 ownership 和消息记录。"""
    message_ids = list(
        (await db.execute(
            select(ConversationMessage.id).where(
                ConversationMessage.session_id == session.id
            )
        )).scalars().all()
    )
    refs = await remove_messages_with_attachments(db, message_ids, commit=False)
    await db.delete(session)
    await db.commit()
    await cleanup_storage_refs(refs)
