"""对本地真实语料测 Tantivy sidecar 协议开销，不连接业务数据库。"""
from __future__ import annotations

import json
import statistics
import subprocess
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
CORPUS = Path("/tmp/gugu-rag-bm25-corpus.tsv")
QUERIES = Path("/tmp/gugu-rag-bm25-queries.txt")
BINARY = ROOT / "rust/target/release/gugu-rag-sidecar"


def load_inputs() -> tuple[list[dict], list[str]]:
    documents = []
    for line in CORPUS.read_text(encoding="utf-8").splitlines():
        document_id, text = line.split("\t", 1)
        documents.append({
            "id": document_id,
            "text": text,
            "owner_user_id": "benchmark-owner",
            "source_type": "project",
            "scope_type": "owner",
            "scope_id": "",
            "document_version": "benchmark-v1",
        })
    queries = [line for line in QUERIES.read_text(encoding="utf-8").splitlines() if line]
    return documents, queries


def start_sidecar() -> subprocess.Popen[str]:
    return subprocess.Popen(
        [str(BINARY)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        bufsize=1,
    )


def request(process: subprocess.Popen[str], payload: dict) -> dict:
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
    process.stdin.flush()
    response = json.loads(process.stdout.readline())
    if response.get("status") == "error":
        raise RuntimeError(response)
    return response


def replace_payload(documents: list[dict]) -> dict:
    return {"op": "replace", "revision": "benchmark-r1", "documents": documents}


def main() -> None:
    documents, queries = load_inputs()
    cold = []
    for _ in range(10):
        started = time.perf_counter()
        process = start_sidecar()
        request(process, replace_payload(documents))
        assert process.stdin is not None
        process.stdin.close()
        process.wait(timeout=10)
        cold.append((time.perf_counter() - started) * 1000)

    process = start_sidecar()
    request(process, replace_payload(documents))
    warm = []
    result_count = 0
    for _ in range(20):
        started = time.perf_counter()
        for query in queries:
            result_count += len(request(process, {
                "op": "search",
                "revision": "benchmark-r1",
                "query": query,
                "limit": 10,
                "owner_user_id": "benchmark-owner",
                "source_types": ["project"],
            }).get("results", []))
        warm.append((time.perf_counter() - started) * 1000 / len(queries))
    process.stdin.close()  # type: ignore[union-attr]
    process.wait(timeout=10)

    print(f"tantivy_docs={len(documents)}")
    print(f"tantivy_cold_mean_ms={statistics.mean(cold):.4f}")
    print(f"tantivy_cold_p50_ms={statistics.median(cold):.4f}")
    print(f"tantivy_cold_p95_ms={sorted(cold)[round((len(cold) - 1) * .95)]:.4f}")
    print(f"tantivy_warm_query_mean_ms={statistics.mean(warm):.4f}")
    print(f"tantivy_warm_query_p50_ms={statistics.median(warm):.4f}")
    print(f"tantivy_warm_query_p95_ms={sorted(warm)[round((len(warm) - 1) * .95)]:.4f}")
    print(f"tantivy_mean_result_count={result_count / (20 * len(queries)):.2f}")


if __name__ == "__main__":
    main()
