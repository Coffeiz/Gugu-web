"""Cython 常驻 sidecar 的 owner 隔离与生命周期 RPC 回归。"""
from __future__ import annotations

import asyncio
import tempfile
import time
import uuid
from pathlib import Path

import pytest

from agent.rag.cython_sidecar import CythonSidecarLifecycle, CythonSidecarTransientIndex
from agent.rag.models import IndexDocument, Scope
from agent.rag.persistent_store import load_rag_index_revision, replace_source_documents
from agent.rag.sidecar_host import SidecarHost


class _FakeLifecycle:
    def __init__(self):
        self.revision = ""
        self.document_count = 2
        self.estimated_bytes = 64
        self.watermark = None
        self.engine = type("Engine", (), {"vector_count": 0, "vector_version": ""})()
        self.calls: list[tuple[str, object]] = []

    async def load_index_from_snapshot_or_database(
        self, _db, _owner, _path, *, vector_version, revision,
    ):
        self.revision = str(revision or "")
        self.engine.vector_version = vector_version
        self.calls.append(("load", self.revision))
        return {"status": "ok", "revision": self.revision, "document_count": 2}

    async def prepare_memory(self, owner, scopes, **options):
        self.calls.append(("memory", (owner, scopes, options)))
        return {"status": "ok", "transient_revision": "memory-r1", "document_count": 1}

    async def unified_query(self, query, **options):
        self.calls.append(("query", (query, options)))
        return {"status": "ok", "revision": self.revision, "selected": []}

    async def flush_snapshot_persistence(self):
        self.calls.append(("flush", None))
        return {"status": "ok"}


@pytest.mark.asyncio
async def test_cython_sidecar_reuses_owner_scoped_lifecycle_over_socket(tmp_path, monkeypatch):
    """同一 owner/cache scope 跨客户端共享索引，Memory scope 和查询选项完整传递。"""
    owner = "00000000-0000-0000-0000-000000000001"
    socket_path = Path(tempfile.gettempdir()) / f"gugu-{uuid.uuid4().hex}.sock"
    host = SidecarHost(str(socket_path))
    created: list[_FakeLifecycle] = []

    async def create_entry(owner, cache_scope):
        from agent.rag.sidecar_host import _CythonEntry

        lifecycle = _FakeLifecycle()
        created.append(lifecycle)
        entry = _CythonEntry(owner, cache_scope, lifecycle, 64, asyncio.get_running_loop().time(), 1)
        host._cython_entries[(owner, cache_scope)] = entry
        return entry

    async def load_entry(entry, revision, vector_version):
        return await entry.lifecycle.load_index_from_snapshot_or_database(
            None, entry.owner, "ignored", revision=revision, vector_version=vector_version,
        )

    monkeypatch.setattr(host, "_create_cython_entry", create_entry)
    monkeypatch.setattr(host, "_load_cython_entry", load_entry)
    await host.start()
    try:
        first = CythonSidecarLifecycle(owner, "shared:baseline", host.socket_path)
        second = CythonSidecarLifecycle(owner, "shared:baseline", host.socket_path)
        await first.load_index_from_snapshot_or_database(
            None, owner, "ignored", revision="r1", vector_version="vec-v1",
        )
        scope = Scope(owner_user_id=owner, scope_type="group", scope_id="group-a")
        prepared = await second.prepare_memory(owner, [scope], snapshot_revision="mem-r1")
        queried = await second.unified_query(
            "查询", revision="r1", searches=[{"scope": scope}], candidate_limit=5,
        )

        assert prepared["transient_revision"] == "memory-r1"
        assert queried["revision"] == "r1"
        assert len(created) == 1
        assert [name for name, _ in created[0].calls] == ["load", "memory", "query"]
        _, memory_call = created[0].calls[1]
        assert memory_call[0] == uuid.UUID(owner)
        assert memory_call[1] == [scope]
        _, query_call = created[0].calls[2]
        assert query_call[0] == "查询"
        assert query_call[1]["searches"][0]["scope"].scope_id == "group-a"

        from agent.rag.sidecar_host import _CythonEntry

        older = _CythonEntry(
            owner, "older-scope", _FakeLifecycle(), 64,
            asyncio.get_running_loop().time() - 2, 0,
        )
        host._cython_entries[(owner, "older-scope")] = older
        reaped = await host._evict_cython_entries(
            ttl_seconds=3600, owner_limit_bytes=100, global_limit_bytes=1024,
        )
        assert reaped == 1
        assert (owner, "older-scope") not in host._cython_entries
    finally:
        await host.stop()
        socket_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_cython_sidecar_rejects_owner_mismatch_before_rpc(tmp_path):
    """远程 lifecycle 不允许调用方替换构造时绑定的 owner。"""
    client = CythonSidecarLifecycle("owner-a", "all", str(tmp_path / "missing.sock"))

    with pytest.raises(ValueError, match="owner 不匹配"):
        await client.load_index_from_snapshot_or_database(
            None, "owner-b", "ignored", revision="r1",
        )


@pytest.mark.asyncio
async def test_cython_sidecar_loads_and_queries_synthetic_owner_index(
    db, user_a, tmp_path, monkeypatch,
):
    """选用 sidecar 时索引缓存把 DB 装载和查询交给常驻 owner lifecycle。"""
    from agent.rag.index_cache import KnowledgeIndexCache
    from app.core.config import get_settings
    import agent.rag.ts_sidecar as ts_sidecar

    document = IndexDocument(
        document_id="doc-a", source_type="knowledge", source_id="doc-a",
        scope=Scope(owner_user_id=str(user_a.id)), title="事件循环", summary="",
        content="FastAPI event loop 的异步调度说明", version="v1",
    )
    await replace_source_documents(db, user_a.id, "knowledge", [document])
    revision = await load_rag_index_revision(db, user_a.id)
    socket_path = Path(tempfile.gettempdir()) / f"gugu-{uuid.uuid4().hex}.sock"
    host = SidecarHost(str(socket_path))
    await host.start()
    try:
        monkeypatch.setattr(ts_sidecar, "_sidecar_socket_path", lambda: host.socket_path)
        diagnostics = {}
        client = await KnowledgeIndexCache()._build_index(
            "cython", user_a.id, None, revision, get_settings().search, diagnostics,
            allow_database_load=True, cache_scope="all", db=db,
        )
        result = await client.unified_query(
            "event loop",
            revision=revision,
            searches=[{
                "source_types": ["knowledge"], "limit": 5,
                "scope": Scope(owner_user_id=str(user_a.id)),
            }],
            source_order=["knowledge"], candidate_limit=5,
            rank_options={"limit": 5, "max_chars": 3000, "max_per_source": 3,
                          "max_per_parent": 3, "selection_mode": "confidence"},
            vector_version="",
        )

        assert diagnostics["cython_sidecar"] is True
        assert client.document_count == 1
        assert result["selected"]
        assert "FastAPI event loop" in result["selected"][0]["text"]
        assert len(host._cython_entries) == 1
    finally:
        await host.stop()
        socket_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_cython_sidecar_caches_transient_capability_index(tmp_path):
    """transient 能力目录跨请求复用 sidecar 索引，并按 owner 隔离 scope。"""
    owner = str(uuid.uuid4())
    socket_path = Path(tempfile.gettempdir()) / f"gugu-{uuid.uuid4().hex}.sock"
    host = SidecarHost(str(socket_path))
    await host.start()
    documents = [IndexDocument(
        document_id="capability:calendar", source_type="capability", source_id="calendar",
        scope=Scope(owner_user_id=owner, scope_type="capability"), title="日历查询",
        summary="查询日历事件", content="查询日历事件并创建提醒", version="catalog-v1",
        metadata={"capability_name": "calendar"},
    )]
    try:
        first = CythonSidecarTransientIndex(owner, documents, "catalog-v1", host.socket_path)
        results, timing = await first.search_with_timing(
            "日历提醒", source_types=("capability",),
            scope=Scope(owner_user_id=owner, scope_type="capability"),
        )
        assert [result.document.source_id for result in results] == ["calendar"]
        assert first.cache_hit is False
        assert timing["candidate_count"] == 1

        second = CythonSidecarTransientIndex(owner, documents, "catalog-v1", host.socket_path)
        await second.search_with_timing("日历", source_types=("capability",))
        assert second.cache_hit is True
        assert len(host._cython_transient_entries) == 1

        other_scope = Scope(owner_user_id=owner, scope_type="capability", scope_id="private")
        scoped_document = IndexDocument(
            **{**documents[0].__dict__, "scope": other_scope},
        )
        scoped = CythonSidecarTransientIndex(
            owner, [scoped_document], "catalog-v1", host.socket_path,
        )
        scoped_results, _ = await scoped.search_with_timing(
            "日历", source_types=("capability",), scope=other_scope,
        )
        assert scoped_results
        assert scoped.cache_hit is False
        assert len(host._cython_transient_entries) == 2

        denied = CythonSidecarTransientIndex(
            str(uuid.uuid4()), documents, "catalog-v1", host.socket_path,
        )
        with pytest.raises(Exception, match="owner 不匹配"):
            await denied.search_with_timing("日历")
    finally:
        await host.stop()
        socket_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_cython_transient_search_does_not_block_sidecar_event_loop(tmp_path):
    """慢 transient 检索期间宿主事件循环仍可处理其他 RAG socket 请求。"""
    from agent.rag.ts_sidecar import _wire_document

    owner = str(uuid.uuid4())
    socket_path = Path(tempfile.gettempdir()) / f"gugu-{uuid.uuid4().hex}.sock"
    host = SidecarHost(str(socket_path))
    document = IndexDocument(
        document_id="capability:calendar", source_type="capability", source_id="calendar",
        scope=Scope(owner_user_id=owner, scope_type="capability"), title="日历查询",
        summary="查询日历事件", content="查询日历事件并创建提醒", version="catalog-v1",
    )
    await host.start()
    try:
        client = CythonSidecarTransientIndex(owner, [document], "catalog-v1", host.socket_path)
        await client.search_with_timing("日历", source_types=("capability",))
        entry = next(iter(host._cython_transient_entries.values()))
        original_search = entry.index.search

        class SlowSearchIndex:
            def search(self, *args, **kwargs):
                time.sleep(0.3)
                return original_search(*args, **kwargs)

        entry.index = SlowSearchIndex()
        payload = {
            "revision": "catalog-v1",
            "query": "日历提醒",
            "limit": 10,
            "source_types": ["capability"],
            "scope": None,
            "documents": [{
                **_wire_document(document),
                "owner_user_id": owner,
            }],
        }
        search_task = asyncio.create_task(host._handle_cython_transient_search(owner, payload))
        await asyncio.sleep(0.02)

        assert not search_task.done(), "检索应在线程中继续，不能占用 sidecar 主循环"
        await search_task
    finally:
        await host.stop()
        socket_path.unlink(missing_ok=True)
