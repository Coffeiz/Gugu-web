"""PRD-RAG-9 Phase 1：Knowledge 文档级增量管线。

覆盖：单条读取/投影、单 source_id chunk 增量写库、worker patch 与
revision_mismatch 回退、删除/收缩无残留、事件路由（带 source_id 走文档级）。
不启动真实 TS worker：投影与 worker 都用 fake。
"""
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
from agent.rag.ts_sidecar import TsSidecarUnavailable
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


class FakeWorker:
    """记录 patch/replace 调用；可配置 patch 抛 revision_mismatch。"""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.revision: str | None = "seed"
        self.fail_patch_codes: list[str] = []

    async def patch(self, upserts, deletes, revision, base_revision, *, vectors=None, vector_version="", storage_owner_id=None):
        if self.fail_patch_codes:
            code = self.fail_patch_codes.pop(0)
            if code:
                raise TsSidecarUnavailable(f"worker: {code}", code=code)
        self.calls.append(("patch", {
            "upserts": [d.chunk_id for d in upserts],
            "deletes": list(deletes), "revision": revision,
        }))
        self.revision = revision

    async def replace(self, documents, revision, *, vectors=None, vector_version="", storage_owner_id=None):
        self.calls.append(("replace", {"chunks": [d.chunk_id for d in documents], "revision": revision}))
        self.revision = revision

    async def close(self):
        return None

    def ops(self) -> list[str]:
        return [op for op, _ in self.calls]


@pytest_asyncio.fixture
async def rag_env(monkeypatch, tmp_path):
    """独立内存库 + fake worker + fake 投影 + 临时存储；返回 (owner_id, worker, session_factory)。"""
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

    worker = FakeWorker()
    async def fake_client(_user_id):
        return worker
    monkeypatch.setattr(pipeline, "_knowledge_client", fake_client)

    async def fake_project(owner_user_id, source_type, records, **_kwargs):
        return _fake_projection(records)
    monkeypatch.setattr(pipeline, "records_to_write_documents", fake_project)

    return owner_id, worker, session_factory


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
    owner_id, worker, session_factory = rag_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "第一段|第二段", "k-b": "别的条目"})
    await _modify_entry(owner_id, "k-a", "改后一段|改后二段")
    stats: dict = {}
    count = await pipeline.update_knowledge_document(owner_id, "k-a", stats_out=stats)
    assert stats["mode"] == "document_patch"
    assert stats["status"] == "ready"
    assert count == 2
    # 只投影了一条 record
    assert worker.ops() == ["patch"]
    patch_call = worker.calls[0][1]
    assert all(chunk_id.startswith("k-a:") for chunk_id in patch_call["upserts"])
    async with session_factory() as db:
        rows = (await load_parent_documents(db, owner_id, "knowledge", "k-a"))
        other = (await load_parent_documents(db, owner_id, "knowledge", "k-b"))
    assert len(rows) == 2
    assert len(other) == 1


@pytest.mark.asyncio
async def test_content_change_replaces_old_chunks_without_residue(rag_env):
    owner_id, worker, session_factory = rag_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "旧一段|旧二段"})
    await _modify_entry(owner_id, "k-a", "新一段|新二段|新三段")
    stats: dict = {}
    await pipeline.update_knowledge_document(owner_id, "k-a", stats_out=stats)
    async with session_factory() as db:
        rows = await load_parent_documents(db, owner_id, "knowledge", "k-a")
    assert len(rows) == 3
    assert all("新" in row.content for row in rows)
    assert {row.chunk_index for row in rows} == {0, 1, 2}
    patch_call = worker.calls[-1][1]
    assert len(patch_call["upserts"]) == 3
    # slot 契约：同槽位由 upsert 覆盖，无 slot 消失则 deletes 为空；
    # 旧 version 残留由 DB 父文档作用域 replace 兜住（上面已断言只有新内容）。
    assert patch_call["deletes"] == []


@pytest.mark.asyncio
async def test_delete_removes_all_chunks_and_keeps_siblings(rag_env):
    owner_id, worker, session_factory = rag_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "一段|二段", "k-b": "保留"})
    stats: dict = {}
    remaining = await pipeline.update_knowledge_document(
        owner_id, "k-a", operation="delete", stats_out=stats,
    )
    assert remaining == 0
    assert stats["delete_count"] == 2 and stats["upsert_count"] == 0
    async with session_factory() as db:
        gone = await load_parent_documents(db, owner_id, "knowledge", "k-a")
        kept = await load_parent_documents(db, owner_id, "knowledge", "k-b")
    assert gone == []
    assert len(kept) == 1
    patch_call = worker.calls[-1][1]
    assert patch_call["upserts"] == []
    assert len(patch_call["deletes"]) == 2


@pytest.mark.asyncio
async def test_no_change_skips_worker_and_keeps_revision(rag_env):
    owner_id, worker, session_factory = rag_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "一段|二段"})
    stats: dict = {}
    await pipeline.update_knowledge_document(owner_id, "k-a", stats_out=stats)
    assert stats["status"] == "no_change"
    assert worker.ops() == []   # 无变化不打 worker


@pytest.mark.asyncio
async def test_revision_mismatch_falls_back_to_source_replace(rag_env):
    owner_id, worker, session_factory = rag_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "一段|二段", "k-b": "另一条"})
    await _modify_entry(owner_id, "k-a", "换一段|换二段")
    worker.fail_patch_codes = ["revision_mismatch"]
    stats: dict = {}
    await pipeline.update_knowledge_document(owner_id, "k-a", stats_out=stats)
    # patch 抛 mismatch（不记录），回退整来源 replace
    assert worker.ops() == ["replace"]
    assert stats["base_revision_match"] is False
    assert stats["status"] == "ready"
    replace_call = worker.calls[-1][1]
    # 回退是整来源 replace：包含 k-a（2 chunk）与 k-b（1 chunk）全部
    assert len(replace_call["chunks"]) == 3


@pytest.mark.asyncio
async def test_worker_unavailable_is_ready_for_lazy_query_rebuild(rag_env):
    owner_id, worker, session_factory = rag_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "一段|二段"})
    await _modify_entry(owner_id, "k-a", "换一段|换二段")
    worker.fail_patch_codes = ["worker_crashed"]
    stats: dict = {}
    await pipeline.update_knowledge_document(owner_id, "k-a", stats_out=stats)
    # DB 已推进 revision，查询侧会懒同步自愈；不判失败
    assert stats["status"] == "worker_unavailable"
    async with session_factory() as db:
        rows = await load_parent_documents(db, owner_id, "knowledge", "k-a")
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_handle_event_routes_by_source_id(monkeypatch, rag_env):
    owner_id, _worker, _sf = rag_env
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
    assert await pipeline.handle_rag_index_event(RagIndexUpdated(
        user_id=owner_id, source_type="file", source_id="f-1", operation="upsert")) is True
    # file 现在也带 id 走文档级（Phase 2）
    assert routed == [("k-9", "upsert"), ("knowledge", "upsert"), ("f-1", "upsert")]


@pytest.mark.asyncio
async def test_single_record_read_skips_other_entries(rag_env):
    """单条读取不遍历全库：读 k-a 时不加载 k-b 的文件内容。"""
    from agent.knowledge.store import KnowledgeStore
    from agent.rag.adapters.knowledge import KnowledgeAdapter

    owner_id, _worker, _sf = rag_env
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
