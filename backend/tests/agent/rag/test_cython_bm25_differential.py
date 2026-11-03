"""固定种子的大语料矩阵逐项对照 TS worker 与编译 Cython BM25。"""
from __future__ import annotations

import json
import math
import random
import subprocess
import tempfile
from pathlib import Path

from agent.rag.cython_backend import CythonLexicalIndex, _worker_document_wire
from agent.rag.delta import chunk_slot_key
from agent.rag.models import IndexDocument, Scope


def _document(index: int, source: str, terms: list[str], scope: Scope, metadata: dict) -> IndexDocument:
    identifier = f"fixture-{index:04d}"
    return IndexDocument(
        document_id=identifier,
        source_type=source,
        source_id=identifier,
        scope=scope,
        title="",
        summary="",
        content=" ".join(terms),
        version="fixture-v1",
        parent_document_id=identifier,
        metadata=metadata,
    )


def _assert_score_equal(actual: float, expected: float, case: int) -> None:
    assert math.isclose(actual, expected, rel_tol=0, abs_tol=1e-12), f"case={case}"


def test_compiled_bm25_matches_ts_for_generated_corpus_and_filter_matrix() -> None:
    """阻止词频/全语料 IDF、稳定并列顺序及 scope/source 过滤组合发生漂移。"""
    rng = random.Random(0xB25C17)
    vocabulary = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "theta"]
    sources = ["project", "knowledge", "memory"]
    documents: list[IndexDocument] = []
    for index in range(256):
        source = rng.choice(sources)
        if index % 11 == 0:
            scope = Scope("owner-fixture", "qq", "bot-a", "group-a", "group", "group-a")
        else:
            scope = Scope("owner-fixture", scope_type="owner")
        if index % 13 == 0:
            terms = ["alpha", "beta", "alpha"]
        else:
            terms = rng.choices(vocabulary, k=rng.randint(1, 14))
        metadata = {
            "project_id": f"project-{index % 5}",
            "folder_id": f"folder-{index % 7}",
        }
        documents.append(_document(index, source, terms, scope, metadata))

    index = CythonLexicalIndex.build(documents, "revision-generated")
    wire_documents = [
        _worker_document_wire(document, chunk_slot_key(document))
        for document in documents
    ]

    scope_matrix: list[Scope | None] = [
        None,
        Scope("owner-fixture", scope_type="owner"),
        Scope("owner-fixture", scope_type="project", scope_id="project-2"),
        Scope("owner-fixture", scope_type="folder", scope_id="folder-3"),
        Scope("owner-fixture", "qq", "bot-a", "group-a", "group", "group-a"),
        Scope("owner-fixture", "qq", "bot-a", "group-a", "member", "group-a:user-a"),
    ]
    source_matrix = [(), ("project",), ("knowledge", "memory"), ("unknown",)]
    limits = (0, 1, 5, 10, 49, 50, 80)
    query_matrix = (
        "alpha beta", "alpha beta alpha", "gamma delta epsilon", "unknown-token",
        "zeta theta", "beta beta gamma", "alpha", "epsilon delta zeta",
    )

    requests: list[dict] = [
        {"op": "replace", "revision": "revision-generated", "documents": wire_documents},
    ]
    cases: list[tuple[str, tuple[str, ...], Scope | None, int]] = []
    for case_number in range(128):
        query = query_matrix[case_number % len(query_matrix)]
        source_types = source_matrix[(case_number // 3) % len(source_matrix)]
        scope = scope_matrix[(case_number // 2) % len(scope_matrix)]
        limit = limits[(case_number // 5) % len(limits)]
        cases.append((query, source_types, scope, limit))
        requests.append({
            "op": "search",
            "revision": "revision-generated",
            "query": query,
            "limit": limit,
            "source_types": list(source_types),
            **({"scope": {
                "platform": scope.platform,
                "bot_id": scope.bot_id,
                "group_id": scope.group_id,
                "scope_type": scope.scope_type,
                "scope_id": scope.scope_id,
            }} if scope is not None else {}),
        })

    repo_root = Path(__file__).parents[4]
    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input="".join(json.dumps(request, ensure_ascii=False) + "\n" for request in requests),
            text=True,
            capture_output=True,
            check=True,
            cwd=repo_root,
            timeout=60,
        )
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    assert len(responses) == len(requests)

    for case_number, ((query, source_types, scope, limit), response) in enumerate(
        zip(cases, responses[1:]),
    ):
        assert response["status"] == "ok", f"case={case_number}"
        actual, diagnostics = index.search(
            query, limit=limit, source_types=source_types, scope=scope,
        )
        expected_rows = response["results"]
        assert [chunk_slot_key(row.document) for row in actual] == [
            row["id"] for row in expected_rows
        ], f"case={case_number}: result order"
        for actual_row, expected_row in zip(actual, expected_rows):
            _assert_score_equal(actual_row.score, expected_row["score"], case_number)
            assert actual_row.document.source_type == expected_row["source_type"], f"case={case_number}"
            assert actual_row.document.version == expected_row["document_version"], f"case={case_number}"

        expected_diagnostics = response["diagnostics"]
        assert diagnostics.candidate_count == expected_diagnostics["candidate_count"], f"case={case_number}"
        assert diagnostics.eligible_count == expected_diagnostics["eligible_count"], f"case={case_number}"
        assert diagnostics.filtered_count == expected_diagnostics["filtered_count"], f"case={case_number}"
        assert diagnostics.source_filter_applied == expected_diagnostics["source_filter_applied"], f"case={case_number}"
        assert diagnostics.scope_filter_applied == expected_diagnostics["scope_filter_applied"], f"case={case_number}"
