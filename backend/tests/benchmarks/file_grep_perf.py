"""文件 grep 的隔离合成基准；只生成进程内虚构语料，不访问应用数据库或存储。"""
from __future__ import annotations

import asyncio
import json
import math
import statistics
import time
import tracemalloc
from types import SimpleNamespace

from agent.tools.files import grep


FILE_COUNT = 128
LINES_PER_FILE = 32
LINE_WIDTH = 256
REPEATS = 21
LARGE_REPEATS = 11
LIMIT = 50


def make_corpus(file_count=FILE_COUNT, lines_per_file=LINES_PER_FILE):
    files = []
    objects = {}
    for file_index in range(file_count):
        lines = []
        for line_index in range(lines_per_file):
            marker = "合成命中" if file_index % 13 == 0 and line_index % 73 == 0 else "普通样本"
            if line_index == 7 and file_index % 17 == 0:
                marker += " Straße"
            prefix = f"行{line_index:03d} {marker} 文件{file_index:03d} "
            line = (prefix + "甲乙丙丁戊己庚辛壬癸" * 32)[:LINE_WIDTH]
            lines.append(line)
        key = str(file_index)
        body = ("\n".join(lines) + "\n").encode("utf-8")
        objects[key] = body
        files.append((SimpleNamespace(
            id=file_index + 1,
            storage_key=key,
            size_bytes=len(body),
            display_name=f"synthetic-{file_index:03d}",
            ext="txt",
            space="personal",
            project_id=None,
            folder_id=None,
            workspace_directory_id=None,
        ), f"/personal/synthetic-{file_index:03d}.txt"))
    return files, objects


class MemoryStorage:
    def __init__(self, objects):
        self.objects = objects
        self.reads = 0
        self.bytes_read = 0

    async def get(self, key):
        await asyncio.sleep(0.001)
        data = self.objects[key]
        self.reads += 1
        self.bytes_read += len(data)
        return data

    async def iter_chunks(self, key, *, chunk_size=64 * 1024):
        await asyncio.sleep(0.001)
        data = self.objects[key]
        self.reads += 1
        for offset in range(0, len(data), chunk_size):
            chunk = data[offset:offset + chunk_size]
            self.bytes_read += len(chunk)
            yield chunk


async def legacy_scan(candidates, storage, needle, context_lines, limit, case_sensitive, concurrency):
    grouped, total, truncated = [], 0, False
    for offset in range(0, len(candidates), concurrency):
        batch = candidates[offset:offset + concurrency]
        async def read(file):
            try:
                return await storage.get(file.storage_key)
            except Exception:
                return None
        texts = await asyncio.gather(*(read(file) for file, _ in batch))
        for (file, logical_path), text in zip(batch, texts):
            if text is None:
                continue
            lines = text.decode("utf-8").splitlines()
            hits = []
            for index, line in enumerate(lines):
                searchable = line if case_sensitive else line.casefold()
                if needle in searchable:
                    hits.append(index)
                    if len(hits) > limit:
                        break
            selected = hits[:limit - total]
            total += len(selected)
            truncated = truncated or len(selected) < len(hits)
            if selected:
                grouped.append({
                    "file_id": file.id,
                    "name": f"{file.display_name}.{file.ext}" if file.ext else file.display_name,
                    "space": file.space,
                    "path": logical_path,
                    "project_id": file.project_id,
                    "folder_id": file.folder_id,
                    "workspace_directory_id": file.workspace_directory_id,
                    "matches": [{
                        "line": index + 1,
                        "text": lines[index],
                        "context": [
                            {"line": context_index + 1, "text": lines[context_index]}
                            for context_index in range(max(0, index - context_lines), min(len(lines), index + context_lines + 1))
                        ],
                    } for index in selected],
                })
            if total >= limit:
                break
        if total >= limit:
            break
    return grouped, 0, total, truncated


def signature(result):
    groups, skipped, total, truncated = result
    return (groups, skipped, total, truncated)


def percentile95(values):
    return sorted(values)[math.ceil(0.95 * len(values)) - 1]


async def run_one(kind, candidates, objects, query, case_sensitive, concurrency):
    storage = MemoryStorage(objects)
    needle = query if case_sensitive else query.casefold()
    started = time.perf_counter()
    original_threshold = grep._STREAM_THRESHOLD_BYTES
    grep._STREAM_THRESHOLD_BYTES = 0 if kind == "stream" else grep._MAX_FILE_BYTES
    try:
        if kind == "buffered":
            result = await legacy_scan(candidates, storage, needle, 2, LIMIT, case_sensitive, concurrency)
        else:
            grep._READ_CONCURRENCY = concurrency
            result = await grep._scan_candidates(candidates, storage, needle, 2, LIMIT, case_sensitive)
    finally:
        grep._STREAM_THRESHOLD_BYTES = original_threshold
    elapsed_ms = (time.perf_counter() - started) * 1000
    return result, elapsed_ms, storage.reads, storage.bytes_read


async def main():
    candidates, objects = make_corpus()
    scenarios = [
        ("no_hit", "不存在标记", False),
        ("cjk_short", "合成", False),
        ("casefold_expansion", "strasse", False),
        ("case_sensitive", "Straße", True),
    ]
    report = {
        "corpus": {
            "files": len(candidates),
            "bytes": sum(len(value) for value in objects.values()),
            "lines_per_file": LINES_PER_FILE,
            "max_file_bytes": max(map(len, objects.values())),
            "repeats": REPEATS,
        },
        "runs": [],
        "large_file_case": {},
    }
    for label, query, case_sensitive in scenarios:
        scopes = [("all", candidates), ("path_subset", candidates[:16])]
        for scope, selected in scopes:
            baseline = None
            variants = [
                (kind, n)
                for kind in ("buffered", "stream")
                for n in (1, 4, 8, 16)
            ]
            for kind, concurrency in variants:
                timings, reads, bytes_read = [], [], []
                peak_bytes = 0
                current_sig = None
                for repeat in range(REPEATS):
                    if repeat == 0:
                        tracemalloc.start()
                    result, elapsed, read_count, read_bytes = await run_one(
                        kind, selected, objects, query, case_sensitive, concurrency,
                    )
                    if repeat == 0:
                        _, peak_bytes = tracemalloc.get_traced_memory()
                        tracemalloc.stop()
                    current_sig = signature(result)
                    timings.append(elapsed)
                    reads.append(read_count)
                    bytes_read.append(read_bytes)
                if baseline is None:
                    baseline = current_sig
                report["runs"].append({
                    "scenario": label,
                    "scope": scope,
                    "mode": kind,
                    "concurrency": concurrency,
                    "semantic_equal": current_sig == baseline,
                    "p50_ms": round(statistics.median(timings), 2),
                    "p95_ms": round(percentile95(timings), 2),
                    "files_read_mean": round(statistics.mean(reads), 1),
                    "bytes_read_mean": round(statistics.mean(bytes_read)),
                    "peak_tracemalloc_bytes": peak_bytes,
                })

    large_candidates, large_objects = make_corpus(file_count=8, lines_per_file=2048)
    large_timings = {"buffered": [], "stream": []}
    large_metrics = {}
    for mode in ("buffered", "stream"):
        peak_bytes = 0
        semantic_result = None
        for repeat in range(LARGE_REPEATS):
            if repeat == 0:
                tracemalloc.start()
            result, elapsed, read_count, read_bytes = await run_one(
                mode, large_candidates, large_objects, "不存在标记", False, 8,
            )
            if repeat == 0:
                _, peak_bytes = tracemalloc.get_traced_memory()
                tracemalloc.stop()
            semantic_result = signature(result)
            large_timings[mode].append(elapsed)
        large_metrics[mode] = {
            "p50_ms": round(statistics.median(large_timings[mode]), 2),
            "p95_ms": round(percentile95(large_timings[mode]), 2),
            "files_read": read_count,
            "bytes_read": read_bytes,
            "peak_tracemalloc_bytes": peak_bytes,
            "semantic_equal": semantic_result == signature((await run_one(
                "buffered", large_candidates, large_objects, "不存在标记", False, 8,
            ))[0]),
        }
    report["large_file_case"] = {
        "files": len(large_candidates),
        "bytes": sum(len(value) for value in large_objects.values()),
        "max_file_bytes": max(map(len, large_objects.values())),
        "repeats": LARGE_REPEATS,
        "results": large_metrics,
    }
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    asyncio.run(main())
