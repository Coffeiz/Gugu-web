"""使用同一批 source record 对比 Python 与常驻 TS 文档构建。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from agent.rag.chunking import split_text


def make_batch(size: int) -> dict[str, list[dict]]:
    scope = {"scope_type": "owner", "scope_id": "benchmark-owner"}
    batch: dict[str, list[dict]] = {"memory": [], "project": [], "files": [], "knowledge": []}
    for index in range(size):
        content = (
            f"第 {index} 条测试知识。用于比较统一 RAG source builder 的分块、摘要和稳定 ID。"
            "这段内容足够长，用于覆盖句子边界和跨 chunk 的行为。"
        )
        batch["memory"].append({
            "id": f"memory-{index}", "source_type": "memory", "title": "测试记忆",
            "content": content, "document_version": "v1", "scope": scope,
        })
        batch["project"].append({
            "id": f"project-{index}", "source_type": "project", "title": "测试项目",
            "content": content, "document_version": "v1", "scope": scope,
        })
        batch["files"].append({
            "id": index, "display_name": f"测试-{index}.md", "ext": "md",
            "content": content, "document_version": "v1", "scope": scope,
        })
    for index in range(size):
        content = (
            f"第 {index} 条测试知识。用于比较统一 RAG source builder 的分块、摘要和稳定 ID。"
            "这段内容足够长，用于覆盖句子边界和跨 chunk 的行为。"
        )
        batch["knowledge"].append({
            "id": f"knowledge-{index}", "source_type": "knowledge", "title": "测试知识",
            "content": content, "document_version": "v1", "scope": scope,
        })
    return batch


def python_documents(batch: dict[str, list[dict]]) -> list[dict]:
    documents = []
    for source, records in batch.items():
        for record in records:
            if source == "files":
                source_type = "file"
                source_id = str(record["id"])
                text = "\n".join(filter(None, [
                    f"文件：{record['display_name']}",
                    f"类型：{record['ext']}",
                    record.get("content", ""),
                ]))
                title = record["display_name"]
            else:
                source_type = record["source_type"]
                source_id = str(record["id"])
                text = str(record.get("content") or "").strip()
                title = record["title"]
            pieces = split_text(text)
            parent = f"{source_type}:{source_id}"
            for index, piece in enumerate(pieces):
                documents.append({
                    "id": f"{parent}:{index}", "text": piece,
                    "source_type": source_type, "title": title,
                    "summary": text[:240], **record["scope"],
                    "scope_type": record["scope"]["scope_type"],
                    "scope_id": record["scope"]["scope_id"],
                    "document_version": record["document_version"],
                    "parent_id": parent, "chunk_index": index,
                    "chunk_count": len(pieces),
                })
    return documents


def digest(documents: list[dict]) -> str:
    canonical = json.dumps(documents, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


def _start_worker(worker: Path):
    node = shutil.which("node") or "node"
    process = subprocess.Popen(
        [node, str(worker)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, env=os.environ.copy(),
    )
    process.stdin.write('{"op":"ping"}\n')
    process.stdin.flush()
    json.loads(process.stdout.readline())
    return process


def run_ts(worker: Path, batch: dict, iterations: int) -> tuple[list[dict], float]:
    process = _start_worker(worker)
    try:
        started = time.perf_counter()
        documents: list[dict] = []
        for _ in range(iterations):
            process.stdin.write(json.dumps({"op": "build_documents", "batch": batch}, ensure_ascii=False) + "\n")
            process.stdin.flush()
            response = json.loads(process.stdout.readline())
            if response.get("status") != "ok":
                raise RuntimeError(response)
            documents = response["documents"]
            process.stdin.write(json.dumps({
                "op": "replace", "revision": "benchmark-legacy", "documents": documents,
            }, ensure_ascii=False) + "\n")
            process.stdin.flush()
            replace_response = json.loads(process.stdout.readline())
            if replace_response.get("status") != "ok":
                raise RuntimeError(replace_response)
        return documents, (time.perf_counter() - started) * 1000 / iterations
    finally:
        process.terminate()
        process.wait(timeout=3)


def run_ts_build_and_index(worker: Path, batch: dict, iterations: int) -> float:
    process = _start_worker(worker)
    try:
        started = time.perf_counter()
        for index in range(iterations):
            process.stdin.write(json.dumps({
                "op": "build_and_index", "revision": f"benchmark-{index}", "batch": batch,
            }, ensure_ascii=False) + "\n")
            process.stdin.flush()
            response = json.loads(process.stdout.readline())
            if response.get("status") != "ok":
                raise RuntimeError(response)
        return (time.perf_counter() - started) * 1000 / iterations
    finally:
        process.terminate()
        process.wait(timeout=3)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", type=int, default=250)
    parser.add_argument("--iterations", type=int, default=10)
    parser.add_argument("--worker", type=Path, default=Path(__file__).parents[1] / "bin/gugu-rag-ts-worker.mjs")
    args = parser.parse_args()
    batch = make_batch(max(1, args.records))

    started = time.perf_counter()
    python_result = python_documents(batch)
    python_ms = (time.perf_counter() - started) * 1000
    ts_result, ts_ms = run_ts(args.worker, batch, max(1, args.iterations))
    combined_ms = run_ts_build_and_index(args.worker, batch, max(1, args.iterations))

    # 文件适配器的字段与通用 source record 略有差异，比较稳定的公共投影。
    def public(document: dict) -> dict:
        return {key: document.get(key) for key in (
            "id", "text", "source_type", "title", "summary", "scope_type",
            "scope_id", "document_version", "parent_id", "chunk_index", "chunk_count",
        )}

    python_public = [public(item) for item in python_result]
    ts_public = [public(item) for item in ts_result]
    print(json.dumps({
        "records_per_source": args.records,
        "document_count": {"python": len(python_public), "ts": len(ts_public)},
        "semantic_equal": python_public == ts_public,
        "digest": {"python": digest(python_public), "ts": digest(ts_public)},
        "average_ms": {
            "python_single_build": round(python_ms, 3),
            "ts_warm_build_roundtrip": round(ts_ms, 3),
            "ts_build_and_index_roundtrip": round(combined_ms, 3),
        },
        "roundtrip_improvement": round((1 - combined_ms / ts_ms) * 100, 2) if ts_ms else None,
        "note": "基准只比较 source record 到 canonical chunk/index；不包含数据库和对象存储读取。",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
