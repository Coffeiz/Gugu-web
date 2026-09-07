from app.models import ConversationMessage, ConversationSession
from agent.rag.models import IndexDocument, Scope
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


def test_conversation_rag_result_exposes_parent_session_id():
    document = IndexDocument(
        document_id="conversation:469:18995",
        source_type="conversation",
        source_id="18995",
        scope=Scope("user-a"),
        title="你好",
        summary="",
        content="每日快讯+深度轮换+周日周报",
        version="18995",
        metadata={
            "session_id": "469",
            "message_id": 18995,
            "role": "assistant",
            "session_source": "web",
        },
    )

    result = document.as_public_result(1.0)

    assert result["session_id"] == "469"
    assert result["message_id"] == 18995
    assert result["source_id"] == "18995"


async def test_search_conversations_resolves_legacy_message_id_to_session(
    db, user_a, monkeypatch,
):
    session = await _mk(db, ConversationSession(user_id=user_a.id, title="网页对话", source="web"))
    message = await _mk(db, ConversationMessage(
        session_id=session.id, role="assistant", content="每日快讯+深度轮换+周日周报",
    ))

    async def fake_search(*args, **kwargs):
        return {"results": [{
            "source_id": str(message.id),
            "message_id": message.id,
            "title": session.title,
            "session_source": "web",
            "text": "每日快讯+深度轮换+周日周报",
            "role": "assistant",
        }]}

    monkeypatch.setattr("agent.rag.service.search_conversations", fake_search)

    result = await _search_conversations(db, user_a.id, {"query": "周报"})

    assert [item["session_id"] for item in result["matches"]] == [session.id]
