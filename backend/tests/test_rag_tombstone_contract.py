"""PRD-RAG-9 索引生命周期移交 TS：chunk 表墓碑契约。

软删（deleted_at + indexed_at 双时间戳）是 worker 增量同步的基础：
- 删除对增量游标可见（墓碑行带时间戳，物理删则不可见）；
- 纯收缩/删除也推进 revision（max(indexed_at) 含墓碑）；
- 活跃读路径（检索/装载）继续过滤墓碑；
- 墓碑超过保留期被物理清理。
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select, update

from agent.rag.index_cache import get_index_cache
from agent.rag.models import IndexDocument, Scope
from agent.rag.persistent_store import (
    TOMBSTONE_RETENTION,
    load_index_documents,
    replace_source_documents,
)
from app.core.tz import now_utc
from app.models import KnowledgeIndexEntry


def _doc(source_id: str, content: str, index: int, count: int, version: str = "1") -> IndexDocument:
    return IndexDocument(
        document_id=f"{source_id}:{version}:{index}",
        source_type="file", source_id=source_id,
        scope=Scope(owner_user_id="owner-t", scope_type="owner"),
        title="标题", summary="摘要", content=content,
        version=version, chunk_index=index, chunk_count=count,
        parent_document_id=source_id,
    )


async def _all_rows(db, owner, include_tombstones=True):
    query = select(KnowledgeIndexEntry).where(KnowledgeIndexEntry.owner_user_id == owner)
    if not include_tombstones:
        query = query.where(KnowledgeIndexEntry.deleted_at.is_(None))
    return (await db.execute(query)).scalars().all()


@pytest.mark.asyncio
async def test_replace_shrink_soft_deletes_and_advances_revision(db, user_a):
    """收缩后旧行留墓碑（不物理删）；revision 因墓碑时间戳推进——纯删除可见。"""
    docs_v1 = [_doc("f-1", "甲", 0, 1), _doc("f-2", "乙", 0, 1)]
    await replace_source_documents(db, user_a.id, "file", docs_v1)
    revision_v1 = await get_index_cache()._revision(db, user_a.id)

    # 收缩：只保留 f-1
    await replace_source_documents(db, user_a.id, "file", [_doc("f-1", "甲", 0, 1)])
    revision_v2 = await get_index_cache()._revision(db, user_a.id)

    rows = await _all_rows(db, user_a.id)
    tombstones = [row for row in rows if row.source_id == "f-2"]
    assert len(tombstones) == 1 and tombstones[0].deleted_at is not None
    assert revision_v2 != revision_v1          # 纯删除必须推进水位
    assert revision_v2 > revision_v1 or True   # 字符串比较无意义，仅要求变化

    # 活跃读路径过滤墓碑
    docs = await load_index_documents(db, user_a.id, source_types={"file"})
    assert [d.source_id for d in docs] == ["f-1"]


@pytest.mark.asyncio
async def test_resurrected_key_clears_tombstone(db, user_a):
    """同一键先删后恢复：墓碑被清空（deleted_at=None）而不是插出第二行。"""
    await replace_source_documents(db, user_a.id, "file", [_doc("f-1", "甲", 0, 1)])
    await replace_source_documents(db, user_a.id, "file", [])
    # 同键复活（版本不变）：replace 的更新路径把墓碑清空
    await replace_source_documents(db, user_a.id, "file", [_doc("f-1", "甲二", 0, 1)])

    rows = await _all_rows(db, user_a.id)
    assert len(rows) == 1
    assert rows[0].deleted_at is None
    assert rows[0].content == "甲二"


@pytest.mark.asyncio
async def test_tombstone_pruned_after_retention(db, user_a):
    """超过保留期的墓碑被物理清理；新鲜墓碑保留。"""
    await replace_source_documents(db, user_a.id, "file", [_doc("f-1", "甲", 0, 1), _doc("f-2", "乙", 0, 1)])
    await replace_source_documents(db, user_a.id, "file", [_doc("f-1", "甲", 0, 1)])

    # 把 f-2 的墓碑改到保留期之外
    stale = now_utc() - TOMBSTONE_RETENTION - timedelta(days=1)
    await db.execute(update(KnowledgeIndexEntry)
                     .where(KnowledgeIndexEntry.source_id == "f-2")
                     .values(deleted_at=stale))
    await replace_source_documents(db, user_a.id, "file", [_doc("f-1", "甲", 0, 1)])

    rows = await _all_rows(db, user_a.id)
    assert [row.source_id for row in rows] == ["f-1"]   # 过期墓碑已物理清理
