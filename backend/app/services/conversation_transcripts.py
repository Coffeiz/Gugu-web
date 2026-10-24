"""聊天语音识别结果的消息级持久化。"""
from __future__ import annotations

from sqlalchemy import select

from app.models import ConversationMessage, ConversationSession


async def save_voice_transcript(
    db,
    *,
    user_id,
    session_id: int,
    message_id: int,
    transcript: str | None,
    status: str,
) -> list[dict] | None:
    """将单条消息的语音识别结果写入对应附件卡片。

    转写放在消息 ``files`` JSON 中，因此不增加 schema/migration，且历史清理
    删除消息时会一并删除转写。用户和会话条件同时校验，防止跨账户更新。
    多段音频按一条消息聚合转写，结果记录在首个非引用音频卡片上。
    """
    if status not in {"completed", "empty", "failed"}:
        raise ValueError("invalid transcript status")
    result = await db.execute(
        select(ConversationMessage).join(
            ConversationSession,
            ConversationSession.id == ConversationMessage.session_id,
        ).where(
            ConversationMessage.id == message_id,
            ConversationMessage.session_id == session_id,
            ConversationMessage.role == "user",
            ConversationSession.user_id == user_id,
        )
    )
    message = result.scalars().first()
    if message is None or not isinstance(message.files, list):
        return None

    files = [dict(item) if isinstance(item, dict) else item for item in message.files]
    card = next((item for item in files if isinstance(item, dict)
                 and not item.get("quoted") and item.get("kind") == "voice"), None)
    if card is None:
        return None
    card["transcript_status"] = status
    card["transcript_scope"] = "message"
    if status == "completed" and transcript and transcript.strip():
        card["transcript"] = transcript.strip()
    else:
        card.pop("transcript", None)
    message.files = files
    await db.commit()
    return files


async def publish_voice_transcript_update(
    user_id,
    *,
    session_id: int,
    message_id: int,
    files: list[dict],
) -> None:
    """向该用户的其他会话窗口发送轻量消息更新，不触发历史整段重载。"""
    from app.core.events import publish

    await publish(
        user_id,
        "sessions",
        operation="update",
        entity_id=session_id,
        event_payload={"message_update": {"message_id": message_id, "files": files}},
    )
