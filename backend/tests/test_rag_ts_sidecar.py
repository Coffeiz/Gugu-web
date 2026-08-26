from pathlib import Path

import pytest

from agent.rag.models import IndexDocument, RecallCandidate, RecallResult, Scope
from agent.rag.ts_sidecar import TsSidecarClient, _worker_document_key


def _worker_command() -> str:
    worker = Path(__file__).parents[1] / "bin" / "gugu-rag-ts-worker.mjs"
    return f"node {worker}"


@pytest.mark.asyncio
async def test_ts_worker_replace_search_and_persist(tmp_path):
    client = TsSidecarClient("test-owner", command=_worker_command(), index_dir=str(tmp_path / "index"))
    documents = [
        IndexDocument(
            document_id="project:1", source_type="project", source_id="1",
            scope=Scope(owner_user_id="test-owner"), title="部署计划", summary="",
            content="项目部署计划", version="v1",
        ),
        IndexDocument(
            document_id="memory:1", source_type="memory", source_id="1",
            scope=Scope(owner_user_id="test-owner"), title="天气", summary="",
            content="天气记录", version="v1",
        ),
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
    first = IndexDocument(
        document_id="project:1", source_type="project", source_id="1",
        scope=Scope(owner_user_id="test-owner"), title="旧项目", summary="",
        content="旧内容", version="v1",
    )
    second = IndexDocument(
        document_id="memory:1", source_type="memory", source_id="1",
        scope=Scope(owner_user_id="test-owner"), title="记忆", summary="",
        content="保留内容", version="v1",
    )
    changed = IndexDocument(
        document_id="project:1", source_type="project", source_id="1",
        scope=Scope(owner_user_id="test-owner"), title="新项目", summary="",
        content="新内容", version="v2",
    )
    try:
        await client.replace([first, second], "revision-1")
        await client.patch(
            [changed],
            [_worker_document_key(first), _worker_document_key(second)],
            "revision-2",
            "revision-1",
        )
        results = await client.search("新内容", documents={_worker_document_key(changed): changed})
        assert [item.document.title for item in results] == ["新项目"]
        assert client._document_count == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_ts_worker_score_filter_keeps_confidence_contract():
    client = TsSidecarClient("test-owner", command=_worker_command(), index_dir="")
    document = IndexDocument(
        document_id="project:1", source_type="project", source_id="1",
        scope=Scope(owner_user_id="test-owner"), title="部署计划", summary="",
        content="项目部署计划", version="v1",
    )
    candidate = RecallCandidate.from_result(RecallResult(document, 1.0), rank=1)
    try:
        selected, stats = await client.score_filter("部署", [{
            "id": "candidate-1", "source_type": candidate.source_type,
            "title": document.title, "summary": document.summary, "content": document.content,
            "fused_score": 0.9, "normalized_score": 0.9,
        }], limit=5)
        assert selected[0]["id"] == "candidate-1"
        assert selected[0]["confidence"] >= 0.55
        assert stats["scoring_version"] == "confidence-v1"
    finally:
        await client.close()
