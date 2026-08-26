import pytest
from types import SimpleNamespace

from agent.rag.injection import (
    build_history_message,
    build_passive_history_message,
    render_history_context,
    should_passively_recall,
)


@pytest.mark.asyncio
async def test_memory_scope_adapter_renders_profile_dict_entries(monkeypatch):
    from agent.rag.adapters.memory import MemoryAdapter

    async def fake_preview(_scope):
        return {
            "profile": [{"type": "preference", "text": "偏好简洁回复"}],
            "summary": {"text": "正在整理 RAG"},
            "daily": ["2026-08-24 完成测试"],
            "memory": "## 记录长期记忆：RAG\n已完成适配",
        }

    monkeypatch.setattr("agent.rag.adapters.memory.preview_scope", fake_preview)
    adapter = MemoryAdapter("owner")

    from agent.rag.models import Scope
    documents = await adapter.build_documents(scope=Scope(
        owner_user_id="owner", platform="qq", bot_id="bot", group_id="group",
        scope_type="group", scope_id="group",
    ))

    texts = [document.content for document in documents]
    assert any("偏好简洁回复" in text for text in texts)
    assert any("正在整理 RAG" in text for text in texts)


@pytest.mark.asyncio
async def test_memory_scope_adapter_includes_member_event_memory(monkeypatch):
    from agent.rag.adapters.memory import MemoryAdapter
    from agent.rag.models import Scope

    async def fake_preview(_scope):
        return {
            "profile": [],
            "pattern": [],
            "summary": {},
            "memory": "## 记录长期记忆：成员事件\n\n已确认负责测试。",
        }

    monkeypatch.setattr("agent.rag.adapters.memory.preview_scope", fake_preview)
    documents = await MemoryAdapter("owner").build_documents(scope=Scope(
        owner_user_id="owner", platform="qq", bot_id="bot", group_id="group",
        scope_type="member", scope_id="group:member-1",
    ))

    assert any(document.source_id == "memory" and "负责测试" in document.content
               for document in documents)


def test_rag_history_injection_hides_internal_identity_fields():
    result = {
        "source": "memory",
        "title": "缓存记忆",
        "text": "之前验证过跨轮缓存命中率。",
        "score": 9.5,
        "content_hash": "secret-hash-must-not-be-rendered",
        "chunk_id": "secret-chunk",
        "citation": {"source_type": "memory", "title": "缓存记忆"},
    }

    message = build_history_message("缓存", [result])

    assert message["role"] == "user"
    assert "跨轮缓存命中率" in message["content"]
    assert "secret-hash" not in message["content"]
    assert "secret-chunk" not in message["content"]
    assert "9.5" not in message["content"]


def test_empty_rag_results_do_not_create_history_message():
    assert build_history_message("没有结果", []) is None
    assert "knowledge-context" in render_history_context("没有结果", [])


def test_passive_recall_only_targets_historical_questions():
    assert should_passively_recall("之前我们讨论过缓存吗")
    assert should_passively_recall("What did we discuss before?")
    assert not should_passively_recall("现在天气怎么样")


@pytest.mark.asyncio
async def test_passive_recall_uses_same_knowledge_service(monkeypatch):
    from agent.rag import service

    async def fake_search(*args, **kwargs):
        assert kwargs["strategy"] == "bm25"
        return {"results": [{"title": "记忆", "text": "之前讨论过稳定缓存。"}]}

    monkeypatch.setattr(service, "search_knowledge", fake_search)

    message = await build_passive_history_message("user-a", "之前讨论过缓存吗")

    assert message["role"] == "user"
    assert "稳定缓存" in message["content"]


@pytest.mark.asyncio
async def test_automatic_recall_uses_group_then_member_scope_and_deduplicates(monkeypatch):
    from agent.rag import injection

    calls = []

    async def fake_search(user_id, query, **kwargs):
        calls.append(kwargs["scope"])
        scopes = kwargs["scope"]
        assert isinstance(scopes, list)
        label = "群组+群友"
        return {"candidate_count": 1, "results": [{
            "text": f"{label}记忆：项目已经确认。", "title": label,
            "content_hash": f"hash-{label}",
            "citation": {"source_type": "memory", "title": label},
        }]}

    monkeypatch.setattr("agent.rag.service.search_knowledge", fake_search)
    request = SimpleNamespace(
        user_id="owner", source="qq", chat_id="group-1", platform_bot_id="bot-1",
        platform_user_id="member-1", im_role="member",
        im_group_memory_enabled=True, im_member_memory_enabled=True,
    )
    result = await injection.build_automatic_rag_context(request, "项目", history=[])

    assert len(calls) == 1
    assert [scope.scope_type for scope in calls[0]] == ["group", "member"]
    assert result["tail"][0]["content"][0]["type"] == "knowledge-context"
    assert "[group-rag+group-member-rag]" in result["tail"][0]["content"][0]["text"]
    assert len(result["blocks"]) == 1


@pytest.mark.asyncio
async def test_automatic_recall_respects_global_rag_switch(monkeypatch):
    from agent.rag import injection

    monkeypatch.setattr(
        "app.core.config.get_settings",
        lambda: SimpleNamespace(search=SimpleNamespace(rag_enabled=False)),
    )
    request = SimpleNamespace(user_id="owner", source="web", chat_id=None)

    result = await injection.build_automatic_rag_context(request, "之前的缓存", history=[])

    assert result["tail"] == []
    assert result["blocks"] == []
    assert result["injected"] is False
    assert result["disabled"] is True


@pytest.mark.asyncio
async def test_automatic_recall_does_not_repeat_persisted_hash(monkeypatch):
    from agent.rag import injection

    async def fake_search(*args, **kwargs):
        return {"candidate_count": 1, "results": [{
            "text": "稳定记忆", "content_hash": "already-there",
            "citation": {"source_type": "memory", "title": "记忆"},
        }]}

    monkeypatch.setattr("agent.rag.service.search_knowledge", fake_search)
    request = SimpleNamespace(user_id="owner", source="web", chat_id=None)
    history = [SimpleNamespace(content_json=[{
        "type": "knowledge-context", "content_hashes": ["already-there"],
        "content_hash": "block-hash", "text": "旧召回",
    }])]

    result = await injection.build_automatic_rag_context(request, "稳定", history=history)

    assert result["tail"] == []
    assert result["blocks"] == []


@pytest.mark.asyncio
async def test_automatic_recall_timeout_does_not_block_agent(monkeypatch):
    from agent.rag import injection
    import asyncio
    finished = asyncio.Event()

    async def slow_search(*args, **kwargs):
        await asyncio.sleep(0.02)
        finished.set()
        return {"candidate_count": 1, "results": []}

    monkeypatch.setattr("agent.rag.service.search_knowledge", slow_search)
    monkeypatch.setattr(injection, "AUTO_RECALL_TIMEOUT_SECONDS", 0.001)
    request = SimpleNamespace(user_id="owner", source="web", chat_id=None)

    result = await injection.build_automatic_rag_context(request, "缓存", history=[])

    assert result["tail"] == []
    assert result["blocks"] == []
    assert result["scope_hits"] == [{
        "scope": "owner-rag", "candidate_count": 0, "hit_count": 0, "timeout": True,
    }]
    await asyncio.wait_for(finished.wait(), timeout=0.1)
