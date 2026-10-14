"""在隔离 PostgreSQL Compose 数据库中测量 grep 路径候选下推。"""
from __future__ import annotations

import asyncio
import json
import math
import statistics
import time
import tracemalloc
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import create_all_tables, dispose_engine, ensure_engine
from app.models import File, Folder, User
from agent.tools.files import grep


FILE_COUNT = 4096
TARGET_FILES = 16
REPEATS = 21


class SyntheticStorage:
    def __init__(self, bodies):
        self.bodies = bodies
        self.reads = 0
        self.bytes_read = 0

    async def iter_chunks(self, key, *, chunk_size=64 * 1024):
        await asyncio.sleep(0.001)
        body = self.bodies[key]
        self.reads += 1
        for offset in range(0, len(body), chunk_size):
            chunk = body[offset:offset + chunk_size]
            self.bytes_read += len(chunk)
            yield chunk

    async def get(self, key):
        await asyncio.sleep(0.001)
        body = self.bodies[key]
        self.reads += 1
        self.bytes_read += len(body)
        return body


def percentile95(values):
    return sorted(values)[math.ceil(0.95 * len(values)) - 1]


def make_body(index):
    marker = "合成标记" if index < TARGET_FILES else "无匹配样本"
    return f"{marker} 文件{index:04d}\n".encode("utf-8")


async def main():
    await create_all_tables()
    engine = ensure_engine()
    session = AsyncSession(engine, expire_on_commit=False)
    original_get_storage = grep.get_storage
    user_id = uuid4()
    bodies = {}
    try:
        user = User(
            id=user_id,
            username=f"bench-{user_id.hex}",
            email=f"bench-{user_id.hex}@example.invalid",
            hashed_password="synthetic-only",
        )
        folder = Folder(user_id=user_id, name="target")
        other_folders = [Folder(user_id=user_id, name=f"other-{index}") for index in range(7)]
        session.add_all([user, folder, *other_folders])
        await session.flush()

        files = []
        for index in range(FILE_COUNT):
            key = f"synthetic-{index:03d}"
            body = make_body(index)
            bodies[key] = body
            parent = folder if index < TARGET_FILES else other_folders[index % len(other_folders)]
            files.append(File(
                user_id=user_id,
                display_name=f"synthetic-{index:03d}",
                ext="txt",
                space="personal",
                folder_id=parent.id,
                storage_key=key,
                size=f"{len(body)} B",
                size_bytes=len(body),
                mime_type="text/plain",
            ))
        session.add_all(files)
        await session.flush()
        storage = SyntheticStorage(bodies)
        grep.get_storage = lambda: storage

        # 对照旧的全空间元数据候选，再由 Python 解析路径；与新 SQL 下推候选集比较。
        legacy_rows = await grep.list_grep_candidates(
            session, user_id=user_id, spaces=("personal",),
        )
        legacy_paths = await grep.resolve_grep_candidate_paths(
            session, user_id=user_id, files=legacy_rows,
        )
        legacy_candidates = grep._prepare_candidates(legacy_rows, legacy_paths, None)[0]
        baseline = await grep._scan_candidates(
            legacy_candidates, storage, "不存在标记", 0, 50, False,
        )
        legacy_scope = [
            item for item in legacy_candidates
            if item[1] == "/personal/target" or item[1].startswith("/personal/target/")
        ]
        expected_matches = await grep._scan_candidates(
            legacy_scope, storage, "不存在标记", 0, 50, False,
        )

        timing = {"path_after_metadata": [], "sql_path_pushdown": []}
        run_metrics = {}
        requested_path = "/personal/target"
        for scope, optimized in (("path_after_metadata", False), ("sql_path_pushdown", True)):
            for repeat in range(REPEATS):
                storage.reads = storage.bytes_read = 0
                tracemalloc.start()
                started = time.perf_counter()
                if optimized:
                    result = await grep._grep_files(session, user_id, {
                        "query": "不存在标记", "path": requested_path,
                        "context_lines": 0, "limit": 50,
                    })
                else:
                    rows = await grep.list_grep_candidates(
                        session, user_id=user_id, spaces=("personal",),
                    )
                    paths = await grep.resolve_grep_candidate_paths(
                        session, user_id=user_id, files=rows,
                    )
                    candidates, scanned, skipped = grep._prepare_candidates(
                        rows, paths, requested_path,
                    )
                    grouped, read_skipped, total, truncated = await grep._scan_candidates(
                        candidates, storage, "不存在标记", 0, 50, False,
                    )
                    result = {
                        "results": grouped,
                        "scanned_files": scanned,
                        "skipped_files": skipped + read_skipped,
                        "total_matches": total,
                        "truncated": truncated,
                    }
                elapsed_ms = (time.perf_counter() - started) * 1000
                _, peak_bytes = tracemalloc.get_traced_memory()
                tracemalloc.stop()
                timing[scope].append(elapsed_ms)
                run_metrics[scope] = {
                    "files_read": storage.reads,
                    "bytes_read": storage.bytes_read,
                    "peak_tracemalloc_bytes": peak_bytes,
                    "scanned_files": result["scanned_files"],
                }

        # 用有命中查询验证路径候选集没有漏掉同目录结果。
        all_hit = await grep._grep_files(session, user_id, {
            "query": "合成标记", "context_lines": 0, "limit": 200,
        })
        scoped_hit = await grep._grep_files(session, user_id, {
            "query": "合成标记", "path": requested_path, "context_lines": 0, "limit": 200,
        })
        expected_paths = {item[1] for item in legacy_scope}
        scoped_files = {item["path"] for item in scoped_hit["results"]}
        hit_equal = scoped_files == {
            item["path"] for item in all_hit["results"] if item["path"] in expected_paths
        }

        report = {
            "corpus": {
                "files": FILE_COUNT,
                "target_files": TARGET_FILES,
                "total_bytes": sum(map(len, bodies.values())),
                "max_file_bytes": max(map(len, bodies.values())),
                "repeats": REPEATS,
            },
            "results": {
                scope: {
                    "p50_ms": round(statistics.median(values), 2),
                    "p95_ms": round(percentile95(values), 2),
                    **run_metrics[scope],
                }
                for scope, values in timing.items()
            },
            "semantic_equal_no_hit": (
                baseline[0] == expected_matches[0] and baseline[2:] == expected_matches[2:]
            ),
            "semantic_equal_hits_within_path": hit_equal,
        }
        print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
        await session.rollback()
    finally:
        grep.get_storage = original_get_storage
        await session.close()
        await dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())
