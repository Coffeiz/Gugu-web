"""PRD-RAG-9 Phase 2：文件与项目的文档级增量。

覆盖：单文件覆盖/重命名/移动/删除只触碰自身 chunk；项目字段/阶段变化走
项目级增量；受影响集合 = 单对象（file record 不含 folder 名、project record
不依赖文件正文）；publish(entity_id) 透传为文档级 RagIndexUpdated。
"""
from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import agent.rag.pipeline as pipeline
from agent.events.types import RagIndexUpdated
from agent.rag.models import IndexDocument, Scope
from agent.rag.persistent_store import load_parent_documents, replace_source_documents
from app.models import Base, File, Project, User
from app.services.storage import LocalStorageBackend


def _fake_projection(records):
    """测试投影：正文按「|」分段；version 取 record 的 version_parts 第二位。"""
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


class FakeWorker:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.revision: str | None = "seed"

    async def patch(self, upserts, deletes, revision, base_revision, *, vectors=None, vector_version=""):
        self.calls.append(("patch", {"upserts": [d.chunk_id for d in upserts], "deletes": list(deletes)}))
        self.revision = revision

    async def replace(self, documents, revision, *, vectors=None, vector_version=""):
        self.calls.append(("replace", {"chunks": [d.chunk_id for d in documents]}))
        self.revision = revision

    async def close(self):
        return None

    def ops(self):
        return [op for op, _ in self.calls]


@pytest_asyncio.fixture
async def fp_env(monkeypatch, tmp_path):
    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as db:
        owner = User(id=uuid.uuid4(), username=f"fpdelta-{uuid.uuid4().hex[:8]}",
                     email="fpdelta@test.local", hashed_password="x")
        db.add(owner)
        await db.commit()
        owner_id = owner.id

    monkeypatch.setattr(pipeline, "_in_memory_sqlite", lambda _engine: False)
    import asyncio as _asyncio
    import app.db.session as db_session
    monkeypatch.setattr(db_session, "_engine", engine)
    monkeypatch.setattr(db_session, "_SessionLocal", session_factory, raising=False)
    monkeypatch.setattr(db_session, "_engine_loop", _asyncio.get_running_loop())

    storage = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: storage)
    monkeypatch.setattr("agent.knowledge.store.get_storage", lambda: storage)
    monkeypatch.setattr("agent.rag.index_builder.get_storage", lambda: storage)

    worker = FakeWorker()
    async def fake_client(_user_id):
        return worker
    monkeypatch.setattr(pipeline, "_knowledge_client", fake_client)
    async def fake_project(owner_user_id, source_type, records, **_kwargs):
        return _fake_projection(records)
    monkeypatch.setattr(pipeline, "records_to_write_documents", fake_project)
    return owner_id, worker, session_factory


async def _mk_file(db, owner_id, name: str, content: str, ext: str = "md") -> File:
    row = File(
        user_id=owner_id, display_name=name, ext=ext, space="project",
        storage_key=f"{owner_id}/fp/{name}", size_bytes=len(content),
        mime_type="text/markdown", version=1,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    await storage_put(monkeypatch=None, key=row.storage_key, content=content)
    return row


async def storage_put(monkeypatch, key: str, content: str) -> None:
    from app.services.storage import get_storage

    await get_storage().put(key, content.encode("utf-8"), "text/markdown")


async def _full_seed(db, owner_id: object) -> None:
    from agent.rag.index_builder import build_source_records

    for source_type in ("file", "project"):
        records = await build_source_records(db, owner_id, source_type)
        if records:
            await replace_source_documents(db, owner_id, source_type, _fake_projection(records))
    await db.commit()


@pytest.mark.asyncio
async def test_file_overwrite_patches_only_that_file(fp_env):
    owner_id, worker, session_factory = fp_env
    async with session_factory() as db:
        row = await _mk_file(db, owner_id, "a.md", "文件A一段|文件A二段")
        await _mk_file(db, owner_id, "b.md", "文件B一段")
        await _full_seed(db, owner_id)
        file_id = row.id
        # 覆盖写：换正文 + version 推进
        row.version = 2
        await db.commit()
    await storage_put(None, f"{owner_id}/fp/a.md", "新A一段|新A二段|新A三段")
    stats: dict = {}
    count = await pipeline.update_document(owner_id, "file", str(file_id), stats_out=stats)
    assert stats["mode"] == "document_patch" and stats["status"] == "ready"
    assert count == 3
    assert worker.ops() == ["patch"]
    patch_call = worker.calls[0][1]
    assert all(cid.startswith(f"{file_id}:") for cid in patch_call["upserts"])
    async with session_factory() as db:
        rows_a = await load_parent_documents(db, owner_id, "file", str(file_id))
        rows_b = await load_parent_documents(db, owner_id, "file", None) if False else None
        from agent.rag.persistent_store import load_index_documents
        everything = await load_index_documents(db, owner_id, source_types={"file"})
    assert [r.chunk_index for r in rows_a] == [0, 1, 2]
    assert all("新A" in r.content for r in rows_a)
    # b.md 完全不受影响：总共 3+1 条
    assert len(everything) == 4


@pytest.mark.asyncio
async def test_file_delete_removes_only_that_file(fp_env):
    owner_id, worker, session_factory = fp_env
    async with session_factory() as db:
        row = await _mk_file(db, owner_id, "a.md", "A一段|A二段")
        await _mk_file(db, owner_id, "b.md", "B一段")
        await _full_seed(db, owner_id)
        file_id = row.id
    stats: dict = {}
    remaining = await pipeline.update_document(
        owner_id, "file", str(file_id), operation="delete", stats_out=stats,
    )
    assert remaining == 0 and stats["delete_count"] == 2
    async with session_factory() as db:
        from agent.rag.persistent_store import load_index_documents
        everything = await load_index_documents(db, owner_id, source_types={"file"})
    assert len(everything) == 1
    assert everything[0].source_id != str(file_id)


@pytest.mark.asyncio
async def test_file_rename_and_move_change_record_digest(fp_env):
    """重命名/移动改变 record（title/folder 字段）→ 文档级 upsert；旧 scope 无残留。"""
    from agent.rag.index_builder import build_single_source_record

    owner_id, worker, session_factory = fp_env
    async with session_factory() as db:
        row = await _mk_file(db, owner_id, "旧名.md", "一段|二段")
        await _full_seed(db, owner_id)
        file_id = row.id
        row.display_name = "新名.md"
        row.stage_name = "阶段二"
        row.version = 2
        await db.commit()
    record = await build_single_source_record(db, owner_id, "file", str(file_id))
    assert record is not None
    assert record[0]["title"] == "新名.md"
    assert record[0]["stage_name"] == "阶段二"
    stats: dict = {}
    await pipeline.update_document(owner_id, "file", str(file_id), stats_out=stats)
    assert stats["status"] == "ready" and stats["upsert_count"] == 2
    async with session_factory() as db:
        rows = await load_parent_documents(db, owner_id, "file", str(file_id))
    assert all(r.title == "新名.md" for r in rows)


@pytest.mark.asyncio
async def test_project_field_and_stage_change_incremental(fp_env):
    owner_id, worker, session_factory = fp_env
    async with session_factory() as db:
        project = Project(user_id=owner_id, name="项目甲", status="active",
                          stages_json='[{"name":"阶段一"}]')
        db.add(project)
        await db.commit()
        await db.refresh(project)
        project_id = project.id
        await _full_seed(db, owner_id)
        # 字段+阶段变化
        project.name = "项目甲改"
        project.progress = 40
        project.stages_json = '[{"name":"阶段一"},{"name":"阶段二"}]'
        project.version = 2
        await db.commit()
    stats: dict = {}
    count = await pipeline.update_document(owner_id, "project", str(project_id), stats_out=stats)
    assert stats["mode"] == "document_patch" and stats["status"] == "ready"
    assert count >= 1
    assert worker.ops() == ["patch"]
    async with session_factory() as db:
        rows = await load_parent_documents(db, owner_id, "project", str(project_id))
    joined = "\n".join(r.content for r in rows)
    assert "项目甲改" in joined
    assert "阶段二" in joined
    assert "40%" in joined


@pytest.mark.asyncio
async def test_project_delete_removes_chunks(fp_env):
    owner_id, worker, session_factory = fp_env
    async with session_factory() as db:
        project = Project(user_id=owner_id, name="待删项目", status="active")
        db.add(project)
        await db.commit()
        await db.refresh(project)
        project_id = project.id
        await _full_seed(db, owner_id)
    stats: dict = {}
    remaining = await pipeline.update_document(
        owner_id, "project", str(project_id), operation="delete", stats_out=stats,
    )
    assert remaining == 0
    async with session_factory() as db:
        rows = await load_parent_documents(db, owner_id, "project", str(project_id))
    assert rows == []


@pytest.mark.asyncio
async def test_publish_entity_ids_flow_into_rag_events(monkeypatch):
    """publish(entity_ids=...) 应转成逐条带 source_id 的文档级事件。"""
    import app.core.events as core_events

    published: list[RagIndexUpdated] = []
    monkeypatch.setattr(core_events, "publish_agent_event", published.append,
                        raising=False)
    real_publish_rag = core_events._publish_rag_index_events
    def spy(user_id, resources, operation, entity_ids=None):
        real_publish_rag(user_id, resources, operation, entity_ids=entity_ids)
    # 拦截 bus.publish
    import agent.events.bus as bus
    monkeypatch.setattr(bus, "publish", lambda event: published.append(event))
    core_events._publish_rag_index_events(
        "u-1", ["files"], "update", entity_ids=["11", "12"],
    )
    assert [evt.source_id for evt in published] == ["11", "12"]
    assert all(evt.source_type == "file" for evt in published)
    published.clear()
    core_events._publish_rag_index_events("u-1", ["files"], "update", entity_ids=None)
    assert len(published) == 1 and published[0].source_id == ""
