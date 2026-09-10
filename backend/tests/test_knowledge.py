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
async def test_knowledge_store_normalizes_and_roundtrips_at_most_ten_keywords(knowledge_storage):
    store = KnowledgeStore("user-a")
    entry = KnowledgeEntry.create(
        title="关键词规则", content="用于检索", topic="检索",
        keywords=[" RAG ", "rag", *[f"词语{i}" for i in range(12)]],
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("user"),
    )
    await store.save(entry)

    saved = (await store.list())[0]
    assert len(saved.keywords) == 10
    assert saved.keywords[0] == "RAG"
    assert saved.keywords.count("rag") == 0
    assert (await store.list())[0].keywords == saved.keywords


@pytest.mark.asyncio
async def test_knowledge_store_updates_keywords_without_content_change(knowledge_storage):
    store = KnowledgeStore("user-a")
    original = KnowledgeEntry.create(
        title="脚本规则", content="使用受控执行方式", topic="工具",
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("conversation"),
    )
    await store.save(original)
    enriched = KnowledgeEntry.create(
        title="脚本规则", content="使用受控执行方式", topic="工具",
        keywords=["run_script", "脚本工具"],
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("conversation"),
    )

    saved = await store.save(enriched)

    assert saved.id == original.id
    assert saved.version == 2
    assert saved.keywords == ["run_script", "脚本工具"]
    assert (await store.list())[0].keywords == saved.keywords


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
async def test_knowledge_adapter_makes_keywords_searchable(knowledge_storage):
    from agent.rag.adapters.knowledge import KnowledgeAdapter
    from agent.rag.models import Scope

    await KnowledgeStore("user-a").save(KnowledgeEntry.create(
        title="脚本执行", content="脚本应使用受控执行方式。", topic="工具经验",
        keywords=["run_script", "脚本工具"],
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("conversation"),
    ))

    document = (await KnowledgeAdapter("user-a").build_documents(
        scope=Scope(owner_user_id="user-a"),
    ))[0]
    assert "关键词：run_script、脚本工具" in document.summary
    assert document.metadata["keywords"] == "run_script、脚本工具"
    assert ":k" in document.version


@pytest.mark.asyncio
async def test_search_memory_accepts_knowledge_source(knowledge_storage):
    from agent.rag import service
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
async def test_knowledge_store_rejects_content_over_3000_characters(knowledge_storage):
    store = KnowledgeStore("user-a")
    entry = KnowledgeEntry.create(
        title="过长知识", content="x" * 3001, topic="长度",
        scope=KnowledgeScope(owner_user_id="user-a"),
        source=KnowledgeSource("user"),
    )
    with pytest.raises(ValueError, match="content.*3000"):
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


def test_knowledge_reflection_prompt_covers_tool_and_person_knowledge():
    from agent.knowledge.reflection import load_prompt

    prompt = load_prompt()
    assert "工具使用与效率经验" in prompt
    assert "人物与关系知识" in prompt
    assert "工具调用失败本身不值得保存" in prompt
    assert "不同人物使用能区分主体的 `topic`" in prompt
    assert "高风险个人信息" in prompt
    assert '"keywords"' in prompt


def test_knowledge_capture_normalizes_mode_and_rejects_silent_truncation():
    from agent.knowledge.capture import normalize_capture

    values = normalize_capture(
        "工具结论", "外部资料整理后的结论", source_type="web",
        confidence="confirmed", capture_mode="tool_result",
    )
    assert values["confidence"] == "probable"
    accepted = normalize_capture("边界知识", "x" * 3000)
    assert len(accepted["content"]) == 3000
    with pytest.raises(ValueError, match="content.*3000"):
        normalize_capture("过长", "x" * 3001)


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


@pytest.mark.asyncio
async def test_save_knowledge_tool_persists_and_normalizes_keywords(knowledge_storage, monkeypatch):
    """save_knowledge 工具路径必须把 keywords 落库（此前 schema 没有该字段，恒为空）。"""
    from agent import events
    from agent.tools.memory import _save_knowledge

    monkeypatch.setattr(events.bus, "publish", lambda event: None)
    result = await _save_knowledge(None, "user-a", {
        "title": "部署规则", "content": "只使用 Linux 部署", "topic": "部署",
        "keywords": [" deploy ", "Deploy", "linux", *[f"词{i}" for i in range(12)]],
    })

    assert result["success"] is True
    saved = (await KnowledgeStore("user-a").list())[0]
    # 去重（casefold）+ 超限静默截断到 10 个，与反思路径同一套 normalize_capture。
    assert saved.keywords == ["deploy", "linux", *[f"词{i}" for i in range(8)]]


@pytest.mark.asyncio
async def test_save_knowledge_tool_drops_non_list_keywords(knowledge_storage, monkeypatch):
    from agent import events
    from agent.tools.memory import _save_knowledge

    monkeypatch.setattr(events.bus, "publish", lambda event: None)
    result = await _save_knowledge(None, "user-a", {
        "title": "检索规则", "content": "关键词必须是数组", "topic": "检索",
        "keywords": "deploy",
    })

    assert result["success"] is True
    saved = (await KnowledgeStore("user-a").list())[0]
    assert saved.keywords == []


def test_save_knowledge_schema_declares_keywords():
    from agent.tools import registry

    tool = registry.get("save_knowledge")
    assert tool.input_schema["properties"]["keywords"] == {
        "type": "array", "items": {"type": "string"},
    }
    assert "keywords" in tool.description


@pytest.mark.asyncio
async def test_store_save_hits_by_id_across_topic_change(knowledge_storage):
    """显式传入已有 ID 时按 ID 直命中，topic 改名也不漏匹配、不打错条目。"""
    store = KnowledgeStore("user-a")
    original = KnowledgeEntry.create(
        title="部署流程", content="使用 v1 部署", topic="部署",
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("user"),
    )
    await store.save(original)
    renamed = KnowledgeEntry.create(
        title="部署流程", content="使用 v2 部署", topic="发布",
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("user"),
    )
    renamed.id = original.id

    saved = await store.save(renamed)

    entries = await store.list()
    assert len(entries) == 1
    assert saved.id == original.id
    assert saved.topic == "发布"
    assert saved.version == 2


@pytest.mark.asyncio
async def test_store_save_rejects_update_on_deleted_entry(knowledge_storage):
    store = KnowledgeStore("user-a")
    original = KnowledgeEntry.create(
        title="规则", content="内容", topic="规则",
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("user"),
    )
    await store.save(original)
    await store.delete(original.id)
    stale = KnowledgeEntry.create(
        title="规则", content="新内容", topic="规则",
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("user"),
    )
    stale.id = original.id

    with pytest.raises(ValueError, match="已删除"):
        await store.save(stale)


@pytest.mark.asyncio
async def test_update_knowledge_tool_updates_version_and_inherits_omitted_fields(knowledge_storage, monkeypatch):
    from agent import events
    from agent.tools.memory import _update_knowledge

    published = []
    monkeypatch.setattr(events.bus, "publish", published.append)
    store = KnowledgeStore("user-a")
    original = KnowledgeEntry.create(
        title="部署流程", content="使用 v1 部署", topic="部署",
        keywords=["deploy", "v1"],
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("user"),
    )
    await store.save(original)

    result = await _update_knowledge(None, "user-a", {
        "knowledge_id": original.id, "content": "使用 v2 部署，回滚用 v1 脚本",
    })

    assert result["success"] is True
    assert result["unchanged"] is False
    assert result["version"] == 2
    assert result["previous"]["content"] == "使用 v1 部署"
    saved = (await store.list())[0]
    assert saved.id == original.id
    assert saved.version == 2
    # title/topic/keywords 省略时继承原值
    assert saved.title == "部署流程"
    assert saved.topic == "部署"
    assert saved.keywords == ["deploy", "v1"]
    assert len(saved.history) == 1
    assert saved.history[0]["content"] == "使用 v1 部署"
    assert len(published) == 1
    assert published[0].operation == "upsert"


@pytest.mark.asyncio
async def test_update_knowledge_tool_reports_unchanged_without_new_version(knowledge_storage, monkeypatch):
    from agent import events
    from agent.tools.memory import _update_knowledge

    monkeypatch.setattr(events.bus, "publish", lambda event: None)
    store = KnowledgeStore("user-a")
    original = KnowledgeEntry.create(
        title="规则", content="只使用 Linux", topic="部署",
        keywords=["linux"],
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("user"),
    )
    await store.save(original)

    result = await _update_knowledge(None, "user-a", {
        "knowledge_id": original.id, "content": "只使用 Linux",
    })

    assert result["success"] is True
    assert result["unchanged"] is True
    assert result["version"] == 1


@pytest.mark.asyncio
async def test_update_knowledge_tool_rejects_unknown_or_deleted_id(knowledge_storage, monkeypatch):
    from agent import events
    from agent.tools.memory import _update_knowledge

    monkeypatch.setattr(events.bus, "publish", lambda event: None)
    store = KnowledgeStore("user-a")
    original = KnowledgeEntry.create(
        title="规则", content="内容", topic="规则",
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("user"),
    )
    await store.save(original)

    missing = await _update_knowledge(None, "user-a", {
        "knowledge_id": "knowledge-no-such", "content": "新正文",
    })
    assert "不存在" in missing["error"]

    await store.delete(original.id)
    deleted = await _update_knowledge(None, "user-a", {
        "knowledge_id": original.id, "content": "新正文",
    })
    assert "不存在" in deleted["error"]


def test_update_knowledge_schema_requires_id_and_content():
    from agent.tools import registry

    tool = registry.get("update_knowledge")
    assert tool.input_schema["required"] == ["knowledge_id", "content"]
    assert tool.input_schema["properties"]["keywords"] == {"type": "array", "items": {"type": "string"}}
