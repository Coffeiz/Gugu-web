from app.models import ConversationMessage, ConversationSession
from agent.tools.conversations import _search_conversations


async def _mk(db, obj):
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


async def test_search_conversations_accepts_multiple_keywords(db, user_a):
    session = await _mk(db, ConversationSession(user_id=user_a.id, title="部署讨论"))
    await _mk(db, ConversationMessage(session_id=session.id, role="user", content="上线清单"))

    result = await _search_conversations(db, user_a.id, {"queries": ["部署", "上线"]})

    assert [item["session_id"] for item in result["matches"]] == [session.id]
