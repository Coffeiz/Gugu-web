"""会话消息的事务级追加序号。"""
from __future__ import annotations

from collections import defaultdict

from sqlalchemy import event, update
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value


def register_conversation_order_listener() -> None:
    """为所有 ORM 新消息分配会话内连续序号，避免写入入口漏标。"""

    @event.listens_for(Session, "before_flush")
    def assign_conversation_sequences(session, _flush_context, _instances) -> None:
        from app.models import ConversationMessage, ConversationSession

        pending_messages = [
            row for row in session.new
            if isinstance(row, ConversationMessage) and row.conversation_seq is None
        ]
        if not pending_messages:
            return

        pending_sessions = {
            id(row): row for row in session.new
            if isinstance(row, ConversationSession)
        }
        new_session_messages: dict[int, list] = defaultdict(list)
        existing_session_messages: dict[int, list] = defaultdict(list)
        for message in pending_messages:
            related_session = message.session
            if related_session is not None and id(related_session) in pending_sessions:
                new_session_messages[id(related_session)].append(message)
                continue
            session_id = message.session_id or getattr(related_session, "id", None)
            if session_id is None:
                raise ValueError("新会话消息必须关联一个已持久化会话")
            existing_session_messages[int(session_id)].append(message)

        for session_key, messages in new_session_messages.items():
            conversation = pending_sessions[session_key]
            sequence = int(conversation.last_message_seq or 0)
            for message in messages:
                sequence += 1
                message.conversation_seq = sequence
            conversation.last_message_seq = sequence

        for session_id, messages in existing_session_messages.items():
            connection = session.connection()
            result = connection.execute(
                update(ConversationSession.__table__)
                .where(ConversationSession.id == session_id)
                .values(last_message_seq=ConversationSession.last_message_seq + len(messages))
                .returning(ConversationSession.last_message_seq)
            )
            end_sequence = result.scalar_one_or_none()
            if end_sequence is None:
                raise ValueError("会话消息序号分配失败")
            first_sequence = int(end_sequence) - len(messages) + 1
            for offset, message in enumerate(messages):
                message.conversation_seq = first_sequence + offset
            for identity in session.identity_map.values():
                if isinstance(identity, ConversationSession) and identity.id == session_id:
                    set_committed_value(identity, "last_message_seq", int(end_sequence))
                    break


async def reserve_conversation_sequence(db, session_id: int) -> int:
    """为已持久化会话中的既有占位消息预留一个新的终态序号。"""
    from app.models import ConversationSession

    await db.flush()
    result = await db.execute(
        update(ConversationSession)
        .where(ConversationSession.id == session_id)
        .values(last_message_seq=ConversationSession.last_message_seq + 1)
        .returning(ConversationSession.last_message_seq)
    )
    sequence = result.scalar_one_or_none()
    if sequence is None:
        raise ValueError("会话消息序号分配失败")
    for identity in db.sync_session.identity_map.values():
        if isinstance(identity, ConversationSession) and identity.id == session_id:
            set_committed_value(identity, "last_message_seq", int(sequence))
            break
    return int(sequence)
