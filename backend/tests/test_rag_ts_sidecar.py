from pathlib import Path

import pytest

from agent.rag.models import IndexDocument, Scope
from agent.rag.ts_sidecar import TsSidecarClient, _worker_document_key


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
