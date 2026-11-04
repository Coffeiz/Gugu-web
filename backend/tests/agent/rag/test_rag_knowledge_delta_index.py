"""Knowledge 文档级增量：验证单对象投影、持久索引变更与事件路由。"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import agent.rag.pipeline as pipeline
from agent.events.types import RagIndexUpdated
from agent.rag.models import IndexDocument, Scope
from agent.rag.persistent_store import load_parent_documents, replace_source_documents
from app.models import Base, User, KnowledgeIndexEntry
from app.services.storage import LocalStorageBackend


def _doc(owner: str, source_id: str, content: str, index: int, count: int, version: str = "1") -> IndexDocument:
    return IndexDocument(
        document_id=f"{source_id}:{version}:{index}",
        source_type="knowledge", source_id=source_id,
        scope=Scope(owner_user_id=owner, scope_type="owner"),
        title="标题", summary="摘要", content=content,
        version=version, chunk_index=index, chunk_count=count,
        parent_document_id=source_id,
    )


def _fake_projection(records):
    """把 canonical record 切成 N 个 chunk：正文按「|」分段（测试专用协议）。

    version 取自主数据的 document_version，与真实 TS 投影一致。
    """
    documents = []
    for record, scope in records:
        parts = [p for p in record["content"].split("|") if p]
        version = str(record.get("document_version") or "1").split(":")[0]
        for index, part in enumerate(parts):
            documents.append(IndexDocument(
                document_id=f"{record['source_id']}:{version}:{index}",
                source_type="knowledge", source_id=record["source_id"],
                scope=scope, title=record["title"], summary=record["summary"],
                content=part, version=version, chunk_index=index,
                chunk_count=len(parts), parent_document_id=record["source_id"],
            ))
    return documents


@pytest_asyncio.fixture
async def rag_env(monkeypatch, tmp_path):
    """独立内存库 + fake 投影 + 临时存储。"""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as db:
        owner = User(id=uuid.uuid4(), username=f"kdelta-{uuid.uuid4().hex[:8]}",
                     email="kdelta@test.local", hashed_password="x")
        db.add(owner)
        await db.commit()
        owner_id = owner.id

    monkeypatch.setattr(pipeline, "_in_memory_sqlite", lambda _engine: False)
    import asyncio as _asyncio
    import app.db.session as db_session
    monkeypatch.setattr(db_session, "_engine", engine)
    monkeypatch.setattr(db_session, "_SessionLocal", session_factory, raising=False)
    # 不同步 _engine_loop 的话，ensure_engine() 会判成「引擎该重建」而连回真实库
    # （conftest db fixture 注释里的同一个坑）。
    monkeypatch.setattr(db_session, "_engine_loop", _asyncio.get_running_loop())

    storage = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("agent.knowledge.store.get_storage", lambda: storage)

    async def fake_project(owner_user_id, source_type, records, **_kwargs):
        return _fake_projection(records)
    monkeypatch.setattr(pipeline, "records_to_write_documents", fake_project)

    yield owner_id, session_factory
    await engine.dispose()


async def _seed_entry(owner_id, entry_id: str, content: str) -> None:
    """直接经 KnowledgeStore 写主数据（知识条目用 | 分段协议）。"""
    from agent.knowledge.capture import build_entry
    from agent.knowledge.models import KnowledgeScope, KnowledgeSource
    from agent.knowledge.store import KnowledgeStore

    entry = build_entry(owner_id, {
        "title": f"条目 {entry_id}", "content": content, "topic": f"主题{entry_id}",
        "keywords": ["关键词"], "source_type": "user", "source_ref": "", "source_label": "测试",
        "confidence": "confirmed",
    })
    entry.id = entry_id
    await KnowledgeStore(owner_id).save(entry)


async def _full_seed(db, owner_id, entries: dict[str, str]) -> None:
    """整来源种子：主数据 + 来源级全量持久索引。"""
    for entry_id, content in entries.items():
        await _seed_entry(owner_id, entry_id, content)
    from agent.rag.adapters.knowledge import KnowledgeAdapter

    records = await KnowledgeAdapter(owner_id).build_source_records()
    documents = _fake_projection(records)
    await replace_source_documents(db, owner_id, "knowledge", documents)
    await db.commit()


async def _modify_entry(owner_id, entry_id: str, content: str):
    """按同 ID 改主数据正文；save 会推进 version。"""
    from agent.knowledge.capture import build_entry
    from agent.knowledge.store import KnowledgeStore

    entry = build_entry(owner_id, {
        "title": f"条目 {entry_id}", "content": content, "topic": f"主题{entry_id}",
        "keywords": ["关键词"], "source_type": "user", "source_ref": "", "source_label": "测试",
        "confidence": "confirmed",
    })
    entry.id = entry_id
    return await KnowledgeStore(owner_id).save(entry)


@pytest.mark.asyncio
async def test_document_patch_reads_and_projects_single_record(rag_env):
    owner_id, session_factory = rag_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "第一段|第二段", "k-b": "别的条目"})
    await _modify_entry(owner_id, "k-a", "改后一段|改后二段")
    stats: dict = {}
    count = await pipeline.update_document(owner_id, "knowledge", "k-a", stats_out=stats)
    assert stats["mode"] == "document_patch"
    assert stats["status"] == "index_invalidated"
    assert count == 2
    async with session_factory() as db:
        rows = (await load_parent_documents(db, owner_id, "knowledge", "k-a"))
        other = (await load_parent_documents(db, owner_id, "knowledge", "k-b"))
    assert len(rows) == 2
    assert len(other) == 1


@pytest.mark.asyncio
async def test_content_change_replaces_old_chunks_without_residue(rag_env):
    owner_id, session_factory = rag_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "旧一段|旧二段"})
    await _modify_entry(owner_id, "k-a", "新一段|新二段|新三段")
    stats: dict = {}
    await pipeline.update_document(owner_id, "knowledge", "k-a", stats_out=stats)
    async with session_factory() as db:
        rows = await load_parent_documents(db, owner_id, "knowledge", "k-a")
    assert len(rows) == 3
    assert all("新" in row.content for row in rows)
    assert {row.chunk_index for row in rows} == {0, 1, 2}


@pytest.mark.asyncio
async def test_delete_removes_all_chunks_and_keeps_siblings(rag_env):
    owner_id, session_factory = rag_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "一段|二段", "k-b": "保留"})
    stats: dict = {}
    remaining = await pipeline.update_document(
        owner_id, "knowledge", "k-a", operation="delete", stats_out=stats,
    )
    assert remaining == 0
    assert stats["delete_count"] == 2 and stats["upsert_count"] == 0
    async with session_factory() as db:
        gone = await load_parent_documents(db, owner_id, "knowledge", "k-a")
        kept = await load_parent_documents(db, owner_id, "knowledge", "k-b")
    assert gone == []
    assert len(kept) == 1


@pytest.mark.asyncio
async def test_no_change_keeps_persistent_index_revision(rag_env):
    owner_id, session_factory = rag_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "一段|二段"})
    stats: dict = {}
    await pipeline.update_document(owner_id, "knowledge", "k-a", stats_out=stats)
    assert stats["status"] == "no_change"


@pytest.mark.asyncio
async def test_handle_event_routes_by_source_id(monkeypatch, rag_env):
    owner_id, _sf = rag_env
    routed: list[tuple] = []

    async def fake_doc_patch(user_id, source_type, source_id, *, operation="upsert", stats_out=None):
        routed.append((str(source_id), operation))
        if stats_out is not None:
            stats_out.update({"mode": "document_patch", "status": "ready"})
        return 1

    async def fake_source_rebuild(user_id, source_type, *, operation="upsert", stats_out=None):
        routed.append((str(source_type), operation))
        return 1

    monkeypatch.setattr(pipeline, "update_document", fake_doc_patch)
    monkeypatch.setattr(pipeline, "rebuild_source_index", fake_source_rebuild)

    assert await pipeline.handle_rag_index_event(RagIndexUpdated(
        user_id=owner_id, source_type="knowledge", source_id="k-9", operation="upsert")) is True
    assert await pipeline.handle_rag_index_event(RagIndexUpdated(
        user_id=owner_id, source_type="knowledge", source_id="", operation="upsert")) is True
    # 旧索引记录仍可能因清理任务产生事件，但文件来源已不再进入 RAG。
    assert await pipeline.handle_rag_index_event(RagIndexUpdated(
        user_id=owner_id, source_type="file", source_id="f-1", operation="upsert")) is True
    assert routed == [("k-9", "upsert"), ("knowledge", "upsert")]


@pytest.mark.asyncio
async def test_single_record_read_skips_other_entries(rag_env):
    """单条读取不遍历全库：读 k-a 时不加载 k-b 的文件内容。"""
    from agent.knowledge.store import KnowledgeStore
    from agent.rag.adapters.knowledge import KnowledgeAdapter

    owner_id, _sf = rag_env
    await _seed_entry(owner_id, "k-a", "甲")
    await _seed_entry(owner_id, "k-b", "乙")
    loaded = []
    original_get = KnowledgeStore.get

    async def spy_get(self, entry_id, **kwargs):
        loaded.append(str(entry_id))
        return await original_get(self, entry_id, **kwargs)

    KnowledgeStore.get = spy_get
    try:
        record = await KnowledgeAdapter(owner_id).build_source_record_for("k-a")
    finally:
        KnowledgeStore.get = original_get
    assert loaded == ["k-a"]
    assert record is not None and record[0]["source_id"] == "k-a"
