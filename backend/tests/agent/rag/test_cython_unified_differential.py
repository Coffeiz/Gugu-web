"""对真实 TS worker unified_query 做只读等价差分。"""
from __future__ import annotations

import json
import math
import subprocess
import tempfile
from pathlib import Path

import pytest

from agent.rag.cython_backend import (
    CythonRagEngine,
    CythonRevisionMismatch,
    _worker_document_wire,
)
from agent.rag.delta import chunk_slot_key
from agent.rag.models import IndexDocument, Scope


def _document(identifier: str, source: str, content: str, *, metadata=None) -> IndexDocument:
    return IndexDocument(
        document_id=identifier, source_type=source, source_id=identifier,
        scope=Scope("owner-test"), title=f"{source} {identifier}", summary="",
        content=content, version="v1", parent_document_id=identifier,
        metadata=metadata or {},
    )


def _assert_equal(actual, expected, path="response"):
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys(), path
        for key in expected:
            _assert_equal(actual[key], expected[key], f"{path}.{key}")
    elif isinstance(expected, list):
        assert len(actual) == len(expected), path
        for index, (left, right) in enumerate(zip(actual, expected)):
            _assert_equal(left, right, f"{path}[{index}]")
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert math.isclose(actual, expected, rel_tol=0, abs_tol=1e-12), path
    else:
        assert actual == expected, path


def test_cython_unified_query_matches_ts_worker_for_scoped_sources_and_watermark() -> None:
    persistent = [
        # Legacy persisted memory can share a chunk slot with the current transient
        # memory projection; selected.document must mirror the TS worker's lookup order.
        _document("m1", "memory", "缓存策略 alpha 旧记忆版本"),
        _document("p1", "project", "缓存策略 alpha 项目执行计划"),
        _document("p2", "project", "缓存策略 beta 项目执行计划"),
        _document("c10", "conversation", "缓存策略 alpha 历史讨论", metadata={
            "kind": "message", "message_id": "10", "context_current": "缓存策略 alpha 历史讨论",
        }),
        _document("c20", "conversation", "缓存策略 beta 新讨论", metadata={
            "kind": "message", "message_id": "20", "context_current": "缓存策略 beta 新讨论",
        }),
    ]
    transient = [_document("m1", "memory", "缓存策略 alpha 偏好")]
    engine = CythonRagEngine()
    engine.replace(persistent, "persistent-rev")
    engine.replace_transient(transient, "transient-rev")
    persistent_wire = []
    for document in persistent:
        key = chunk_slot_key(document)
        wire = _worker_document_wire(document, key)
        persistent_wire.append(wire)
    transient_wire = []
    for document in transient:
        transient_wire.append(_worker_document_wire(document, chunk_slot_key(document)))

    searches = [
        {"id": "0", "source_types": ["project"], "limit": 8},
        {"id": "1", "source_types": ["conversation"], "limit": 8},
        {"id": "2", "source_types": ["memory"], "corpus": "transient", "limit": 8},
    ]
    request = {
        "op": "unified_query", "revision": "persistent-rev",
        "transient_revision": "transient-rev", "query": "缓存策略 alpha",
        "searches": searches, "source_order": ["memory", "conversation", "project"],
        "candidate_limit": 8, "before_message_id": 20,
        "rank": {"limit": 8, "max_chars": 3000, "max_per_source": 8,
                 "max_per_parent": 8, "selection_mode": "top_k"},
    }
    batch_request = {
        "op": "batch_search", "revision": "persistent-rev",
        "transient_revision": "transient-rev", "query": request["query"],
        "searches": searches,
    }
    legacy_request = {
        "op": "unified_search", "revision": "persistent-rev", "query": request["query"],
        "source_types": ["project", "conversation"], "limit": 5, "max_chars": 1200,
    }
    actual = engine.unified_query(
        request["query"], revision="persistent-rev", transient_revision="transient-rev",
        searches=[
            {"source_types": {"project"}},
            {"source_types": {"conversation"}},
            {"source_types": {"memory"}, "corpus": "transient"},
        ], source_order=request["source_order"], candidate_limit=8,
        before_message_id=20, rank_options={
            "limit": 8, "max_chars": 3000, "max_per_source": 8,
            "max_per_parent": 8, "selection_mode": "top_k",
        },
    )
    actual["stats"].pop("elapsed_ms", None)
    actual.pop("probe", None)
    actual.pop("search_diagnostics", None)
    batch_actual = engine.batch_search(
        request["query"], revision="persistent-rev", transient_revision="transient-rev",
        searches=[
            {"id": item["id"], "source_types": set(item["source_types"]),
             **({"corpus": "transient"} if item.get("corpus") == "transient" else {})}
            for item in searches
        ],
    )
    legacy_actual = engine.unified_search(
        legacy_request["query"], revision="persistent-rev", limit=5, max_chars=1200,
        source_types=legacy_request["source_types"],
    )

    with tempfile.TemporaryDirectory() as index_dir:
        requests = [
            {"op": "replace", "revision": "persistent-rev", "documents": persistent_wire},
            {"op": "replace_transient", "revision": "transient-rev", "documents": transient_wire},
            request,
            batch_request,
            legacy_request,
        ]
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input="".join(json.dumps(item, ensure_ascii=False) + "\n" for item in requests),
            text=True, capture_output=True, check=True, cwd=Path(__file__).parents[4], timeout=30,
        )
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    expected = responses[2]
    expected.pop("version", None)
    expected["stats"].pop("elapsed_ms", None)
    expected.pop("probe", None)
    _assert_equal(actual, expected)

    batch_expected = responses[-2]
    batch_expected.pop("version", None)
    for batch in batch_expected["batches"]:
        batch["diagnostics"].pop("elapsed_ms", None)
    _assert_equal(batch_actual, batch_expected, "batch_search")

    legacy_expected = responses[-1]
    legacy_expected.pop("version", None)
    legacy_expected["diagnostics"].pop("elapsed_ms", None)
    legacy_actual["diagnostics"].pop("elapsed_ms", None)
    _assert_equal(legacy_actual, legacy_expected, "unified_search")


@pytest.mark.parametrize(
    ("revision", "transient_revision", "searches", "expected_message"),
    [
        ("stale-persistent", "transient-rev", [{"id": "project", "source_types": ["project"]}],
         "持久 RAG 索引 revision 不一致"),
        ("persistent-rev", "stale-transient", [{"id": "memory", "source_types": ["memory"],
         "corpus": "transient"}], "瞬态 RAG 索引 revision 不一致"),
    ],
)
def test_cython_unified_query_revision_failures_match_ts_error_codes(
    revision, transient_revision, searches, expected_message,
) -> None:
    """持久/瞬态 revision 错误需对应 TS 的 revision_mismatch，防止返回旧索引结果。"""
    engine = CythonRagEngine()
    engine.replace([], "persistent-rev")
    engine.replace_transient([], "transient-rev")
    request = {
        "op": "unified_query", "revision": revision,
        "transient_revision": transient_revision, "query": "缓存策略",
        "searches": [{**searches[0], "limit": 5}],
    }
    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input=json.dumps(request, ensure_ascii=False) + "\n",
            text=True, capture_output=True, check=True,
            cwd=Path(__file__).parents[4], timeout=30,
        )
    response = json.loads(completed.stdout.strip().splitlines()[-1])
    assert response["status"] == "error"
    assert response["code"] == "revision_mismatch"

    with pytest.raises(CythonRevisionMismatch, match=expected_message):
        engine.unified_query(
            "缓存策略", revision=revision, transient_revision=transient_revision,
            searches=[{
                "source_types": set(searches[0]["source_types"]),
                **({"corpus": "transient"} if searches[0].get("corpus") == "transient" else {}),
            }], source_order=["memory" if searches[0].get("corpus") == "transient" else "project"],
            candidate_limit=5, rank_options={"limit": 5},
        )


def test_cython_batch_search_duplicate_ids_match_ts_protocol_error() -> None:
    """重复批次 ID 必须映射为 TS duplicate_search_id，而非返回部分结果。"""
    engine = CythonRagEngine()
    engine.replace([], "persistent-rev")
    request = {
        "op": "batch_search", "revision": "persistent-rev", "query": "缓存",
        "searches": [{"id": "same", "source_types": ["project"]},
                     {"id": "same", "source_types": ["memory"]}],
    }
    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input=json.dumps({"op": "replace", "revision": "persistent-rev", "documents": []})
            + "\n" + json.dumps(request) + "\n",
            text=True, capture_output=True, check=True,
            cwd=Path(__file__).parents[4], timeout=30,
        )
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    assert responses[-1]["status"] == "error"
    assert responses[-1]["code"] == "duplicate_search_id"
    with pytest.raises(ValueError, match="批量查询标识重复"):
        engine.batch_search(
            "缓存", revision="persistent-rev",
            searches=[{"id": "same", "source_types": {"project"}},
                      {"id": "same", "source_types": {"memory"}}],
        )


def test_cython_patch_stale_base_revision_matches_ts_protocol_error() -> None:
    """过期 patch 基线必须拒绝并触发完整重载，而不能覆盖更新后的索引。"""
    engine = CythonRagEngine()
    engine.replace([], "current-revision")
    request = {
        "op": "patch", "base_revision": "stale-revision",
        "revision": "next-revision", "upserts": [], "deletes": [],
    }
    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input="".join(json.dumps(item, ensure_ascii=False) + "\n" for item in [
                {"op": "replace", "revision": "current-revision", "documents": []}, request,
            ]),
            text=True, capture_output=True, check=True,
            cwd=Path(__file__).parents[4], timeout=30,
        )
    response = json.loads(completed.stdout.splitlines()[-1])
    assert response["status"] == "error"
    assert response["code"] == "revision_mismatch"
    with pytest.raises(CythonRevisionMismatch):
        engine.patch([], [], revision="next-revision", base_revision="stale-revision")
    assert engine.revision == "current-revision"


@pytest.mark.parametrize(
    ("operation", "invoke"),
    [
        ("search", lambda engine: engine.query(
            "缓存策略", revision="stale-revision", limit=5,
        )),
        ("unified_search", lambda engine: engine.unified_search(
            "缓存策略", revision="stale-revision", limit=5,
        )),
        ("batch_search", lambda engine: engine.batch_search(
            "缓存策略", revision="stale-revision", searches=[{"id": "p", "source_types": {"project"}}],
        )),
    ],
    ids=["single-search", "legacy-unified-search", "batch-search"],
)
def test_cython_search_operations_reject_stale_persistent_revision_like_ts(operation, invoke) -> None:
    """所有查询入口都拒绝旧持久索引，避免协议遗漏导致返回陈旧 RAG 结果。"""
    engine = CythonRagEngine()
    engine.replace([], "current-revision")
    request = {
        "op": operation,
        "revision": "stale-revision",
        "query": "缓存策略",
        "limit": 5,
        "searches": [{"id": "p", "source_types": ["project"], "limit": 5}],
    }
    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input="".join(json.dumps(item, ensure_ascii=False) + "\n" for item in [
                {"op": "replace", "revision": "current-revision", "documents": []}, request,
            ]),
            text=True, capture_output=True, check=True,
            cwd=Path(__file__).parents[4], timeout=30,
        )
    response = json.loads(completed.stdout.splitlines()[-1])
    assert response["status"] == "error"
    assert response["code"] == "revision_mismatch"
    with pytest.raises(CythonRevisionMismatch):
        invoke(engine)


@pytest.mark.asyncio
async def test_cython_query_embedding_facade_matches_ts_query_vector_path(monkeypatch) -> None:
    """Python 侧受控 embedding 接入后，Hybrid 与最终选择仍和 TS 查询路径一致。"""
    document = _document("p1", "project", "缓存策略 alpha 项目执行计划")
    key = chunk_slot_key(document)
    engine = CythonRagEngine()
    engine.replace([document], "persistent-rev", vectors={key: [0.25, 0.75]}, vector_version="synthetic:v1")
    options = {
        "revision": "persistent-rev", "searches": [{"source_types": {"project"}}],
        "source_order": ["project"], "candidate_limit": 8,
        "rank_options": {"limit": 5, "max_chars": 3000, "max_per_source": 3,
                         "max_per_parent": 3, "selection_mode": "confidence"},
        "vector_version": "synthetic:v1",
        "query_embedding": {
            "provider": "openai", "base_url": "https://snapshot.example/v1",
            "pinned_ip": "192.0.2.10", "model": "snapshot-model", "dimensions": 2,
            "api_key": "synthetic-secret", "multimodal": False,
        },
    }
    observed = {}

    async def fake_embed_query(_query, *, settings=None):
        observed["settings"] = settings
        return {"vector": [0.5, 0.5], "outcome": "success", "http_status": 200}

    monkeypatch.setattr("agent.memory.embedding.embed_query", fake_embed_query)
    actual = await engine.unified_query_with_embedding("缓存策略 alpha", **options)
    assert observed["settings"] == options["query_embedding"]
    actual.pop("probe", None)
    actual.pop("search_diagnostics", None)
    actual["stats"].pop("elapsed_ms", None)

    request = {
        "op": "replace", "revision": "persistent-rev",
        "documents": [_worker_document_wire(document, key)],
        "vectors": {key: [0.25, 0.75]}, "vector_version": "synthetic:v1",
    }
    query_request = {
        "op": "unified_query", "revision": "persistent-rev", "query": "缓存策略 alpha",
        "searches": [{"id": "0", "source_types": ["project"], "limit": 8}],
        "source_order": ["project"], "candidate_limit": 8,
        "rank": options["rank_options"], "query_vector": [0.5, 0.5],
        "vector_version": "synthetic:v1",
    }
    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input="".join(json.dumps(item, ensure_ascii=False) + "\n" for item in (request, query_request)),
            text=True, capture_output=True, check=True, cwd=Path(__file__).parents[4], timeout=30,
        )
    expected = json.loads(completed.stdout.splitlines()[-1])
    expected.pop("version", None)
    expected.pop("probe", None)
    expected["stats"].pop("elapsed_ms", None)
    _assert_equal(actual, expected)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("revision", "transient_revision", "searches", "expected_message"),
    [
        ("stale-revision", None, [], "持久 RAG 索引 revision 不一致"),
        (
            "current-revision", "stale-transient",
            [{"corpus": "transient"}], "瞬态 RAG 索引 revision 不一致",
        ),
    ],
)
async def test_cython_query_embedding_rejects_stale_revision_before_embedding(
    monkeypatch, revision, transient_revision, searches, expected_message,
) -> None:
    """过期索引请求应在任何外部 embedding 调用前失败，避免无效上游成本。"""
    engine = CythonRagEngine()
    engine.replace([], "current-revision")
    engine.replace_transient([], "current-transient")
    called = False

    async def unexpected_embed(_query):
        nonlocal called
        called = True
        raise AssertionError("stale revision must not call embedding provider")

    monkeypatch.setattr("agent.memory.embedding.embed_query", unexpected_embed)
    with pytest.raises(CythonRevisionMismatch, match=expected_message):
        await engine.unified_query_with_embedding(
            "synthetic query", revision=revision, transient_revision=transient_revision,
            searches=searches,
            source_order=[], candidate_limit=5, rank_options={"limit": 5},
        )
    assert not called
