from __future__ import annotations

import pytest

from agent.knowledge.models import KnowledgeEntry, KnowledgeScope, KnowledgeSource
from agent.knowledge.store import KnowledgeStore
from app.services.storage import LocalStorageBackend


@pytest.fixture
def knowledge_storage(tmp_path, monkeypatch):
    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("agent.knowledge.store.get_storage", lambda: backend)
    return backend


@pytest.mark.asyncio
async def test_knowledge_store_upserts_same_topic_and_increments_version(knowledge_storage):
    store = KnowledgeStore("user-a")
    scope = KnowledgeScope(owner_user_id="user-a")
    first = KnowledgeEntry.create(
        title="消息协议", content="第一版规则", topic="协议",
        scope=scope, source=KnowledgeSource("user", label="用户说明"),
    )
    await store.save(first)
    second = KnowledgeEntry.create(
        title="消息协议", content="第二版规则", topic="协议",
        scope=scope, source=KnowledgeSource("user", label="用户修正"),
    )
    await store.save(second)

    entries = await store.list()
    assert len(entries) == 1
    assert entries[0].content == "第二版规则"
    assert entries[0].version == 2
    assert entries[0].id == first.id
    assert len(entries[0].history) == 1
    assert entries[0].history[0]["content"] == "第一版规则"


@pytest.mark.asyncio
async def test_knowledge_store_keeps_cross_source_conflict_visible(knowledge_storage):
    store = KnowledgeStore("user-a")
    original = KnowledgeEntry.create(
        title="部署规则", content="只使用 Linux", topic="部署",
        scope=KnowledgeScope(owner_user_id="user-a"),
        source=KnowledgeSource("user"),
    )
    await store.save(original)
    conflict = KnowledgeEntry.create(
        title="部署规则", content="只使用 Windows", topic="部署",
        scope=KnowledgeScope(owner_user_id="user-a"),
        source=KnowledgeSource("web", label="网页资料"),
    )
    saved = await store.save(conflict)

    entries = await store.list()
    assert len(entries) == 2
    assert saved.confidence == "conflict"
    assert saved.parent_id == original.id


@pytest.mark.asyncio
async def test_knowledge_store_does_not_cross_owner_or_group_scope(knowledge_storage):
    store = KnowledgeStore("user-a")
    await store.save(KnowledgeEntry.create(
        title="私人规则", content="仅 owner 可见", topic="权限",
        scope=KnowledgeScope(owner_user_id="user-a"),
        source=KnowledgeSource("user"),
    ))
    await store.save(KnowledgeEntry.create(
        title="群规则", content="仅群可见", topic="权限",
        scope=KnowledgeScope(owner_user_id="user-a", type="group", group_id="g1", scope_id="g1"),
        source=KnowledgeSource("user"),
    ))

    assert len(await store.list(scope=KnowledgeScope(owner_user_id="user-a"))) == 1
    assert len(await store.list(scope=KnowledgeScope(
        owner_user_id="user-a", type="group", group_id="g1", scope_id="g1",
    ))) == 1
    assert await KnowledgeStore("user-b").list() == []


@pytest.mark.asyncio
async def test_knowledge_adapter_exposes_source_and_confidence(knowledge_storage):
    from agent.rag.adapters.knowledge import KnowledgeAdapter
    from agent.rag.models import Scope

    await KnowledgeStore("user-a").save(KnowledgeEntry.create(
        title="项目协议", content="使用 JSON 消息", topic="项目规则",
        scope=KnowledgeScope(owner_user_id="user-a"),
        source=KnowledgeSource("web", ref="https://example.invalid/doc", label="协议文档"),
        confidence="probable",
    ))
    documents = await KnowledgeAdapter("user-a").build_documents(
        scope=Scope(owner_user_id="user-a"),
    )
    assert len(documents) == 1
    assert documents[0].source_type == "knowledge"
    public = documents[0].as_public_result(0.8)
    assert public["confidence"] == "probable"
    assert public["source_label"] == "协议文档"


@pytest.mark.asyncio
async def test_search_memory_accepts_knowledge_source(monkeypatch, knowledge_storage):
    from agent.rag import service

    async def fake_search(*args, **kwargs):
        from agent.rag.retriever import RetrievalBatch
        return RetrievalBatch(source_type="knowledge")

    monkeypatch.setattr(service.KnowledgeAdapter, "retrieve", fake_search)
    result = await service.search_memory("user-a", "项目协议", source="knowledge")
    assert result["results"] == []


@pytest.mark.asyncio
async def test_knowledge_delete_is_tombstoned_and_removed_from_active_results(knowledge_storage):
    store = KnowledgeStore("user-a")
    entry = KnowledgeEntry.create(
        title="待删除", content="旧规则", topic="删除测试",
        scope=KnowledgeScope(owner_user_id="user-a"),
        source=KnowledgeSource("user"),
    )
    await store.save(entry)

    assert await store.delete(entry.id) is True
    assert await store.list() == []
    history = await store.list(active_only=False)
    assert len(history) == 1
    assert history[0].active is False


@pytest.mark.asyncio
async def test_knowledge_store_uses_one_markdown_file_per_entry(knowledge_storage):
    store = KnowledgeStore("user-a")
    entry = KnowledgeEntry.create(
        title="文件知识", content="短知识", topic="文件",
        scope=KnowledgeScope(owner_user_id="user-a"),
        source=KnowledgeSource("file", ref="file:1"),
    )
    await store.save(entry)

    keys = await knowledge_storage.list_keys()
    assert keys == [f"user-a/.agent/knowledge/entries/{entry.id}.md"]
    raw = await knowledge_storage.get(keys[0])
    assert raw.startswith(b"---\n")
    assert "短知识".encode() in raw


@pytest.mark.asyncio
async def test_knowledge_store_rejects_content_over_1000_characters(knowledge_storage):
    store = KnowledgeStore("user-a")
    entry = KnowledgeEntry.create(
        title="过长知识", content="x" * 1001, topic="长度",
        scope=KnowledgeScope(owner_user_id="user-a"),
        source=KnowledgeSource("user"),
    )
    with pytest.raises(ValueError, match="content.*1000"):
        await store.save(entry)


def test_knowledge_reflection_limits_candidates_and_validates_operations():
    from agent.knowledge.reflection import build_request, candidate_request, normalize_operations

    request = build_request("用户规则", "已收到", [{"source_id": str(index), "text": "x"} for index in range(8)])
    import json
    assert len(json.loads(request)["knowledge_candidates"]) == 5
    operations = normalize_operations({"operations": [
        {"action": "create", "title": "规则", "content": "内容", "confidence": "bad"},
        {"action": "update", "title": "", "content": "缺标题"},
        {"action": "ignore", "reason": "重复"},
    ]})
    assert len(operations) == 2
    assert operations[0]["certainty"] == "probable"
    assert candidate_request({"knowledge_candidate": {"should_reflect": True, "query": "规则"}}) == (True, "规则")
    assert candidate_request({"knowledge_candidate": {"should_reflect": "true", "query": "规则"}}) == (False, "")


@pytest.mark.asyncio
async def test_knowledge_reflection_runs_after_candidate_and_downgrades_automatic(
    monkeypatch, knowledge_storage):
    from types import SimpleNamespace
    from agent.knowledge.reflection import reflect_if_candidate

    async def fake_search(*args, **kwargs):
        return {"results": [{"source_id": "old", "title": "旧规则", "text": "旧内容"}]}

    async def fake_complete(*args, **kwargs):
        return {"operations": [{
            "action": "create", "title": "新规则", "topic": "规则",
            "content": "新内容", "confidence": "confirmed",
        }]}

    monkeypatch.setattr("agent.rag.service.search_knowledge", fake_search)
    monkeypatch.setattr("agent.context.provider_runner.complete_json", fake_complete)
    settings = SimpleNamespace(ai=SimpleNamespace(max_tokens=900))

    saved = await reflect_if_candidate(
        "user-a", "请记住新规则", "收到", settings, "规则",
    )
    assert saved == 1
    entries = await KnowledgeStore("user-a").list()
    assert entries[0].confidence == "probable"
    assert entries[0].source.type == "conversation"


@pytest.mark.asyncio
async def test_knowledge_reflection_explicit_save_can_be_confirmed(monkeypatch, knowledge_storage):
    from types import SimpleNamespace
    from agent.knowledge.reflection import reflect_if_candidate

    async def fake_search(*args, **kwargs):
        return {"results": []}

    async def fake_complete(*args, **kwargs):
        return {"operations": [{
            "action": "create", "title": "明确规则", "topic": "规则",
            "content": "明确内容", "confidence": "confirmed",
        }]}

    monkeypatch.setattr("agent.rag.service.search_knowledge", fake_search)
    monkeypatch.setattr("agent.context.provider_runner.complete_json", fake_complete)
    settings = SimpleNamespace(ai=SimpleNamespace(max_tokens=900))

    await reflect_if_candidate(
        "user-a", "保存到知识库", "收到", settings, "规则", save_mode="explicit",
    )
    entries = await KnowledgeStore("user-a").list()
    assert entries[0].confidence == "confirmed"
    assert entries[0].source.type == "user"


@pytest.mark.asyncio
async def test_knowledge_reflection_conflict_keeps_parent_and_new_id(monkeypatch, knowledge_storage):
    from types import SimpleNamespace
    from agent.knowledge.reflection import reflect_if_candidate

    original = KnowledgeEntry.create(
        title="规则", content="旧内容", topic="规则",
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("user"),
    )
    await KnowledgeStore("user-a").save(original)

    async def fake_search(*args, **kwargs):
        return {"results": [original.to_dict()]}

    async def fake_complete(*args, **kwargs):
        return {"operations": [{
            "action": "conflict", "target_id": original.id,
            "title": "规则", "topic": "规则", "content": "新冲突内容",
            "certainty": "probable",
        }]}

    monkeypatch.setattr("agent.rag.service.search_knowledge", fake_search)
    monkeypatch.setattr("agent.context.provider_runner.complete_json", fake_complete)
    await reflect_if_candidate(
        "user-a", "发现另一种规则", "收到", SimpleNamespace(ai=SimpleNamespace(max_tokens=900)), "规则",
    )
    entries = await KnowledgeStore("user-a").list()
    conflict = next(item for item in entries if item.parent_id == original.id)
    assert conflict.id != original.id
    assert conflict.confidence == "conflict"
