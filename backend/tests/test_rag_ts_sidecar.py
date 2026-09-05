import asyncio
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
