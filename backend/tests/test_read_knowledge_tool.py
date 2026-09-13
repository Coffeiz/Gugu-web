"""read_knowledge 直读工具回归（PRD-KNOWLEDGE-2）。

读取直读 KnowledgeStore、不经过 BM25 索引：写入即可读；支持 id 精确读与
列举/scope/keyword 过滤；跨用户不可见。
"""
import pytest

from agent.knowledge.models import KnowledgeEntry, KnowledgeScope, KnowledgeSource
from agent.knowledge.store import KnowledgeStore
from agent.tools.knowledge import _read_knowledge
from app.services.storage import LocalStorageBackend


@pytest.fixture
def knowledge_storage(tmp_path, monkeypatch):
    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("agent.knowledge.store.get_storage", lambda: backend)
    return backend


async def _save(db_user, title: str, content: str, *, topic: str = "", description: str = ""):
    store = KnowledgeStore(db_user)
    entry = KnowledgeEntry.create(
        title=title, content=content, topic=topic, description=description,
        scope=KnowledgeScope(owner_user_id=db_user),
        source=KnowledgeSource("user", label="测试"),
    )
    await store.save(entry)
    return entry


@pytest.mark.asyncio
async def test_read_by_id_returns_full_content(knowledge_storage):
    saved = await _save("user-a", "部署规范", "发布前必须跑完 CI 双工作流", topic="运维")

    result = await _read_knowledge(None, "user-a", {"knowledge_id": saved.id})

    assert result["success"] is True
    assert result["entry"]["content"] == "发布前必须跑完 CI 双工作流"
    assert result["entry"]["title"] == "部署规范"
    assert result["entry"]["knowledge_id"] == saved.id


@pytest.mark.asyncio
async def test_read_unknown_id_gives_guidance(knowledge_storage):
    result = await _read_knowledge(None, "user-a", {"knowledge_id": "nope"})

    assert "error" in result
    assert "列举" in result["error"]


@pytest.mark.asyncio
async def test_list_mode_returns_summaries_without_content(knowledge_storage):
    await _save("user-a", "部署规范", "发布前跑 CI", topic="运维", description="发布时需要")
    await _save("user-a", "命名约定", "分支用 kebab-case", topic="协作")

    result = await _read_knowledge(None, "user-a", {})

    assert result["success"] is True
    assert result["total"] == 2 and result["returned"] == 2
    assert all("content" not in entry for entry in result["entries"])
    titles = {entry["title"] for entry in result["entries"]}
    assert titles == {"部署规范", "命名约定"}


@pytest.mark.asyncio
async def test_keyword_filter_matches_content_and_title(knowledge_storage):
    await _save("user-a", "部署规范", "发布前跑 CI 双工作流", topic="运维")
    await _save("user-a", "命名约定", "分支用 kebab-case", topic="协作")

    hit = await _read_knowledge(None, "user-a", {"keyword": "kebab"})
    assert hit["total"] == 1
    assert hit["entries"][0]["title"] == "命名约定"

    none = await _read_knowledge(None, "user-a", {"keyword": "不存在的词"})
    assert none["total"] == 0
    assert "note" in none


@pytest.mark.asyncio
async def test_limit_caps_and_reports_total(knowledge_storage):
    for index in range(4):
        await _save("user-a", f"条目{index}", f"内容{index}")

    result = await _read_knowledge(None, "user-a", {"limit": 2})

    assert result["total"] == 4 and result["returned"] == 2
    assert "缩小范围" in result["note"]


@pytest.mark.asyncio
async def test_cross_user_isolation(knowledge_storage):
    await _save("user-a", "A 的秘密", "只有 user-a 能读")

    result = await _read_knowledge(None, "user-b", {})

    assert result["total"] == 0
    single = await _read_knowledge(None, "user-b", {"knowledge_id": (await KnowledgeStore("user-a").list())[0].id})
    assert "error" in single
