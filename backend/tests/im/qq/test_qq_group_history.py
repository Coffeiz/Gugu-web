"""QQ 群聊普通消息的数据库保留上限。"""

from sqlalchemy import func, select

from agent.im.session import trim_session_messages
from app.models import ConversationMessage, ConversationSession


async def test_qq_group_session_keeps_only_latest_500_messages(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="群聊记录", source="qq")
    db.add(session)
    await db.flush()
    db.add_all([
        ConversationMessage(session_id=session.id, role="user", content=f"消息 {index}")
        for index in range(605)
    ])
    await db.commit()

    await trim_session_messages(session.id)

    count = await db.scalar(
        select(func.count()).select_from(ConversationMessage).where(
            ConversationMessage.session_id == session.id,
        )
    )
    latest = await db.scalar(
        select(ConversationMessage.content)
        .where(ConversationMessage.session_id == session.id)
        .order_by(ConversationMessage.id.desc())
        .limit(1)
    )
    assert count == 500
    assert latest == "消息 604"
