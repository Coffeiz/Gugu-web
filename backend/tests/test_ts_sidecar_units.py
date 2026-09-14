"""agent/rag/ts_sidecar.py 单元补测（CRAP 治理 P1）。

只测 Python 侧的 IPC payload 构造、响应镜像与纯函数；不启动真实 TS worker
（`_request` 一律实例级打桩，socket 收发用内存 StreamReader/FakeWriter 模拟）。
"""
import asyncio
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent.rag import ts_sidecar as ts
from agent.rag.models import IndexDocument, RecallResult, Scope
from agent.rag.ts_sidecar import (
    TsSidecarUnavailable,
    TsSidecarClient,
    SidecarRequestResult,
    SidecarRequestTiming,
)


def _doc(owner: str = "u1", source_type: str = "project", content: str = "内容") -> IndexDocument:
    return IndexDocument(
        document_id="p1", source_type=source_type, source_id="1",
        scope=Scope(owner_user_id=owner), title="标题", summary="摘要",
        content=content, version="v1",
    )


def _result(response: dict, **timing) -> SidecarRequestResult:
    return SidecarRequestResult(response=response, timing=SidecarRequestTiming(**timing))


# ── 纯函数：worker stderr 构建探针解析 ─────────────────────────────────────

def test_parse_worker_build_probe_accepts_only_controlled_phases():
    prefix = "GUGU_RAG_BUILD_PROBE "
    good = {
        "op": "sync_index_from_database", "phase": "delta_read_start",
        "elapsed_ms": 12.7,
        "counts": {"scanned_rows": 5, "bogus": 3, "applied_upserts": -2, "passes": True},
    }
    parsed = ts._parse_worker_build_probe(prefix + json.dumps(good))
    assert parsed == {"op": "sync_index_from_database", "phase": "delta_read_start",
                      "elapsed_ms": 12,
                      "counts": {"scanned_rows": 5, "applied_upserts": 0}}   # 负值钳 0、未知名/bool 丢弃
    assert ts._parse_worker_build_probe(prefix.encode() + json.dumps(good).encode()) == parsed

    assert ts._parse_worker_build_probe("普通日志行") is None            # 前缀不符
    assert ts._parse_worker_build_probe(prefix + "{bad json") is None   # 坏 JSON
    assert ts._parse_worker_build_probe(prefix + json.dumps([1])) is None
    assert ts._parse_worker_build_probe(prefix + json.dumps(
        {"op": "search", "phase": "completed", "elapsed_ms": 1})) is None
    assert ts._parse_worker_build_probe(prefix + json.dumps(
        {"op": "completed", "phase": "nope", "elapsed_ms": 1})) is None
    assert ts._parse_worker_build_probe(prefix + json.dumps(
        {"op": "completed", "phase": "completed", "elapsed_ms": True})) is None  # bool 不算数值
    assert ts._parse_worker_build_probe(prefix + json.dumps(
        {"op": "completed", "phase": "completed", "elapsed_ms": "x"})) is None
    assert ts._parse_worker_build_probe(prefix + json.dumps(
        {"op": "load_index_from_database", "phase": "completed",
         "elapsed_ms": 1, "counts": "x"}))["counts"] == {}


# ── 纯函数：wire 文档 → 持久 IndexDocument（写库通道）─────────────────────

def test_wire_document_to_persistent_maps_and_validates():
    raw = {
        "id": "p1:0", "parent_id": "p1", "source_type": "project", "source_id": "9",
        "platform": "qq", "bot_id": "b", "group_id": "g", "scope_type": "group",
        "scope_id": "g1", "title": "标题", "summary": "摘要", "content": "正文",
        "document_version": "v7", "chunk_index": 2, "chunk_count": 4,
        "updated_at": "2026-09-14", "metadata": {"k": "v"},
    }
    doc = ts.wire_document_to_persistent(raw, "owner-1")
    assert doc.document_id == "p1" and doc.parent_document_id == "p1"
    assert doc.scope.platform == "qq" and doc.scope.scope_type == "group"
    assert doc.version == "v7" and doc.chunk_index == 2 and doc.chunk_count == 4
    assert doc.metadata == {"k": "v"} and doc.updated_at == "2026-09-14"

    with pytest.raises(ValueError):
        ts.wire_document_to_persistent({"id": "x", "content": "c"}, "o")     # 缺 parent_id
    with pytest.raises(ValueError):
        ts.wire_document_to_persistent({"id": "x", "parent_id": "p"}, "o")   # 缺 content
    doc = ts.wire_document_to_persistent(
        {"parent_id": "p", "content": "c", "metadata": "bad"}, "o")
    assert doc.metadata == {}                                                # 非 dict metadata → {}


# ── worker 启动命令与制品定位 ──────────────────────────────────────────────

def test_worker_command_and_artifact_resolution(tmp_path, monkeypatch):
    cmd = "node /x/worker.mjs --verbose"
    assert ts._worker_command(cmd, "", "u1") == ["node", "/x/worker.mjs", "--verbose"]

    parts = ts._worker_command(cmd, str(tmp_path / "idx"), "u1")
    assert parts[-1] == str(tmp_path / "idx" / hashlib.sha256(b"u1").hexdigest()[:32])

    monkeypatch.setattr(ts, "_default_artifact", lambda: Path("/nonexistent.mjs"))
    assert ts._worker_command("  ", "", "u1") == []                          # 无命令且无制品

    real = tmp_path / "real.mjs"
    real.write_text("x")
    assert ts._resolve_artifact(f"node {real} --flag") == real               # 第一个真实文件
    monkeypatch.setattr(ts, "_default_artifact", lambda: real)
    assert ts._resolve_artifact("node /missing.mjs") == real                 # 回落打包制品
    monkeypatch.setattr(ts, "_default_artifact", lambda: Path("/nope.mjs"))
    assert ts._resolve_artifact("") is None


# ── 持久索引装载/同步/向量包装器：payload 与镜像字段 ───────────────────────

async def test_build_wrappers_send_ipc_and_mirror_state(monkeypatch):
    client = TsSidecarClient("u1", command="node x")
    seen = []

    async def fake_request(payload, timeout_seconds=None):
        seen.append(dict(payload, timeout=timeout_seconds))
        return _result({"revision": "r2", "document_count": 5, "estimated_bytes": 99,
                        "vector_count": 4, "vector_version": "v2", "extra": "x"})

    monkeypatch.setattr(client, "_request", fake_request)
    resp = await client.load_index_from_database("u1", "r2", "v2")
    assert resp["extra"] == "x" and client._revision == "r2"
    assert (client._document_count, client._estimated_bytes) == (5, 99)
    assert (client._vector_count, client._vector_version) == (4, "v2")
    assert client._restore_error is None
    assert seen[-1]["op"] == "load_index_from_database"
    assert (seen[-1]["owner_id"], seen[-1]["revision"], seen[-1]["vector_version"]) == ("u1", "r2", "v2")

    resp = await client.sync_index_from_database("u1", "", "")
    assert seen[-1]["op"] == "sync_index_from_database"
    assert seen[-1]["revision"] == ""                                        # falsy 归一空串
    assert resp["document_count"] == 5

    client._revision = "keep"
    await client.load_vectors_from_storage("u1", "v9")
    assert seen[-1]["op"] == "load_vectors_from_storage"
    assert client._vector_version == "v2" and client._revision == "keep"    # 只覆盖向量侧字段


# ── search_with_timing：文档解析、过滤与 payload 形状 ──────────────────────

async def test_search_with_timing_resolves_filters_and_shapes_payload(monkeypatch):
    from agent.rag.delta import chunk_slot_key

    client = TsSidecarClient("u1", command="node x")
    doc_project = _doc("u1", "project")
    doc_memory = _doc("u1", "memory")
    captured = {}

    async def fake_request(payload):
        captured.update(payload)
        return _result(
            {
                "diagnostics": {"took_ms": 3},
                "results": [
                    {"id": chunk_slot_key(doc_project), "score": 3},
                    {"id": "wire-1", "score": 2,
                     "document": {"id": "wire-1", "source_type": "memory",
                                  "title": "内联", "content": "c", "scope_type": "owner"}},
                    {"id": "nowhere", "score": 1},                        # 两处都解析不到 → 丢弃
                    {"id": chunk_slot_key(doc_project), "score": 9,
                     "document": {"id": "other"}},                        # 优先查 documents 字典
                ],
            },
            queue_wait_ms=1,
        )

    monkeypatch.setattr(client, "_request", fake_request)
    results, timing = await client.search_with_timing(
        "查询", documents={
            chunk_slot_key(doc_project): doc_project,
            chunk_slot_key(doc_memory): doc_memory,
        },
        source_types={"project"}, limit=100,
    )
    assert captured["limit"] == 50                                          # 上限钳 50
    assert captured["source_types"] == ["project"]
    assert "scope" not in captured
    assert client.last_search_diagnostics == {"took_ms": 3}
    assert timing.queue_wait_ms == 1
    ids = [r.document.document_id for r in results]
    assert "p1" in ids and "wire-1" not in ids                              # source_type 过滤内联恢复项
    assert all(r.document.source_type == "project" for r in results)

    captured.clear()
    results, _ = await client.search_with_timing(
        "查询", documents={}, source_types=(), limit=0,
        scope=Scope(owner_user_id="u2", scope_type="owner"),
    )
    assert captured["limit"] == 1                                           # 下限钳 1
    assert set(captured["scope"]) == {"platform", "bot_id", "group_id", "scope_type", "scope_id"}
    assert results == []                                                    # owner u2 与文档 u1 不匹配

    captured.clear()
    await client.search_with_timing("查询", documents={}, source_types=())
    assert "scope" not in captured and captured["source_types"] == []


# ── rank_candidates：payload 契约与响应映射 ────────────────────────────────

async def test_rank_candidates_payload_and_response(monkeypatch):
    client = TsSidecarClient("u1", command="node x")
    captured = {}

    async def fake_request(payload):
        captured.update(payload)
        return _result({"selected": [{"id": "a"}], "stats": {"picked": 1}})

    monkeypatch.setattr(client, "_request", fake_request)
    selected, stats = await client.rank_candidates(
        "查询", [{"id": "a"}], limit=0, max_chars=100, max_per_source=2, max_per_parent=1,
        exclude_content_hashes={"h2", "h1"},
        corpus_documents=[{"id": "a"}],
    )
    assert selected == [{"id": "a"}] and stats == {"picked": 1}
    assert captured["limit"] == 1                                           # 下限钳 1
    assert captured["exclude_content_hashes"] == ["h1", "h2"]
    assert captured["corpus_documents"] == [{"id": "a"}]
    assert captured["selection_mode"] == "confidence"
    assert captured["scoring_version"] == "confidence-v4"

    captured.clear()
    await client.rank_candidates("查询", [], limit=3, max_chars=1, max_per_source=1,
                                 max_per_parent=1, selection_mode="diversity",
                                 scoring_version="confidence-v3")
    assert "corpus_documents" not in captured                               # None 不传
    assert captured["selection_mode"] == "diversity"
    assert captured["scoring_version"] == "confidence-v3"


# ── unified_query：一次 IPC 的 payload 白名单与响应增强 ────────────────────

async def test_unified_query_payload_shaping_and_timing(monkeypatch):
    client = TsSidecarClient("u1", command="node x")
    client._transient_revision = "tr-1"
    index = ts.TsLexicalIndex([], client, "rev-1")
    captured = {}

    async def fake_request(payload):
        captured.update(payload)
        return _result({"selected": [1]}, queue_wait_ms=1, ensure_process_ms=2,
                       response_wait_ms=3, query_ms=4)

    monkeypatch.setattr(client, "_request", fake_request)
    scope = Scope(owner_user_id="u1", platform="qq", bot_id="b", group_id="g",
                  scope_type="group", scope_id="g")
    embedding = {"provider": "p", "base_url": "https://x", "pinned_ip": "1.2.3.4",
                 "model": "m", "dimensions": 2, "api_key": "sk", "multimodal": True,
                 "secret_extra": "不白名单字段"}
    result = await index.unified_query(
        "查询",
        searches=[
            {"source_types": ("b", "a"), "scope": scope, "corpus": "transient"},
            {"source_types": []},
        ],
        query_embedding=embedding, source_order=["memory", "project"],
        candidate_limit=0,
        rank_options={"limit": 5, "max_chars": 1000, "max_per_source": 3,
                      "max_per_parent": 2, "exclude_content_hashes": ("h2", "h1")},
        before_message_id=7, vector_version="vv1",
    )
    assert captured["op"] == "unified_query_with_embedding"
    assert captured["revision"] == "rev-1" and captured["before_message_id"] == 7
    assert captured["candidate_limit"] == 1                                 # 下限钳 1
    assert captured["searches"][0]["source_types"] == ["a", "b"]
    assert captured["searches"][0]["corpus"] == "transient"
    assert captured["searches"][0]["scope"] == {
        "platform": "qq", "bot_id": "b", "group_id": "g",
        "scope_type": "group", "scope_id": "g"}
    assert "scope" not in captured["searches"][1] and "corpus" not in captured["searches"][1]
    assert captured["rank"]["exclude_content_hashes"] == ["h1", "h2"]
    assert captured["owner_id"] == "u1"
    assert set(captured["embedding"]) == {"provider", "base_url", "pinned_ip", "model",
                                          "dimensions", "api_key", "multimodal"}   # 白名单
    assert "secret_extra" not in captured["embedding"]
    assert captured["transient_revision"] == "tr-1"
    assert captured["vector_version"] == "vv1"
    assert result["selected"] == [1]
    assert result["_sidecar_timing"] == {"queue_wait_ms": 1, "ensure_process_ms": 2,
                                         "response_wait_ms": 3, "query_ms": 4}

    captured.clear()
    await index.unified_query("查询", searches=[], query_embedding=None,
                              source_order=[], candidate_limit=3, rank_options={
                                  "limit": 1, "max_chars": 1, "max_per_source": 1,
                                  "max_per_parent": 1, "selection_mode": "diversity"})
    assert captured["op"] == "unified_query"                                # 无 embedding 走普通 op
    assert "embedding" not in captured and "owner_id" not in captured
    assert "transient_revision" not in captured and "vector_version" not in captured
    assert captured["rank"]["selection_mode"] == "diversity"


# ── Socket 宿主通道：_transact 的收发与错误归一 ────────────────────────────

class FakeWriter:
    def __init__(self, on_write=None, fail=False):
        self.frames = []
        self._on_write = on_write
        self._fail = fail
        self.closed = False

    def write(self, data):
        if self._fail:
            raise BrokenPipeError("pipe gone")
        self.frames.append(data)
        if self._on_write:
            self._on_write(data)

    async def drain(self):
        return None

    def is_closing(self):
        return self.closed

    def close(self):
        self.closed = True

    async def wait_closed(self):
        return None


def _socket_client_with(reader, writer) -> ts.SocketSidecarClient:
    client = ts.SocketSidecarClient("u1", socket_path="/tmp/gugu-test.sock")
    client._reader = reader
    client._writer = writer
    return client


async def test_transact_happy_path_mirrors_host_state():
    reader = asyncio.StreamReader()
    reader.feed_data(json.dumps({
        "v": 1, "req_id": "z", "status": "ok",
        "payload": {"answer": 1},
        "state": {"revision": "r9", "document_count": "3", "transient_generation": 2},
    }).encode() + b"\n")
    reader.feed_eof()
    client = _socket_client_with(reader, FakeWriter())

    payload = await client._transact({"op": "x"}, timeout_seconds=1.0)
    assert payload == {"answer": 1}
    assert client._mirror["revision"] == "r9"
    assert client._mirror["document_count"] == "3"
    envelope = json.loads(client._writer.frames[0].decode())
    assert envelope["v"] == 1 and envelope["owner"] == "u1"
    assert envelope["timeout_ms"] == 1000 and envelope["payload"] == {"op": "x"}


async def test_transact_error_status_raises_with_code_and_diagnostics():
    reader = asyncio.StreamReader()
    reader.feed_data(json.dumps({
        "status": "error", "message": "boom", "code": "E1", "diagnostics": {"k": 1},
    }).encode() + b"\n")
    reader.feed_eof()
    client = _socket_client_with(reader, FakeWriter())

    with pytest.raises(TsSidecarUnavailable) as exc:
        await client._transact({"op": "x"})
    assert "boom" in str(exc.value) and exc.value.code == "E1"
    assert exc.value.diagnostics == {"k": 1}
    assert client._writer is not None   # 业务错误不关连接，由上层决定后续


async def test_transact_broken_transport_variants():
    # 空响应（连接断开）
    reader = asyncio.StreamReader()
    reader.feed_eof()
    client = _socket_client_with(reader, FakeWriter())
    with pytest.raises(TsSidecarUnavailable, match="断开"):
        await client._transact({"op": "x"})

    # 无效 JSON
    reader = asyncio.StreamReader()
    reader.feed_data(b"not-json\n")
    reader.feed_eof()
    client = _socket_client_with(reader, FakeWriter())
    with pytest.raises(TsSidecarUnavailable, match="无效 JSON"):
        await client._transact({"op": "x"})

    # 写失败（半行残留 → 整条连接作废）
    reader = asyncio.StreamReader()
    writer = FakeWriter(fail=True)
    client = _socket_client_with(reader, writer)
    with pytest.raises(TsSidecarUnavailable, match="请求失败"):
        await client._transact({"op": "x"})
    assert client._writer is None


# ── 活跃索引目录与空闲回收 ────────────────────────────────────────────────

async def test_active_index_dirs_reports_live_processes_only(monkeypatch):
    loop = asyncio.get_running_loop()
    client = TsSidecarClient("owner-x", command="node x", index_dir="/tmp/idx-root")
    client._process = SimpleNamespace(returncode=None)
    dead = TsSidecarClient("owner-y", command="node x", index_dir="/tmp/dead")
    dead._process = SimpleNamespace(returncode=0)
    ts._lexical_clients[loop] = {"k": client, "dead": dead}

    assert ts.active_index_dirs() == {
        Path("/tmp/idx-root") / hashlib.sha256(b"owner-x").hexdigest()[:32]
    }


async def test_reap_idle_sidecars_closes_and_exits(monkeypatch):
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(ts, "SIDE_CAR_REAPER_INTERVAL_SECONDS", 0.01)
    closed = []

    class IdleClient:
        def is_idle(self, now=None):
            return True

        async def close(self):
            closed.append(1)

    ts._lexical_clients[loop] = {"idle": IdleClient()}
    task = asyncio.create_task(ts._reap_idle_sidecars(loop))
    ts._sidecar_reaper_tasks[loop] = task
    await asyncio.wait_for(task, timeout=2)                                 # 清空后自退出
    assert closed == [1]
    assert ts._sidecar_reaper_tasks.get(loop) is not task                   # finally 清理登记
