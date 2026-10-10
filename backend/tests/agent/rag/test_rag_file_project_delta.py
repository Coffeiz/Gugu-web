"""PRD-RAG-9 Phase 2：项目的文档级增量。

覆盖：项目字段/阶段变化走项目级增量；受影响集合 = 单对象；publish(entity_id)
透传为文档级 RagIndexUpdated。文件来源已退出 RAG，不在此验证旧索引契约。
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
from app.models import Base, Project, User


def _fake_projection(records):
    """测试投影：来源正文按「|」分段。"""
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

    async def patch(self, upserts, deletes, revision, base_revision, *, vectors=None, vector_version="", storage_owner_id=None):
        self.calls.append(("patch", {"upserts": [d.chunk_id for d in upserts], "deletes": list(deletes)}))
        self.revision = revision

    async def replace(self, documents, revision, *, vectors=None, vector_version="", storage_owner_id=None):
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

    worker = FakeWorker()
    async def fake_client(_user_id):
        return worker
    monkeypatch.setattr(pipeline, "_knowledge_client", fake_client)
    async def fake_project(owner_user_id, source_type, records, **_kwargs):
        return _fake_projection(records)
    monkeypatch.setattr(pipeline, "records_to_write_documents", fake_project)
    yield owner_id, worker, session_factory
    await engine.dispose()


async def _full_seed(db, owner_id: object) -> None:
    from agent.rag.index_builder import build_source_records

    records = await build_source_records(db, owner_id, "project")
    if records:
        await replace_source_documents(db, owner_id, "project", _fake_projection(records))
    await db.commit()


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
    """索引来源发布逐条文档事件；文件资源不再触发 RAG 事件。"""
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
        "u-1", ["projects"], "update", entity_ids=["11", "12"],
    )
    assert [evt.source_id for evt in published] == ["11", "12"]
    assert all(evt.source_type == "project" for evt in published)
    published.clear()
    core_events._publish_rag_index_events("u-1", ["files"], "update", entity_ids=["11"])
    assert published == []
