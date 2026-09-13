"""PRD-RAG-9 Phase 5：Knowledge 边界与来源真实变更回归。

覆盖：仅关键词/描述变化的版本戳、删除后恢复、projection 事务失败不落脏、
向量部分失败不破坏 lexical 投影（幂等重放收敛）、文件夹移动旧 scope 清理、
owner scope 隔离。不启动真实 TS worker（同其他 delta 测试用 fake）。
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import agent.rag.pipeline as pipeline
from agent.events.types import RagIndexUpdated
from agent.rag.models import IndexDocument, Scope
from agent.rag.persistent_store import load_index_documents, load_parent_documents, replace_source_documents
from app.models import Base, User
from app.services.storage import LocalStorageBackend


def _fake_projection(records):
    documents = []
    for record, scope in records:
        # 与 TS files 适配器对齐：stage_name 渲染进投影文本（files.ts:36），
        # 阶段/文件夹移动必须体现为投影内容变化。
        stage_line = f"阶段：{record['stage_name']}" if record.get("stage_name") else ""
        body = record.get("content") or ""
        parts = [p for p in (stage_line + "\n" + body).split("|") if p and p.strip()]
        version_parts = record.get("version_parts") or []
        version = (str(version_parts[1]) if len(version_parts) > 1 else None) \
            or str(record.get("document_version") or "1").split(":")[0]
        source_id = str(record.get("source_id") or record.get("id"))
        for index, part in enumerate(parts):
            documents.append(IndexDocument(
                document_id=f"{source_id}:{version}:{index}",
                source_type=record["source_type"], source_id=source_id,
                scope=scope, title=record["title"], summary=record.get("summary", ""),
                content=part.strip(), version=version, chunk_index=index,
                chunk_count=len(parts),
                parent_document_id=str(record.get("parent_id") or source_id),
            ))
    return documents


class FakeWorker:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.revision: str | None = "seed"

    async def patch(self, upserts, deletes, revision, base_revision, *, vectors=None, vector_version="", storage_owner_id=None):
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

    def ops(self):
        return [op for op, _ in self.calls]


@pytest_asyncio.fixture
async def kb_env(monkeypatch, tmp_path):
    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    owner_ids = []
    async with session_factory() as db:
        for tag in ("a", "b"):
            owner = User(id=uuid.uuid4(), username=f"p5b-{tag}-{uuid.uuid4().hex[:6]}",
                         email=f"p5b-{tag}@test.local", hashed_password="x")
            db.add(owner)
            owner_ids.append(owner.id)
        await db.commit()

    monkeypatch.setattr(pipeline, "_in_memory_sqlite", lambda _engine: False)
    import app.db.session as db_session
    monkeypatch.setattr(db_session, "_engine", engine)
    monkeypatch.setattr(db_session, "_SessionLocal", session_factory, raising=False)
    monkeypatch.setattr(db_session, "_engine_loop", asyncio.get_running_loop())

    storage = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("agent.knowledge.store.get_storage", lambda: storage)

    worker = FakeWorker()
    async def fake_client(_user_id):
        return worker
    monkeypatch.setattr(pipeline, "_knowledge_client", fake_client)
    async def fake_project(owner_user_id, source_type, records, **_kwargs):
        return _fake_projection(records)
    monkeypatch.setattr(pipeline, "records_to_write_documents", fake_project)
    return owner_ids[0], owner_ids[1], worker, session_factory


def _entry_payload(entry_id: str, content: str, *, keywords=("关键词",), description="") -> dict:
    return {
        "title": f"条目 {entry_id}", "content": content, "topic": f"主题{entry_id}",
        "keywords": list(keywords), "source_type": "user", "source_ref": "",
        "source_label": "测试", "confidence": "confirmed", "description": description,
    }


async def _save_entry(owner_id, entry_id: str, content: str, **kwargs):
    from agent.knowledge.capture import build_entry
    from agent.knowledge.store import KnowledgeStore

    entry = build_entry(owner_id, _entry_payload(entry_id, content, **kwargs))
    entry.id = entry_id
    return await KnowledgeStore(owner_id).save(entry)


async def _full_seed(db, owner_id, entries: dict[str, str]) -> None:
    for entry_id, content in entries.items():
        await _save_entry(owner_id, entry_id, content)
    from agent.rag.adapters.knowledge import KnowledgeAdapter

    records = await KnowledgeAdapter(owner_id).build_source_records()
    await replace_source_documents(db, owner_id, "knowledge", _fake_projection(records))
    await db.commit()


@pytest.mark.asyncio
async def test_keyword_only_change_bumps_version_stamp(kb_env):
    """仅改关键词：document_version 戳 {version}:k{hash} 必须变化（PRD §7）。"""
    from agent.rag.adapters.knowledge import KnowledgeAdapter

    owner_id, _owner_b, _worker, _sf = kb_env
    await _save_entry(owner_id, "k-a", "正文未动")
    before = (await KnowledgeAdapter(owner_id).build_source_record_for("k-a"))[0]["document_version"]

    await _save_entry(owner_id, "k-a", "正文未动", keywords=("新关键词", "补充"))
    after = (await KnowledgeAdapter(owner_id).build_source_record_for("k-a"))[0]["document_version"]

    # save 可能推进内容版本；契约关键是关键词 hash 戳一定参与且发生变化
    assert before != after
    assert after.split(":k")[1] != before.split(":k")[1]

    # 只改描述同理
    await _save_entry(owner_id, "k-a", "正文未动", keywords=("新关键词", "补充"),
                      description="何时需要这条知识")
    third = (await KnowledgeAdapter(owner_id).build_source_record_for("k-a"))[0]["document_version"]
    assert third != after


@pytest.mark.asyncio
async def test_delete_then_restore_same_id(kb_env):
    """删除清干净旧 chunk；同 ID 重新创建后 chunk 恢复，两步 worker 可见。"""
    owner_id, _owner_b, worker, session_factory = kb_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "一段|二段", "k-b": "别的"})
    stats: dict = {}
    await pipeline.update_document(owner_id, "knowledge", "k-a", operation="delete", stats_out=stats)
    assert stats["delete_count"] == 2
    async with session_factory() as db:
        assert await load_parent_documents(db, owner_id, "knowledge", "k-a") == []

    # 恢复：同 ID 重新保存（version 推进），文档级增量把 chunk 写回
    await _save_entry(owner_id, "k-a", "复活一段|复活二段")
    stats = {}
    count = await pipeline.update_document(owner_id, "knowledge", "k-a", stats_out=stats)
    assert count == 2 and stats["upsert_count"] == 2
    async with session_factory() as db:
        rows = await load_parent_documents(db, owner_id, "knowledge", "k-a")
        kept = await load_parent_documents(db, owner_id, "knowledge", "k-b")
    assert len(rows) == 2 and all("复活" in r.content for r in rows)
    assert len(kept) == 1
    assert worker.ops() == ["patch", "patch"]


@pytest.mark.asyncio
async def test_projection_failure_leaves_old_chunks_intact(kb_env, caplog, monkeypatch):
    """apply_document_patch 事务失败：DB 保留旧投影，事件按失败处理不伪装成功。"""
    import logging as _logging

    owner_id, _owner_b, worker, session_factory = kb_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "旧一段|旧二段"})
    await _save_entry(owner_id, "k-a", "新一段|新二段")

    async def broken_patch(db, user_id, source_type, source_id, upserts):
        raise RuntimeError("db write door")
    monkeypatch.setattr(pipeline, "apply_document_patch", broken_patch)

    with caplog.at_level(_logging.INFO, logger="agent.rag.index"):
        assert await pipeline.handle_rag_index_event(RagIndexUpdated(
            user_id=owner_id, source_type="knowledge", source_id="k-a")) is False
    async with session_factory() as db:
        rows = await load_parent_documents(db, owner_id, "knowledge", "k-a")
    assert len(rows) == 2 and all("旧" in r.content for r in rows)
    assert worker.ops() == []   # DB 没推进就不打 worker
    assert "projection_failed" in caplog.text


@pytest.mark.asyncio
async def test_vector_partial_failure_keeps_lexical_and_replays_idempotent(kb_env, monkeypatch):
    """向量同步部分失败：lexical DB 投影已提交不受影响；重放幂等（no_change），
    最终一致性交给查询侧 delta sync（PRD §8.2 / §5.3）。"""
    from agent.knowledge import vector_cache as knowledge_vector_cache

    owner_id, _owner_b, worker, session_factory = kb_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "一段|二段"})
    await _save_entry(owner_id, "k-a", "换新一段|换新二段")

    calls = {"n": 0}
    original = knowledge_vector_cache.apply_vector_delta

    async def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("embedding provider 503")
        return await original(*args, **kwargs)
    monkeypatch.setattr(knowledge_vector_cache, "apply_vector_delta", flaky)

    stats: dict = {}
    try:
        await pipeline.update_document(owner_id, "knowledge", "k-a", stats_out=stats)
        raise AssertionError("首次调用应因向量失败抛出")
    except RuntimeError:
        pass
    # lexical DB 投影已提交：新内容已在 DB
    async with session_factory() as db:
        rows = await load_parent_documents(db, owner_id, "knowledge", "k-a")
    assert len(rows) == 2 and all("换新" in r.content for r in rows)

    # 重放同一事件：主数据与投影一致 → no_change 幂等，不重复打 worker
    stats = {}
    result = await pipeline.update_document(owner_id, "knowledge", "k-a", stats_out=stats)
    assert stats["status"] == "no_change" and result == 2
    assert worker.ops() == []


@pytest.mark.asyncio
async def test_folder_move_clears_old_scope(kb_env):
    """文件夹/阶段移动：新 scope 可见、旧 scope 无残留（PRD Phase 2 验收）。"""
    from agent.rag.index_builder import build_single_source_record
    from app.models import File

    owner_id, _owner_b, _worker, session_factory = kb_env
    async with session_factory() as db:
        from app.services.storage import get_storage as _get_storage

        await _get_storage().put(
            f"{owner_id}/p5/move.md", "移动一段|移动二段".encode("utf-8"), "text/markdown",
        )
        row = File(
            user_id=owner_id, display_name="移动我.md", ext="md", space="project",
            storage_key=f"{owner_id}/p5/move.md", size_bytes=6,
            mime_type="text/markdown", version=1, stage_name="阶段一",
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        file_id = str(row.id)
        from agent.rag.index_builder import build_source_records

        records = await build_source_records(db, owner_id, "file")
        documents = _fake_projection(records) if records else []
        if documents:
            await replace_source_documents(db, owner_id, "file", documents)
        await db.commit()
        # 移动到新阶段 + version 推进
        row.stage_name = "阶段二"
        row.version = 2
        await db.commit()

    async with session_factory() as db:
        record = await build_single_source_record(db, owner_id, "file", file_id)
    assert record is not None
    stats: dict = {}
    count = await pipeline.update_document(owner_id, "file", file_id, stats_out=stats)
    assert stats["status"] == "ready"
    async with session_factory() as db:
        rows = await load_index_documents(db, owner_id, source_types={"file"})
    mine = [r for r in rows if r.source_id == file_id]
    assert count == len(mine)
    # 移动后投影文本进新阶段、旧阶段无残留（对齐 TS files 适配器的阶段渲染）
    assert any("阶段：阶段二" in r.content for r in mine)
    assert all("阶段一" not in r.content for r in mine)
    assert all(r.title == "移动我.md" for r in mine)


def _fake_projection_knowledge(records):
    """file 投影与 test_rag_file_project_delta 同款（version_parts 取位）。"""
    documents = []
    for record, scope in records:
        parts = [p for p in record["content"].split("|") if p]
        version_parts = record.get("version_parts") or []
        version = str(version_parts[1]) if len(version_parts) > 1 else "1"
        source_id = str(record.get("source_id") or record.get("id"))
        for index, part in enumerate(parts):
            documents.append(IndexDocument(
                document_id=f"{source_id}:{version}:{index}",
                source_type=record["source_type"], source_id=source_id,
                scope=scope, title=record["title"], summary=record.get("summary", ""),
                content=part, version=version, chunk_index=index,
                chunk_count=len(parts),
                parent_document_id=str(record.get("parent_id") or source_id),
            ))
    return documents


@pytest.mark.asyncio
async def test_owner_scope_isolation_on_patch(kb_env):
    """owner 隔离：A 的文档级 patch 不触碰 B 的任何投影行。"""
    owner_a, owner_b, _worker, session_factory = kb_env
    async with session_factory() as db:
        await _full_seed(db, owner_a, {"k-a": "甲一段|甲二段"})
        await _full_seed(db, owner_b, {"k-b": "乙独有一段"})
    await _save_entry(owner_a, "k-a", "甲改一段|甲改二段")
    stats: dict = {}
    await pipeline.update_document(owner_a, "knowledge", "k-a", stats_out=stats)
    assert stats["status"] == "ready"
    async with session_factory() as db:
        rows_b = await load_index_documents(db, owner_b, source_types={"knowledge"})
    assert len(rows_b) == 1
    assert rows_b[0].content == "乙独有一段"


@pytest.mark.asyncio
async def test_partial_edit_keeps_unchanged_chunks(kb_env):
    """回归：多 chunk 文档只改其中一段时，未变化 chunk 不得被误打墓碑。

    曾因 update_document 只把 delta.upserts 传给父文档作用域 replace
    （apply_document_patch），未变化 chunk 被静默从索引删除。
    """
    owner_id, _owner_b, worker, session_factory = kb_env
    async with session_factory() as db:
        await _full_seed(db, owner_id, {"k-a": "第一段不动|第二段不动|第三段要改"})
    await _save_entry(owner_id, "k-a", "第一段不动|第二段不动|第三段已修改")
    stats: dict = {}
    count = await pipeline.update_document(owner_id, "knowledge", "k-a", stats_out=stats)
    assert stats["status"] == "ready"
    async with session_factory() as db:
        rows = await load_parent_documents(db, owner_id, "knowledge", "k-a")
    assert count == 3
    assert len(rows) == 3, "未变化的 chunk 必须保留在索引中"
    contents = {r.content for r in rows}
    assert contents == {"第一段不动", "第二段不动", "第三段已修改"}
    # worker 只收真正变化的 1 个 chunk（增量语义不变）
    patch_call = worker.calls[-1][1]
    assert len(patch_call["upserts"]) == 1
