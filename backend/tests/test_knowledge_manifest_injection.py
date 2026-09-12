"""知识清单注入 snapshot 的行为契约：渲染、兜底链、封顶与作用域过滤。"""

from __future__ import annotations

import pytest

from agent.context import builder


@pytest.fixture
def knowledge_storage(tmp_path, monkeypatch):
    from app.services.storage import LocalStorageBackend

    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("agent.knowledge.store.get_storage", lambda: backend)
    return backend


def _snapshot(knowledge=None, include_knowledge=True):
    _, snapshot_context, _ = builder.build_split(
        "default", "测试用户", [], [], knowledge=knowledge,
        include_knowledge=include_knowledge,
    )
    return snapshot_context


def test_build_split_renders_title_and_description():
    text = _snapshot([
        {"title": "发布流程", "topic": "发布", "description": "需要发版或回滚时先读。"},
    ])
    assert "## 知识" in text
    assert "search_memory" in text
    assert "- 发布流程：需要发版或回滚时先读。" in text


def test_build_split_description_falls_back_to_topic_then_title():
    text = _snapshot([
        {"title": "有主题", "topic": "部署", "description": ""},
        {"title": "全空", "topic": "", "description": ""},
    ])
    assert "- 有主题：（部署）" in text
    assert "- 全空" in text
    # 裸 title 行不带冒号
    assert "- 全空：" not in text


def test_build_split_caps_manifest_at_40_items():
    knowledge = [{"title": f"条目{i}", "topic": "", "description": "x"} for i in range(50)]
    text = _snapshot(knowledge)
    assert "- 条目39：x" in text
    assert "- 条目40：x" not in text


def test_build_split_knowledge_placeholder_without_permission():
    text = _snapshot([{"title": "不该出现", "topic": "", "description": ""}],
                     include_knowledge=False)
    assert "不该出现" not in text
    assert "（本次任务不需要知识上下文，未加载）" in text


@pytest.mark.asyncio
async def test_load_knowledge_overview_filters_to_owner_scope_and_newest_first(knowledge_storage):
    from agent.context import loaders
    from agent.knowledge.models import KnowledgeEntry, KnowledgeScope, KnowledgeSource
    from agent.knowledge.store import KnowledgeStore

    store = KnowledgeStore("user-a")
    older = KnowledgeEntry.create(
        title="旧知识", content="内容", topic="旧",
        description="更早保存。",
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("user"),
    )
    older.updated_at = 1_000_000_000.0
    await store.save(older)
    newer = KnowledgeEntry.create(
        title="私人知识", content="内容", topic="私有",
        description="owner 作用域。",
        scope=KnowledgeScope(owner_user_id="user-a"), source=KnowledgeSource("user"),
    )
    newer.updated_at = 2_000_000_000.0
    await store.save(newer)
    await store.save(KnowledgeEntry.create(
        title="群知识", content="内容", topic="群",
        description="群作用域不进清单。",
        scope=KnowledgeScope(owner_user_id="user-a", type="group", group_id="g1", scope_id="g1"),
        source=KnowledgeSource("user"),
    ))

    overview = await loaders.load_knowledge_overview("user-a")
    # 只含 owner scope，且按更新时间新→旧排（清单取前 40 即最新 40 条）
    assert [item["title"] for item in overview] == ["私人知识", "旧知识"]
    assert overview[0]["description"] == "owner 作用域。"
