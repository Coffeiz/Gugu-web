"""Knowledge 工具契约：BM25 搜索与 knowledge_id 强一致直读。"""
from zoneinfo import ZoneInfo

import pytest

from agent.knowledge.models import KnowledgeEntry, KnowledgeScope, KnowledgeSource
from agent.knowledge.store import KnowledgeStore
from agent.tools.knowledge import _read_knowledge
from app.services.storage import LocalStorageBackend
from app.core.tz import set_ctx_tz


@pytest.fixture
def knowledge_storage(tmp_path, monkeypatch):
    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("agent.knowledge.store.get_storage", lambda: backend)
    return backend


async def _save(user_id: str, title: str, content: str):
    entry = KnowledgeEntry.create(
        title=title,
        content=content,
        scope=KnowledgeScope(owner_user_id=user_id),
        source=KnowledgeSource("user", label="测试"),
    )
    await KnowledgeStore(user_id).save(entry)
    return entry


@pytest.mark.asyncio
async def test_read_by_id_returns_persisted_full_content(knowledge_storage):
    saved = KnowledgeEntry.create(
        title="部署规范", content="发布前必须跑完 CI 双工作流", topic="运维",
        scope=KnowledgeScope(owner_user_id="user-a"),
        source=KnowledgeSource("user", label="测试"),
    )
    saved.created_at = 1790451656
    saved.updated_at = 1790451656
    set_ctx_tz(ZoneInfo("Asia/Shanghai"))
    await KnowledgeStore("user-a").save(saved)

    result = await _read_knowledge(None, "user-a", {"knowledge_id": saved.id})

    assert result["success"] is True
    assert result["entry"]["content"] == "发布前必须跑完 CI 双工作流"
    assert result["entry"]["title"] == "部署规范"
    assert result["entry"]["knowledge_id"] == saved.id
    assert result["entry"]["created_at"] == "2026-09-27T03:40:56+08:00"
    assert result["entry"]["updated_at"] == "2026-09-27T03:40:56+08:00"


@pytest.mark.asyncio
async def test_keyword_search_uses_owner_scoped_bm25_and_collapses_chunks(
    knowledge_storage, monkeypatch,
):
    captured = {}

    async def search_knowledge(user_id, query, **kwargs):
        captured.update(user_id=user_id, query=query, **kwargs)
        return {
            "has_more": True,
            "results": [
                {
                    "source_id": "knowledge-1", "title": "部署规范", "text": "第一段命中",
                    "score": 0.9, "version": 3,
                },
                {
                    "source_id": "knowledge-1", "title": "部署规范", "text": "第二段命中",
                    "score": 0.8, "version": 3,
                },
                {
                    "source_id": "knowledge-2", "title": "发布流程", "text": "另一条知识",
                    "score": 0.7,
                },
            ],
        }

    monkeypatch.setattr("agent.rag.service.search_knowledge", search_knowledge)

    result = await _read_knowledge(
        "db-session", "user-a", {"keyword": "发布如何回滚", "limit": 4, "scope": "owner"},
    )

    assert captured["user_id"] == "user-a"
    assert captured["query"] == "发布如何回滚"
    assert captured["scope"].owner_user_id == "user-a"
    assert captured["scope"].scope_type == "owner"
    assert (captured["source"], captured["strategy"], captured["mode"]) == (
        "knowledge", "bm25", "tool",
    )
    assert captured["limit"] == 4
    assert captured["db"] == "db-session"
    assert result["strategy"] == "bm25"
    assert result["has_more"] is True
    assert [entry["knowledge_id"] for entry in result["entries"]] == [
        "knowledge-1", "knowledge-2",
    ]
    assert result["entries"][0]["content"] == "第一段命中\n\n第二段命中"
    assert result["entries"][0]["version"] == 3


@pytest.mark.asyncio
async def test_keyword_search_is_scoped_to_the_requesting_user(knowledge_storage, monkeypatch):
    captured_scope = None

    async def search_knowledge(_user_id, _query, **kwargs):
        nonlocal captured_scope
        captured_scope = kwargs["scope"]
        return {"results": [], "has_more": False}

    monkeypatch.setattr("agent.rag.service.search_knowledge", search_knowledge)

    result = await _read_knowledge(None, "user-b", {"keyword": "私有决策"})

    assert result["success"] is True
    assert captured_scope.owner_user_id == "user-b"
    assert captured_scope.scope_type == "owner"


@pytest.mark.asyncio
async def test_missing_query_and_out_of_range_limit_are_rejected_before_search(
    knowledge_storage, monkeypatch,
):
    async def unexpected_search(*_args, **_kwargs):
        pytest.fail("无效工具参数不能发起 BM25 检索")

    monkeypatch.setattr("agent.rag.service.search_knowledge", unexpected_search)

    missing_query = await _read_knowledge(None, "user-a", {})
    invalid_limit = await _read_knowledge(None, "user-a", {"keyword": "部署", "limit": 26})

    assert "keyword" in missing_query["error"]
    assert "limit" in invalid_limit["error"]


@pytest.mark.asyncio
async def test_foreign_id_is_not_readable(knowledge_storage):
    saved = await _save("user-a", "个人策略", "仅 user-a 可见")

    result = await _read_knowledge(None, "user-b", {"knowledge_id": saved.id})

    assert "error" in result
    assert "entry" not in result


@pytest.mark.asyncio
async def test_unknown_id_points_to_keyword_search(knowledge_storage):
    result = await _read_knowledge(None, "user-a", {"knowledge_id": "missing-id"})

    assert "error" in result
    assert "keyword" in result["error"]
