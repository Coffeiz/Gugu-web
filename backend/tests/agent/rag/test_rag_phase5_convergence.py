"""PRD-RAG-9 Phase 5：合并不丢多文档、outbox 重放收敛、诊断七态与脱敏。

覆盖 PRD §10 Phase 5 前四项验收：
- 阻塞文档 A 的 patch 时连续提交 B/C，三个都进索引（bus 与 outbox 两级）；
- 重启后从 outbox 重放同一批 ID，DB projection、worker revision 一致收敛；
- 来源真实变更（folder 移动旧 scope 不再召回在 test_rag_file_project_delta
  覆盖，这里补 source-level refresh 覆盖文档级 pending 的语义）；
- 诊断 mode/status 七态与写路径脱敏。
不启动真实 TS worker：投影与 worker 都用 fake（同 test_rag_knowledge_delta_index）。
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import agent.rag.pipeline as pipeline
from agent.events import bus
from agent.events.types import RagIndexUpdated
from agent.rag import index_jobs
from agent.rag.models import IndexDocument, Scope
from agent.rag.persistent_store import load_parent_documents, replace_source_documents
from agent.rag.ts_sidecar import TsSidecarUnavailable
from app.core.tz import now_utc
from app.models import Base, User, RagIndexJob
from app.services.storage import LocalStorageBackend


# ── 基建（与 test_rag_knowledge_delta_index 同款：独立内存库 + fake worker） ──

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
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as db:
        owner = User(id=uuid.uuid4(), username=f"p5-{uuid.uuid4().hex[:8]}",
                     email="p5@test.local", hashed_password="x")
        db.add(owner)
        await db.commit()
        owner_id = owner.id

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

    return owner_id, worker, session_factory


async def _seed_entry(owner_id, entry_id: str, content: str) -> None:
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


async def _modify_entry(owner_id, entry_id: str, content: str):
    from agent.knowledge.capture import build_entry
    from agent.knowledge.store import KnowledgeStore

    entry = build_entry(owner_id, {
        "title": f"条目 {entry_id}", "content": content, "topic": f"主题{entry_id}",
        "keywords": ["关键词"], "source_type": "user", "source_ref": "", "source_label": "测试",
        "confidence": "confirmed",
    })
    entry.id = entry_id
    return await KnowledgeStore(owner_id).save(entry)


# ── 1. bus：同源多文档合并不丢 ID ──

@pytest.mark.asyncio
async def test_bus_keeps_all_pending_source_ids(monkeypatch):
    """阻塞 A 的处理时连续提交 B/C：三个文档最终都被处理（PRD §5.2 规则 2）。"""
    key = ("p5-bus-owner", "knowledge")
    processed: list[str] = []
    first_started = asyncio.Event()
    release = asyncio.Event()

    async def fake_update(event):
        processed.append(str(event.source_id))
        if len(processed) == 1:
            first_started.set()
            await release.wait()
        return True

    monkeypatch.setattr(bus, "_log_rag_index_updated", fake_update)
    bus._rag_pending.pop(key, None)
    bus._rag_status.pop(key, None)
    try:
        bus._enqueue_rag_index_event(RagIndexUpdated(
            user_id=key[0], source_type=key[1], source_id="k-a", operation="upsert"))
        await first_started.wait()
        # A 处理期间提交 B 和 C：各自保留，不能被覆盖
        bus._enqueue_rag_index_event(RagIndexUpdated(
            user_id=key[0], source_type=key[1], source_id="k-b", operation="upsert"))
        bus._enqueue_rag_index_event(RagIndexUpdated(
            user_id=key[0], source_type=key[1], source_id="k-c", operation="delete"))
        # 同 ID 重复事件仍应合并成最新一条
        bus._enqueue_rag_index_event(RagIndexUpdated(
            user_id=key[0], source_type=key[1], source_id="k-b", operation="delete"))
        release.set()
        await bus._rag_workers[key]

        assert sorted(processed) == ["k-a", "k-b", "k-c"]
        assert bus.get_rag_index_status(*key)["pending"] is False
    finally:
        bus._rag_pending.pop(key, None)
        bus._rag_status.pop(key, None)
        worker = bus._rag_workers.pop(key, None)
        if worker is not None and not worker.done():
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)


@pytest.mark.asyncio
async def test_bus_refresh_event_overrides_document_pending(monkeypatch):
    """无 source_id 的 refresh 升级为来源级重建，清空文档级 pending（§5.2 规则 3）。"""
    key = ("p5-bus-refresh", "knowledge")
    processed: list[str] = []
    first_started = asyncio.Event()
    release = asyncio.Event()

    async def fake_update(event):
        processed.append(str(event.source_id))
        if len(processed) == 1:
            first_started.set()
            await release.wait()
        return True

    monkeypatch.setattr(bus, "_log_rag_index_updated", fake_update)
    bus._rag_pending.pop(key, None)
    bus._rag_status.pop(key, None)
    try:
        bus._enqueue_rag_index_event(RagIndexUpdated(
            user_id=key[0], source_type=key[1], source_id="k-a", operation="upsert"))
        await first_started.wait()
        bus._enqueue_rag_index_event(RagIndexUpdated(
            user_id=key[0], source_type=key[1], source_id="k-b", operation="upsert"))
        # 来源级事件：全量重建语义覆盖 k-b 的文档级 pending
        bus._enqueue_rag_index_event(RagIndexUpdated(
            user_id=key[0], source_type=key[1], source_id="", operation="refresh"))
        release.set()
        await bus._rag_workers[key]

        assert processed == ["k-a", ""]
    finally:
        bus._rag_pending.pop(key, None)
        bus._rag_status.pop(key, None)
        worker = bus._rag_workers.pop(key, None)
        if worker is not None and not worker.done():
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)


# ── 2. durable outbox：多 ID 保留、逐 ID 移除、失败保留 ──

@pytest.mark.asyncio
async def test_outbox_keeps_pending_ids_and_replays_each(db, user_a, monkeypatch):
    monkeypatch.setattr(index_jobs, "_is_ephemeral_sqlite", lambda _f: False)
    ids = [f"k-{n}" for n in ("a", "b", "c")]
    for source_id in ids:
        await index_jobs.persist_event(RagIndexUpdated(
            user_id=user_a.id, source_type="knowledge", source_id=source_id))

    row = (await db.execute(
        select(RagIndexJob).where(RagIndexJob.user_id == user_a.id)
    )).scalar_one()
    assert row.pending_source_ids == ids   # 合并只去重，不丢文档

    retry_time = now_utc() + timedelta(seconds=1)
    monkeypatch.setattr(index_jobs, "now_utc", lambda: retry_time)
    due = await index_jobs.due_events()
    assert sorted(e.source_id for e in due) == ids
    assert all(e.replayed for e in due)
    assert all(e.operation == "upsert" for e in due)

    # 逐 ID 成功后逐 ID 移除；全部完成集合清空
    processed: list[str] = []
    for source_id in ids:
        event = next(e for e in due if e.source_id == source_id)
        generation = await index_jobs.mark_running(event)
        assert generation is not None
        assert await index_jobs.mark_result(event, generation, success=True) == 0.0
        processed.append(source_id)
        await db.refresh(row)
        assert row.pending_source_ids == [i for i in ids if i not in processed]
    assert row.pending_source_ids == []
    assert row.status == "ready"

    # 失败时保留集合供到期重放
    await index_jobs.persist_event(RagIndexUpdated(
        user_id=user_a.id, source_type="knowledge", source_id="k-d"))
    monkeypatch.setattr(index_jobs, "now_utc", lambda: now_utc() + timedelta(seconds=1))
    due2 = await index_jobs.due_events()
    assert [e.source_id for e in due2] == ["k-d"]
    await index_jobs.mark_running(due2[0])
    await index_jobs.mark_result(due2[0], await _current_generation(db, user_a), success=False)
    await db.refresh(row)
    assert row.pending_source_ids == ["k-d"]


async def _current_generation(db, user_a) -> int:
    row = (await db.execute(
        select(RagIndexJob).where(RagIndexJob.user_id == user_a.id)
    )).scalar_one()
    return int(row.generation)


@pytest.mark.asyncio
async def test_outbox_source_level_success_clears_pending_ids(db, user_a, monkeypatch):
    monkeypatch.setattr(index_jobs, "_is_ephemeral_sqlite", lambda _f: False)
    for source_id in ("k-a", "k-b"):
        await index_jobs.persist_event(RagIndexUpdated(
            user_id=user_a.id, source_type="knowledge", source_id=source_id))
    # 来源级事件：集合清空
    await index_jobs.persist_event(RagIndexUpdated(
        user_id=user_a.id, source_type="knowledge", source_id="", operation="refresh"))

    row = (await db.execute(
        select(RagIndexJob).where(RagIndexJob.user_id == user_a.id)
    )).scalar_one()
    assert row.pending_source_ids == []
    monkeypatch.setattr(index_jobs, "now_utc", lambda: now_utc() + timedelta(seconds=1))
    due = await index_jobs.due_events()
    assert len(due) == 1 and due[0].source_id == ""
    await index_jobs.mark_running(due[0])
    await index_jobs.mark_result(due[0], await _current_generation(db, user_a), success=True)
    await db.refresh(row)
    assert row.pending_source_ids == []


# ── 3. 重启重放端到端收敛：DB projection + worker revision 一致 ──

@pytest.mark.asyncio
async def test_outbox_replay_converges_after_restart(rag_env, monkeypatch):
    """业务写入 → outbox 持久化 →（进程重启，内存队列丢失）→ 重放全部 ID
    → 最终 DB projection 与 worker revision 一致，再无到期任务。"""
    owner_id, worker, session_factory = rag_env
    async with session_factory() as db:
        await _seed_entry(owner_id, "k-a", "甲一段|甲二段")
        await _seed_entry(owner_id, "k-b", "乙一段")
        from agent.rag.adapters.knowledge import KnowledgeAdapter

        records = await KnowledgeAdapter(owner_id).build_source_records()
        documents = _fake_projection(records)
        await replace_source_documents(db, owner_id, "knowledge", documents)
        await db.commit()

    # 两个文档相继变更（真实场景会各自 publish；这里直接模拟事件持久化后进程崩溃）
    await _modify_entry(owner_id, "k-a", "甲改一段|甲改二段|甲改三段")
    await _modify_entry(owner_id, "k-b", "乙改一段")

    # monkeypatch index_jobs 的 session_factory 到 rag_env 的独立引擎
    import app.db.session as db_session
    monkeypatch.setattr(index_jobs, "_is_ephemeral_sqlite", lambda _f: False)
    monkeypatch.setattr(index_jobs, "_session_factory", lambda: db_session._SessionLocal)

    for source_id in ("k-a", "k-b"):
        await index_jobs.persist_event(RagIndexUpdated(
            user_id=owner_id, source_type="knowledge", source_id=source_id))

    # 「重启」：重放路径只依赖 outbox 行
    monkeypatch.setattr(index_jobs, "now_utc", lambda: now_utc() + timedelta(seconds=1))
    due = await index_jobs.due_events()
    assert sorted(e.source_id for e in due) == ["k-a", "k-b"]
    assert all(e.replayed for e in due)

    for event in due:
        # 模拟 bus 的持久簿记：认领租约 + 成功结果（逐 ID 移除 pending）
        generation = await index_jobs.mark_running(event)
        assert await pipeline.handle_rag_index_event(event) is True
        assert await index_jobs.mark_result(event, generation, success=True) == 0.0

    async with session_factory() as db:
        rows_a = await load_parent_documents(db, owner_id, "knowledge", "k-a")
        rows_b = await load_parent_documents(db, owner_id, "knowledge", "k-b")
        revision = await pipeline._owner_revision(db, owner_id)
    assert len(rows_a) == 3 and all("甲改" in r.content for r in rows_a)
    assert len(rows_b) == 1 and "乙改" in rows_b[0].content
    # worker revision 与 DB projection revision 收敛到同一点
    assert worker.revision == revision
    assert worker.ops().count("patch") == 2

    # 全部成功后 outbox 清空：不再有到期任务
    monkeypatch.setattr(index_jobs, "now_utc", lambda: now_utc() + timedelta(seconds=2))
    assert await index_jobs.due_events() == []


# ── 4. Conversation/Memory 例外回归（PRD §7 保留路径） ──

@pytest.mark.asyncio
async def test_conversation_event_stays_source_level(monkeypatch, rag_env):
    """conversation 即使带 source_id 也不走文档级 patch（保留 watermark 语义）。"""
    owner_id, _worker, _sf = rag_env
    routed: list[str] = []

    async def fake_rebuild(user_id, source_type, *, operation="upsert", stats_out=None):
        routed.append(source_type)
        return 1

    monkeypatch.setattr(pipeline, "rebuild_source_index", fake_rebuild)
    assert await pipeline.handle_rag_index_event(RagIndexUpdated(
        user_id=owner_id, source_type="conversation", source_id="msg-1")) is True
    assert routed == ["conversation"]


@pytest.mark.asyncio
async def test_memory_event_uses_dedicated_rebuild(monkeypatch, rag_env):
    """memory 事件走专用全量重建 + 瞬态槽语义，不进 DOCUMENT_PATCH 路径。"""
    owner_id, _worker, _sf = rag_env
    calls: list[str] = []

    async def fake_rebuild(user_id, *, operation="upsert"):
        calls.append(str(user_id))
        return 1

    monkeypatch.setattr(pipeline, "rebuild_memory_index", fake_rebuild)
    assert await pipeline.handle_memory_index_event(RagIndexUpdated(
        user_id=owner_id, source_type="memory")) is True
    assert calls == [str(owner_id)]


# ── 5. 诊断七态与脱敏（PRD §9） ──

@pytest.mark.asyncio
async def test_diagnostic_modes_and_statuses(rag_env, caplog, monkeypatch):
    """mode/status 七态：document_patch、source_replace、no_change、
    worker_unavailable、revision_mismatch、projection_failed、event_replayed。"""
    import logging as _logging

    owner_id, worker, session_factory = rag_env
    async with session_factory() as db:
        await _seed_entry(owner_id, "k-a", "一段|二段")
        await _seed_entry(owner_id, "k-b", "另一条")
        from agent.rag.adapters.knowledge import KnowledgeAdapter

        records = await KnowledgeAdapter(owner_id).build_source_records()
        documents = _fake_projection(records)
        await replace_source_documents(db, owner_id, "knowledge", documents)
        await db.commit()

    with caplog.at_level(_logging.INFO, logger="agent.rag.index"):
        # document_patch + no_change（主数据与索引一致）
        assert await pipeline.handle_rag_index_event(RagIndexUpdated(
            user_id=owner_id, source_type="knowledge", source_id="k-a")) is True

        # document_patch + ready
        await _modify_entry(owner_id, "k-a", "改一段|改二段")
        assert await pipeline.handle_rag_index_event(RagIndexUpdated(
            user_id=owner_id, source_type="knowledge", source_id="k-a")) is True

        # revision_mismatch → 回退 source_replace（mode 显式切换）
        await _modify_entry(owner_id, "k-a", "再改一段|再改二段")
        worker.fail_patch_codes = ["revision_mismatch"]
        assert await pipeline.handle_rag_index_event(RagIndexUpdated(
            user_id=owner_id, source_type="knowledge", source_id="k-a")) is True

        # worker_unavailable
        await _modify_entry(owner_id, "k-a", "三改一段|三改二段")
        worker.fail_patch_codes = ["worker_crashed"]
        assert await pipeline.handle_rag_index_event(RagIndexUpdated(
            user_id=owner_id, source_type="knowledge", source_id="k-a")) is True

        # event_replayed（重放成功且真实收敛，与首投递区分）
        await _modify_entry(owner_id, "k-a", "重放触发一段|重放触发二段")
        assert await pipeline.handle_rag_index_event(RagIndexUpdated(
            user_id=owner_id, source_type="knowledge", source_id="k-a",
            replayed=True)) is True

        # projection_failed（管线连续失败）
        async def boom(*_a, **_k):
            raise RuntimeError("projection down")
        monkeypatch.setattr(pipeline, "update_document", boom)
        assert await pipeline.handle_rag_index_event(RagIndexUpdated(
            user_id=owner_id, source_type="knowledge", source_id="k-x")) is False

    payloads = [line for line in caplog.text.splitlines() if '"t": "rag_index"' in line
                or '"t":"rag_index"' in line]
    assert payloads, "record_index_update 应实际落日志（回归：_log/json 未定义静默丢日志）"
    modes = {m for p in payloads for m in [_extract(p, "mode")] if m}
    statuses = {m for p in payloads for m in [_extract(p, "status")] if m}
    assert {"document_patch", "source_replace"} <= modes
    assert {"no_change", "ready", "worker_unavailable", "event_replayed",
            "projection_failed"} <= statuses


def _extract(line: str, field: str) -> str:
    import json as _json
    start = line.find("{")
    if start < 0:
        return ""
    try:
        payload = _json.loads(line[start:])
    except Exception:
        return ""
    return str(payload.get(field, ""))


@pytest.mark.asyncio
async def test_write_path_logs_never_contain_content(rag_env, caplog):
    """PRD §9 脱敏：写路径日志不得出现正文、条目标题或查询原文。"""
    import logging as _logging

    owner_id, _worker, session_factory = rag_env
    marker = "绝密正文标记XYZQ"
    async with session_factory() as db:
        await _seed_entry(owner_id, "k-a", f"{marker}|二段")
        await _seed_entry(owner_id, "k-b", "别的")
        from agent.rag.adapters.knowledge import KnowledgeAdapter

        records = await KnowledgeAdapter(owner_id).build_source_records()
        documents = _fake_projection(records)
        await replace_source_documents(db, owner_id, "knowledge", documents)
        await db.commit()

    with caplog.at_level(_logging.INFO):
        await _modify_entry(owner_id, "k-a", f"{marker}改|二段")
        await pipeline.handle_rag_index_event(RagIndexUpdated(
            user_id=owner_id, source_type="knowledge", source_id="k-a"))
    assert marker not in caplog.text
