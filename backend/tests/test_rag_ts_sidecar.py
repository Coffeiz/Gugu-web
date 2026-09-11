import asyncio
import json
from pathlib import Path

import pytest

from agent.rag.models import IndexDocument, Scope
from agent.rag.ts_sidecar import (
    SIDE_CAR_IDLE_TTL_SECONDS,
    TsSidecarClient,
    _lexical_clients,
    _rank_clients,
    _take_idle_sidecars,
    _worker_document_key,
    SidecarRequestResult,
    SidecarRequestTiming,
)


def test_wire_document_keeps_business_fields_for_cold_restore():
    from agent.rag.ts_sidecar import _wire_document

    document = IndexDocument("project:1", "project", "1", Scope("owner"), "标题", "摘要", "正文", "v1")
    wire = _wire_document(document)
    assert wire["content"] == "正文"
    assert wire["source_id"] == "1"


def test_wire_conversation_separates_display_title_from_ranking_text():
    from agent.rag.ts_sidecar import _wire_document

    document = IndexDocument(
        "conversation:1", "conversation", "1", Scope("owner"),
        "今天天气", "", "user：看看有什么笔记", "v1",
    )
    wire = _wire_document(document)
    assert wire["text"].startswith("今天天气\n")
    assert wire["ranking_text"] == "user：看看有什么笔记"


def test_index_dir_for_owner_uses_hidden_user_storage(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from agent.rag.ts_sidecar import index_dir_for_owner

    monkeypatch.setattr(
        "app.core.config.get_settings",
        lambda: SimpleNamespace(
            storage=SimpleNamespace(local_path=str(tmp_path)),
            search=SimpleNamespace(ts_sidecar_index_dir="var/legacy"),
        ),
    )
    assert index_dir_for_owner("user-a").endswith("/user-a/.system/rag/ts-index")


def _worker_command() -> str:
    worker = Path(__file__).parents[1] / "ts" / "workers" / "rag" / "src" / "index.ts"
    return f"node --experimental-strip-types {worker}"


@pytest.mark.asyncio
async def test_ts_worker_replace_search_and_persist(tmp_path):
    client = TsSidecarClient("test-owner", command=_worker_command(), index_dir=str(tmp_path / "index"))
    documents = [
        IndexDocument("project:1", "project", "1", Scope("test-owner"), "部署计划", "", "项目部署计划", "v1"),
        IndexDocument("memory:1", "memory", "1", Scope("test-owner"), "天气", "", "天气记录", "v1"),
    ]
    try:
        await client.replace(documents, "revision-1")
        results = await client.search("部署", documents={_worker_document_key(item): item for item in documents})
        assert [item.document.source_id for item in results] == ["1"]
        assert list((tmp_path / "index").glob("*/index.json"))
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_ts_worker_patch_updates_only_changed_chunks(tmp_path):
    client = TsSidecarClient("test-owner", command=_worker_command(), index_dir=str(tmp_path / "index"))
    first = IndexDocument("project:1", "project", "1", Scope("test-owner"), "旧项目", "", "旧内容", "v1")
    second = IndexDocument("memory:1", "memory", "1", Scope("test-owner"), "记忆", "", "保留内容", "v1")
    changed = IndexDocument("project:1", "project", "1", Scope("test-owner"), "新项目", "", "新内容", "v2")
    try:
        await client.replace([first, second], "revision-1")
        await client.patch([changed], [_worker_document_key(first), _worker_document_key(second)], "revision-2", "revision-1")
        results = await client.search("新内容", documents={_worker_document_key(changed): changed})
        assert [item.document.title for item in results] == ["新项目"]
        assert client._document_count == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_sidecar_reaper_handles_owner_registry_and_shared_rank_client():
    """TTL 回收同时覆盖 owner 映射和 event-loop 级排序 worker。"""
    loop = asyncio.get_running_loop()
    lexical = TsSidecarClient("owner", command="")
    rank = TsSidecarClient("rank", command="")
    lexical._last_used_at = 0
    rank._last_used_at = 0
    _lexical_clients[loop] = {"owner": lexical}
    _rank_clients[loop] = rank
    try:
        idle = _take_idle_sidecars(loop, now=SIDE_CAR_IDLE_TTL_SECONDS + 1)
        assert set(idle) == {lexical, rank}
        assert not _lexical_clients.get(loop)
        assert _rank_clients.get(loop) is None
    finally:
        _lexical_clients.pop(loop, None)
        _rank_clients.pop(loop, None)


@pytest.mark.asyncio
async def test_search_returns_request_local_timing_for_shared_client(monkeypatch):
    """并发来源读取同一 owner worker 时，诊断计时不能从共享 last_* 回读。"""
    client = TsSidecarClient("test-owner", command="")
    document = IndexDocument("project:1", "project", "1", Scope("test-owner"), "标题", "", "正文", "v1")
    key = _worker_document_key(document)

    async def fake_request(payload):
        query = payload["query"]
        return SidecarRequestResult(
            {"results": [{"id": key, "score": 1}]},
            SidecarRequestTiming(
                queue_wait_ms=11 if query == "first" else 22,
                query_ms=111 if query == "first" else 222,
            ),
        )

    monkeypatch.setattr(client, "_request", fake_request)
    documents = {key: document}
    first, second = await asyncio.gather(
        client.search_with_timing("first", documents=documents),
        client.search_with_timing("second", documents=documents),
    )

    assert first[1] == SidecarRequestTiming(queue_wait_ms=11, query_ms=111)
    assert second[1] == SidecarRequestTiming(queue_wait_ms=22, query_ms=222)


@pytest.mark.asyncio
async def test_build_ops_use_build_timeout_and_search_keeps_request_timeout(monkeypatch):
    """replace/patch/replace_transient 走构建超时；search/batch_search 保持搜索超时。"""
    from agent.rag import ts_sidecar as ts
    from agent.rag.models import IndexDocument, Scope

    captured: list[tuple[str, float | None]] = []

    async def fake_request_unlocked(self, payload, *, timeout_seconds=None):
        captured.append((payload["op"], timeout_seconds))
        return {"status": "ok", "revision": payload.get("revision") or "r1",
                "document_count": 1}

    async def _none(self):
        return None

    monkeypatch.setattr(ts.TsSidecarClient, "_request_unlocked", fake_request_unlocked)
    monkeypatch.setattr(ts.TsSidecarClient, "_ensure_process", _none)
    client = ts.TsSidecarClient("test-owner", command="")
    document = IndexDocument("file:1", "file", "1", Scope("test-owner"), "文件", "", "缓存", "1")

    await client.replace([document], "r1")
    await client.patch([document], [], "r2", "r1")
    await client.replace_transient([document], "t1")
    assert captured == [
        ("replace", ts.BUILD_TIMEOUT_SECONDS),
        ("patch", ts.BUILD_TIMEOUT_SECONDS),
        ("replace_transient", ts.BUILD_TIMEOUT_SECONDS),
    ]

    captured.clear()
    result = await client._request({"op": "search", "revision": "r1", "query": "缓存"})
    assert result.response["status"] == "ok"
    # 搜索类请求不显式传超时，由 _request_unlocked 内部按配置解析。
    assert captured == [("search", None)]


@pytest.mark.asyncio
async def test_rank_guard_rejects_unknown_scoring_version(monkeypatch):
    """冻结契约：TS 评分版本漂移必须显式失败，不能静默接受差异。"""
    from agent.rag import ts_sidecar as ts
    from agent.rag.models import IndexDocument, RecallCandidate, RecallResult, Scope

    async def fake_rank(self, query, candidates, **kwargs):
        return [], {"scoring_version": "confidence-v2", "accepted_count": 0}

    monkeypatch.setattr(ts.TsSidecarClient, "rank_candidates", fake_rank)
    monkeypatch.setattr(ts, "_ensure_sidecar_reaper", lambda loop: None)
    monkeypatch.setattr(ts, "_rank_clients", {})
    doc = IndexDocument("file:1", "file", "1", Scope("test-owner"), "文件", "", "缓存", "1")
    candidate = RecallCandidate.from_result(RecallResult(doc, 1.0), rank=1)
    with pytest.raises(ts.TsSidecarUnavailable, match="评分器版本"):
        await ts.rank_candidates_with_cache("test-owner", "缓存", [candidate],
                                            limit=5, max_chars=1000,
                                            max_per_source=3, max_per_parent=3)


@pytest.mark.asyncio
async def test_corrupt_index_reported_and_rebuilt(tmp_path):
    """Phase 4：磁盘索引损坏必须显式报告（restore_error），全量重建后恢复健康。"""
    import hashlib

    owner_hash = hashlib.sha256("test-owner".encode("utf-8")).hexdigest()[:32]
    index_dir = tmp_path / "index" / owner_hash
    index_dir.mkdir(parents=True)
    (index_dir / "index.json").write_text("{损坏的索引", encoding="utf-8")
    client = TsSidecarClient("test-owner", command=_worker_command(), index_dir=str(tmp_path / "index"))
    document = IndexDocument("project:1", "project", "1", Scope("test-owner"), "重建计划", "", "重建内容", "v1")
    try:
        # 启动探活即上报告损类别；复用检查不能把损坏索引当有效数据。
        assert await client.reuse_if_current("revision-1") is False
        assert client.restore_error == "corrupt"
        await client.replace([document], "revision-1")
        assert client.restore_error is None
        assert await client.reuse_if_current("revision-1") is True
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_replace_transient_reuploads_after_worker_death(monkeypatch):
    """worker 死亡后瞬态语料必须重传：短路判断不得使用死亡进程的旧代数。"""
    from types import SimpleNamespace

    from agent.rag.ts_sidecar import TsSidecarClient

    client = TsSidecarClient("owner-restart", command="true", index_dir="")
    client._process = SimpleNamespace(returncode=1)
    client._process_generation = 3
    client._transient_generation = 3
    client._transient_revision = "stale-revision"
    sent: list[str] = []

    async def fake_request(payload, *, timeout_seconds=None):
        sent.append(payload["op"])
        # 模拟 _ensure_process：重启后新进程健康且代数已递增。
        client._process = SimpleNamespace(returncode=None)
        client._process_generation += 1
        return SimpleNamespace(response={"revision": payload.get("revision", "")})

    monkeypatch.setattr(client, "_request", fake_request)
    await client.replace_transient([], "fresh-revision")
    assert sent == ["replace_transient"]
    assert client._transient_revision == "fresh-revision"

    # 进程健康且指纹未变时保持幂等短路，不重复占用 IPC。
    sent.clear()
    client._process = SimpleNamespace(returncode=None)
    await client.replace_transient([], "fresh-revision")
    assert sent == []

@pytest.mark.asyncio
async def test_stream_reader_race_closes_connection_and_raises_unavailable(monkeypatch):
    """wait_for 取消 readline 的竞态会抛 RuntimeError（readuntil already waiting）：
    必须按致命错误关闭连接并抛 TsSidecarUnavailable，让下一次请求重生 worker，
    而不是裸抛 RuntimeError 让客户端带着中毒的流永久不可用。"""
    from types import SimpleNamespace

    from agent.rag.ts_sidecar import TsSidecarUnavailable

    class _FakeStdin:
        def write(self, data):
            pass

        async def drain(self):
            return None

    class _PoisonedStdout:
        async def readline(self):
            raise RuntimeError(
                "readuntil() called while another coroutine is already waiting for incoming data")

    async def _noop(self):
        return None

    monkeypatch.setattr(TsSidecarClient, "_ensure_process", _noop)
    client = TsSidecarClient("test-owner", command="")
    client._process = SimpleNamespace(
        stdin=_FakeStdin(), stdout=_PoisonedStdout(), returncode=0)

    with pytest.raises(TsSidecarUnavailable, match="请求失败"):
        await client._request({"op": "search", "revision": "r1", "query": "查询"})
    assert client._process is None


class _WritableStdin:
    def write(self, data):
        pass

    async def drain(self):
        return None


class _OneLineStdout:
    def __init__(self, payload: dict):
        self._line = (json.dumps(payload, ensure_ascii=False) + "\n").encode()

    async def readline(self):
        return self._line


async def _no_process_start(self):
    return None


@pytest.mark.asyncio
async def test_worker_error_response_carries_machine_readable_code(monkeypatch):
    """worker 的 error 响应必须把 code 带进异常，调用方才能区分可自愈故障与真不可用。"""
    from types import SimpleNamespace

    from agent.rag.ts_sidecar import TsSidecarUnavailable

    monkeypatch.setattr(TsSidecarClient, "_ensure_process", _no_process_start)
    client = TsSidecarClient("test-owner", command="")
    client._process = SimpleNamespace(
        stdin=_WritableStdin(),
        stdout=_OneLineStdout({
            "status": "error", "code": "revision_mismatch",
            "message": "TS 统一查询索引版本不一致",
        }),
        returncode=0,
    )
    with pytest.raises(TsSidecarUnavailable) as caught:
        await client._request({"op": "unified_query", "revision": "r1", "query": "查询"})
    assert caught.value.code == "revision_mismatch"

    # 没有 code 的失败是「真不可用」：code 必须为 None，调用方不能误判成可自愈。
    client._process = SimpleNamespace(
        stdin=_WritableStdin(),
        stdout=_OneLineStdout({"status": "error", "message": "worker 内部错误"}),
        returncode=0,
    )
    with pytest.raises(TsSidecarUnavailable) as caught_plain:
        await client._request({"op": "search", "revision": "r1", "query": "查询"})
    assert caught_plain.value.code is None


@pytest.mark.asyncio
async def test_transient_response_does_not_overwrite_persistent_revision(monkeypatch):
    """replace_transient 回的是瞬态槽指纹；写进 _revision 会让后续查询误判持久索引已同步。"""
    from agent.rag import ts_sidecar as ts

    async def fake_request_unlocked(self, payload, *, timeout_seconds=None):
        if payload.get("op") == "replace_transient":
            return {"status": "ok", "revision": "transient-fingerprint"}
        return {"status": "ok", "revision": "persistent-revision", "document_count": 1}

    monkeypatch.setattr(ts.TsSidecarClient, "_request_unlocked", fake_request_unlocked)
    monkeypatch.setattr(ts.TsSidecarClient, "_ensure_process", _no_process_start)
    client = ts.TsSidecarClient("test-owner", command="")
    document = IndexDocument("file:1", "file", "1", Scope("test-owner"), "文件", "", "缓存", "1")

    await client.replace([document], "persistent-revision")
    assert client._revision == "persistent-revision"
    await client.replace_transient([document], "transient-fingerprint")
    assert client._revision == "persistent-revision"


@pytest.mark.asyncio
async def test_replace_transient_force_skips_fingerprint_shortcut(monkeypatch):
    """revision 不一致重试必须能强制重传，不能信进程内残留的指纹短路。"""
    from types import SimpleNamespace

    from agent.rag import ts_sidecar as ts

    client = ts.TsSidecarClient("owner-force", command="")
    client._process = SimpleNamespace(returncode=None)
    client._process_generation = 2
    client._transient_generation = 2
    client._transient_revision = "same-revision"
    sent: list[str] = []

    async def fake_request(payload, *, timeout_seconds=None):
        sent.append(payload["op"])
        return SimpleNamespace(response={"revision": payload.get("revision", "")})

    monkeypatch.setattr(client, "_request", fake_request)
    # 指纹与代数都未变：默认走零 IPC 短路。
    await client.replace_transient([], "same-revision")
    assert sent == []
    await client.replace_transient([], "same-revision", force=True)
    assert sent == ["replace_transient"]


def test_worker_artifact_version_reads_configured_artifact(monkeypatch, tmp_path):
    """GC 靠制品版本戳识别旧版本索引；读不到必须返回 None（按未知处理，不能当成要删）。"""
    from types import SimpleNamespace

    from agent.rag.ts_sidecar import worker_artifact_version

    artifact = tmp_path / "worker.mjs"
    artifact.write_bytes(b'const x = 1;\nvar RAG_WORKER_VERSION = "9.9.9";\n')
    monkeypatch.setattr("app.core.config.get_settings", lambda: SimpleNamespace(
        search=SimpleNamespace(ts_sidecar_command=f"node {artifact} --index-dir /tmp/x")))
    assert worker_artifact_version() == "9.9.9"

    fallback = tmp_path / "fallback.mjs"
    fallback.write_bytes(b'RAG_WORKER_VERSION = "0.0.0-fallback";')
    monkeypatch.setattr("agent.rag.ts_sidecar._default_artifact", lambda: fallback)
    missing = tmp_path / "missing.mjs"
    monkeypatch.setattr("app.core.config.get_settings", lambda: SimpleNamespace(
        search=SimpleNamespace(ts_sidecar_command=f"node {missing}")))
    assert worker_artifact_version() == "0.0.0-fallback"

    monkeypatch.setattr("agent.rag.ts_sidecar._default_artifact", lambda: missing)
    assert worker_artifact_version() is None
