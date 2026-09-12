"""PRD-RAG-9 Phase 3：剩余来源（calendar/note/canvas）接入文档级增量 + durable recovery 接线核对。

conversation（record 依赖相邻消息上下文）与 memory（worker 瞬态槽通道）不适用
单文档增量，保持来源级/瞬态全量，见 devlog。
"""
from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import agent.rag.pipeline as pipeline
from agent.rag.index_builder import build_single_source_record
from app.models import (
    Base,
    CalendarEvent,
    MindCanvasItem,
    MindMap,
    MindNode,
    MindRelation,
    User,
)


@pytest_asyncio.fixture
async def rest_env(monkeypatch, tmp_path):
    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as db:
        owner = User(id=uuid.uuid4(), username=f"restdelta-{uuid.uuid4().hex[:8]}",
                     email="restdelta@test.local", hashed_password="x")
        db.add(owner)
        await db.commit()
        owner_id = owner.id
    monkeypatch.setattr(pipeline, "_in_memory_sqlite", lambda _engine: False)
    import asyncio as _asyncio
    import app.db.session as db_session
    monkeypatch.setattr(db_session, "_engine", engine)
    monkeypatch.setattr(db_session, "_SessionLocal", session_factory, raising=False)
    monkeypatch.setattr(db_session, "_engine_loop", _asyncio.get_running_loop())

    class FakeWorker:
        def __init__(self):
            self.calls = []
            self.revision = "seed"

        async def patch(self, upserts, deletes, revision, base_revision, **kwargs):
            self.calls.append(("patch", len(upserts)))
            self.revision = revision

        async def replace(self, documents, revision, **kwargs):
            self.calls.append(("replace", len(documents)))
            self.revision = revision

        async def close(self):
            return None

    worker = FakeWorker()
    async def fake_client(_user_id):
        return worker
    monkeypatch.setattr(pipeline, "_knowledge_client", fake_client)

    async def fake_projection(owner_user_id, source_type, records, **_kwargs):
        from agent.rag.models import IndexDocument, Scope

        docs = []
        for record, scope in records:
            version_parts = record.get("version_parts") or []
            version = str(version_parts[-1] or "1")
            source_id = str(record.get("source_id") or record.get("id"))
            docs.append(IndexDocument(
                document_id=f"{source_id}:{version}:0",
                source_type=record["source_type"], source_id=source_id,
                scope=scope, title=record["title"], summary="",
                content=record.get("content") or record["title"], version=version, chunk_index=0,
                chunk_count=1, parent_document_id=source_id,
            ))
        return docs
    monkeypatch.setattr(pipeline, "records_to_write_documents", fake_projection)
    return owner_id, worker, session_factory


@pytest.mark.asyncio
async def test_calendar_single_record_and_incremental_patch(rest_env):
    owner_id, worker, session_factory = rest_env
    async with session_factory() as db:
        event = CalendarEvent(user_id=owner_id, title="旧标题", date="2026-09-12",
                              description="描述", version=1)
        db.add(event)
        await db.commit()
        await db.refresh(event)
        event_id = event.id
        record = await build_single_source_record(db, owner_id, "calendar", str(event_id))
        assert record is not None
        assert record[0]["title"] == "旧标题"
        event.title = "新标题"
        event.version = 2
        await db.commit()
    stats: dict = {}
    count = await pipeline.update_document(owner_id, "calendar", str(event_id), stats_out=stats)
    assert stats["status"] == "ready" and count == 1
    assert worker.calls == [("patch", 1)]


@pytest.mark.asyncio
async def test_calendar_delete_converges(rest_env):
    owner_id, worker, session_factory = rest_env
    async with session_factory() as db:
        event = CalendarEvent(user_id=owner_id, title="待删", date="2026-09-12")
        db.add(event)
        await db.commit()
        await db.refresh(event)
        event_id = event.id
    stats: dict = {}
    remaining = await pipeline.update_document(
        owner_id, "calendar", str(event_id), operation="delete", stats_out=stats,
    )
    assert remaining == 0


@pytest.mark.asyncio
async def test_note_single_record_skips_canvas_kind(rest_env):
    owner_id, worker, session_factory = rest_env
    async with session_factory() as db:
        node = MindNode(user_id=owner_id, kind="note", title="便签",
                        content_md="md 正文", content_plain="纯文本")
        db.add(node)
        await db.commit()
        await db.refresh(node)
        note_id = node.id
        ref = MindNode(user_id=owner_id, kind="ref", title="引用代理",
                       ref_type="project", ref_id=1)
        db.add(ref)
        await db.commit()
        await db.refresh(ref)
        ref_id = ref.id
    async with session_factory() as db:
        record = await build_single_source_record(db, owner_id, "note", str(note_id))
        assert record is not None and record[0]["title"] == "便签"
        # ref/canvas_note 不进索引（与全量构建一致）
        assert await build_single_source_record(db, owner_id, "note", str(ref_id)) is None


@pytest.mark.asyncio
async def test_canvas_single_record_includes_relation_summary(rest_env):
    owner_id, worker, session_factory = rest_env
    async with session_factory() as db:
        node_a = MindNode(user_id=owner_id, kind="canvas_note", title="节点A", content_plain="A")
        node_b = MindNode(user_id=owner_id, kind="canvas_note", title="节点B", content_plain="B")
        db.add_all([node_a, node_b])
        await db.flush()
        canvas = MindMap(user_id=owner_id, title="画布一")
        db.add(canvas)
        await db.flush()
        item = MindCanvasItem(user_id=owner_id, canvas_id=canvas.id, node_id=node_a.id)
        db.add(item)
        db.add(MindRelation(user_id=owner_id, canvas_id=canvas.id,
                            src_node_id=node_a.id, dst_node_id=node_b.id,
                            rel_type="related"))
        await db.commit()
        await db.refresh(item)
        item_id = item.id
    async with session_factory() as db:
        record = await build_single_source_record(db, owner_id, "canvas", str(item_id))
    assert record is not None
    body = record[0]
    assert body["node_title"] == "节点A"
    assert "节点A → 节点B" in body["relation_summary"]


@pytest.mark.asyncio
async def test_durable_recovery_wired_at_startup():
    """启动恢复循环必须在 main lifespan 注册（事件丢失/重启后可重放）。"""
    import inspect

    from app import main

    source = inspect.getsource(main)
    assert "start_rag_index_recovery()" in source
