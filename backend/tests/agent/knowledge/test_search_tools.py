from app.models import ConversationMessage, ConversationSession
from agent.rag.models import IndexDocument, Scope
from agent.tools.conversations import _search_conversations


async def _mk(db, obj):
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


async def test_search_conversations_accepts_multiple_keywords(db, user_a, monkeypatch):
    """工具层多关键词契约：queries 列表原样下发，命中按会话聚合。

    worker 自读数据库（load_index_from_database）之后，写入→索引→搜索的跨进程
    全链在单测进程内不可复现（worker 子进程读不到内存 sqlite），那条链由
    worker 侧 TS 测试与 devserver e2e 覆盖；这里只锁工具协议。
    """
    session = await _mk(db, ConversationSession(user_id=user_a.id, title="部署讨论"))
    message = await _mk(db, ConversationMessage(session_id=session.id, role="user", content="上线清单"))

    captured: dict = {}

    async def fake_search(*args, **kwargs):
        captured["queries"] = kwargs.get("queries")
        return {"results": [{
            "source_id": str(message.id),
            "message_id": message.id,
            "title": session.title,
            "session_source": "web",
            "text": "上线清单",
            "role": "user",
        }]}

    monkeypatch.setattr("agent.rag.service.search_conversations", fake_search)

    result = await _search_conversations(db, user_a.id, {"queries": ["部署", "上线"]})

    assert captured["queries"] == ["部署", "上线"]
    assert [item["session_id"] for item in result["matches"]] == [session.id]
    assert result["matches"][0]["match"]["snippet"] == "上线清单"


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
