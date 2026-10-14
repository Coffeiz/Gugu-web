"""合成 PostgreSQL 数据库内 Bloom 候选过滤实验；只使用随机生成的文本。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import random
import resource
import statistics
import time
from pathlib import Path
from types import SimpleNamespace
from collections.abc import Iterable

import asyncpg
from agent.tools.files import grep as grep_module
from app.services.storage import LocalStorageBackend


FILE_COUNT = 6_000
BODY_CHARS = 1_900
FILTER_BYTES = 2 * 1024
HASH_COUNT = 5
REPEATS = 7
QUERY = "甲乙"
OWNER_ID = 1
MASK64 = (1 << 64) - 1


def _mix64(value: int) -> int:
    value = (value + 0x9E3779B97F4A7C15) & MASK64
    value = ((value ^ (value >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
    value = ((value ^ (value >> 27)) * 0x94D049BB133111EB) & MASK64
    return value ^ (value >> 31)


def gram_positions(gram: str, bit_count: int) -> tuple[int, ...]:
    """跨进程稳定地为一个 Unicode bigram 生成双重哈希位置。"""
    value = (ord(gram[0]) << 21) | ord(gram[1])
    first = _mix64(value ^ 0x4755475547524550)
    step = _mix64(value ^ 0x424C4F4F4D563031) | 1
    return tuple((first + index * step) % bit_count for index in range(HASH_COUNT))


def build_filter(text: str) -> bytes | None:
    """索引 UTF-8 可表示文本的 casefold 二元组；None 表示必须全量回退。"""
    try:
        folded = text.casefold()
        folded.encode("utf-8")
    except UnicodeEncodeError:
        return None
    bitmap = bytearray(FILTER_BYTES)
    bit_count = FILTER_BYTES * 8
    if not folded:
        return bytes(bitmap)
    previous = ord(folded[0])
    for char in folded[1:]:
        current = ord(char)
        value = (previous << 21) | current
        first = _mix64(value ^ 0x4755475547524550)
        step = _mix64(value ^ 0x424C4F4F4D563031) | 1
        for index in range(HASH_COUNT):
            position = (first + index * step) % bit_count
            bitmap[position >> 3] |= 1 << (position & 7)
        previous = current
    return bytes(bitmap)


def _may_contain(bitmap: bytes | None, query: str) -> bool:
    folded = query.casefold()
    if bitmap is None or len(folded) < 2:
        return True
    bit_count = len(bitmap) * 8
    return all(
        bitmap[position >> 3] & (1 << (position & 7))
        for offset in range(1, len(folded))
        for position in gram_positions(folded[offset - 1:offset + 1], bit_count)
    )


def verify_filter_semantics() -> int:
    cases = (
        ("中文字面边界", "中文"),
        ("Straße 与折叠扩展", "STRASSE"),
        ("Straße 与单字符折叠", "ß"),
        ("Kelvin 符号 Kelvin", "kelvin"),
        ("Straße", "STRASSE", True),
        ("甲\\n乙", "甲乙"),
        ("e\\u0301", "é"),
        ("甲乙", "甲"),
        ("\ud800", "不支持编码"),
    )
    for body, query, *sensitive_arg in cases:
        case_sensitive = sensitive_arg[0] if sensitive_arg else False
        needle = query if case_sensitive else query.casefold()
        is_exact = any(
            needle in (line if case_sensitive else line.casefold())
            for line in body.splitlines()
        )
        bitmap = build_filter(body)
        if is_exact and not _may_contain(bitmap, needle):
            raise AssertionError("Bloom filter produced a false negative")
    return len(cases)


def make_corpus() -> list[tuple[int, int, str, bytes, bool]]:
    rng = random.Random(20261014)
    alphabet = [chr(codepoint) for codepoint in range(0x4E00, 0x9FFF + 1)]
    rows = []
    for file_id in range(1, FILE_COUNT + 1):
        chars = [rng.choice(alphabet) for _ in range(BODY_CHARS)]
        if file_id == 1:
            chars[20:22] = list(QUERY)
        lines = ["".join(chars[offset:offset + 100]) for offset in range(0, BODY_CHARS, 100)]
        body = "\n".join(lines)
        bloom = build_filter(body)
        rows.append((file_id, OWNER_ID, body, bloom, bloom is not None))
    return rows


def exact_matches(rows: Iterable[tuple[int, str]]) -> set[int]:
    return {
        file_id
        for file_id, body in rows
        if any(QUERY in line.casefold() for line in body.splitlines())
    }


def percentile95(values: list[float]) -> float:
    return sorted(values)[math.ceil(0.95 * len(values)) - 1]


def _indexed_sql(positions: tuple[int, ...]) -> str:
    bit_clauses = " AND ".join(f"get_bit(b.bitset, {position}) = 1" for position in positions)
    return f"""
        SELECT f.id
        FROM grep_files AS f
        LEFT JOIN grep_bloom AS b ON b.file_id = f.id AND b.owner_id = f.owner_id
        WHERE f.owner_id = $1 AND f.is_deleted = false
          AND (b.file_id IS NULL OR b.complete = false OR ({bit_clauses}))
        ORDER BY f.id
    """


async def measure_queries(
    conn: asyncpg.Connection, positions: tuple[int, ...], *, file_count: int,
):
    indexed_sql = _indexed_sql(positions)
    full_timings: list[float] = []
    indexed_timings: list[float] = []
    full_transfer = indexed_transfer = candidate_count = exact_count = 0
    full_ids: set[int] = set()
    indexed_ids: set[int] = set()

    # 预热两条路径的计划和数据库页缓存。
    await conn.fetch("SELECT id FROM grep_files WHERE owner_id=$1 AND is_deleted=false", OWNER_ID)
    await conn.fetch(indexed_sql, OWNER_ID)
    for repeat in range(REPEATS):
        started = time.perf_counter()
        all_rows = await conn.fetch(
            "SELECT id, body FROM grep_files WHERE owner_id=$1 AND is_deleted=false ORDER BY id",
            OWNER_ID,
        )
        found_full = exact_matches((row["id"], row["body"]) for row in all_rows)
        full_timings.append((time.perf_counter() - started) * 1000)
        if repeat == 0:
            full_ids = found_full
            full_transfer = sum(len(row["body"].encode("utf-8")) for row in all_rows)

        started = time.perf_counter()
        candidate_rows = await conn.fetch(indexed_sql, OWNER_ID)
        ids = [row["id"] for row in candidate_rows]
        selected = await conn.fetch(
            "SELECT id, body FROM grep_files WHERE owner_id=$1 AND id = ANY($2::integer[]) ORDER BY id",
            OWNER_ID, ids,
        )
        found_indexed = exact_matches((row["id"], row["body"]) for row in selected)
        indexed_timings.append((time.perf_counter() - started) * 1000)
        if repeat == 0:
            indexed_ids = found_indexed
            candidate_count = len(ids)
            indexed_transfer = sum(len(row["body"].encode("utf-8")) for row in selected)
            exact_count = len(found_indexed)

    return {
        "full_scan": {
            "p50_ms": round(statistics.median(full_timings), 2),
            "p95_ms": round(percentile95(full_timings), 2),
            "files_read": file_count,
            "body_bytes_to_client": full_transfer,
        },
        "bloom_candidates": {
            "p50_ms": round(statistics.median(indexed_timings), 2),
            "p95_ms": round(percentile95(indexed_timings), 2),
            "files_read": candidate_count,
            "body_bytes_to_client": indexed_transfer,
            "filter_bytes_kept_in_db": file_count * FILTER_BYTES,
            "exact_matches": exact_count,
        },
        "semantic_equal": full_ids == indexed_ids,
    }


class CountingStorage:
    def __init__(self, root: Path):
        self.backend = LocalStorageBackend(root)
        self.reads = 0
        self.bytes_read = 0

    async def get(self, key: str) -> bytes:
        data = await self.backend.get(key)
        self.reads += 1
        self.bytes_read += len(data)
        return data

    async def iter_chunks(self, key: str, *, chunk_size: int = 64 * 1024):
        self.reads += 1
        async for chunk in self.backend.iter_chunks(key, chunk_size=chunk_size):
            self.bytes_read += len(chunk)
            yield chunk


def create_local_storage_corpus(corpus, root: Path):
    """创建 48k 个临时路径；同一份合成正文用 hardlink 扩容，减少磁盘写入。"""
    all_candidates = []
    by_id = {}
    for file_id in range(1, FILE_COUNT * 8 + 1):
        source_id = (file_id - 1) % FILE_COUNT
        source = corpus[source_id]
        shard = str(file_id // 500)
        relative_key = f"data/{shard}/{file_id}.txt"
        target = root / relative_key
        target.parent.mkdir(parents=True, exist_ok=True)
        if file_id <= FILE_COUNT:
            target.write_bytes(source[2].encode("utf-8"))
        else:
            source_file_id = source_id + 1
            source_path = root / f"data/{source_file_id // 500}/{source_file_id}.txt"
            target.hardlink_to(source_path)
        file = SimpleNamespace(
            id=file_id,
            display_name=f"synthetic-{file_id:05d}",
            ext="txt",
            space="personal",
            project_id=None,
            workspace_directory_id=None,
            folder_id=None,
            storage_key=relative_key,
            size_bytes=len(source[2].encode("utf-8")),
        )
        pair = (file, f"/personal/synthetic/{file_id}.txt")
        all_candidates.append(pair)
        by_id[file_id] = pair
    return all_candidates, by_id


async def measure_application_scans(conn, positions, corpus, root: Path):
    all_candidates, by_id = create_local_storage_corpus(corpus, root)
    indexed_sql = _indexed_sql(positions)
    original_concurrency = grep_module._READ_CONCURRENCY
    grep_module._READ_CONCURRENCY = 64
    try:
        # 预热文件页缓存和 SQL 计划；两条路径各先运行一次但不计时。
        await grep_module._scan_candidates(all_candidates, CountingStorage(root), QUERY, 0, 50, False)
        warm_ids = [row["id"] for row in await conn.fetch(indexed_sql, OWNER_ID)]
        warm_candidates = [by_id[file_id] for file_id in warm_ids if file_id in by_id]
        await grep_module._scan_candidates(warm_candidates, CountingStorage(root), QUERY, 0, 50, False)

        full_timings = []
        indexed_timings = []
        full_metrics = {}
        indexed_metrics = {}
        expected = None
        for _ in range(REPEATS):
            storage = CountingStorage(root)
            started = time.perf_counter()
            full_result = await grep_module._scan_candidates(
                all_candidates, storage, QUERY, 0, 50, False,
            )
            full_timings.append((time.perf_counter() - started) * 1000)
            full_signature = (len(full_result[0]), full_result[2], full_result[3])
            expected = full_signature
            full_metrics = {"files_read": storage.reads, "bytes_read": storage.bytes_read}

            storage = CountingStorage(root)
            started = time.perf_counter()
            indexed_ids = [row["id"] for row in await conn.fetch(indexed_sql, OWNER_ID)]
            selected = [by_id[file_id] for file_id in indexed_ids if file_id in by_id]
            indexed_result = await grep_module._scan_candidates(
                selected, storage, QUERY, 0, 50, False,
            )
            indexed_timings.append((time.perf_counter() - started) * 1000)
            indexed_signature = (len(indexed_result[0]), indexed_result[2], indexed_result[3])
            indexed_metrics = {
                "files_read": storage.reads,
                "bytes_read": storage.bytes_read,
                "db_candidates": len(indexed_ids),
            }
            if indexed_signature != expected:
                raise AssertionError("候选过滤后实际 grep 扫描结果不等价")
        return {
            "full_scan": {
                "p50_ms": round(statistics.median(full_timings), 2),
                "p95_ms": round(percentile95(full_timings), 2),
                **full_metrics,
            },
            "bloom_filtered_scan": {
                "p50_ms": round(statistics.median(indexed_timings), 2),
                "p95_ms": round(percentile95(indexed_timings), 2),
                **indexed_metrics,
            },
            "semantic_equal": True,
        }
    finally:
        grep_module._READ_CONCURRENCY = original_concurrency


async def measure_writes(conn: asyncpg.Connection):
    timings: dict[str, list[float]] = {kind: [] for kind in ("insert", "edit", "move", "delete")}
    for repeat in range(REPEATS):
        ids = list(range(700_000 + repeat * 16, 700_016 + repeat * 16))
        bodies = [f"合成写入样本 {repeat} {index} " + "随机内容甲乙丙丁" * 120 for index in range(16)]
        started = time.perf_counter()
        filters = [build_filter(body) for body in bodies]
        await conn.executemany(
            "INSERT INTO grep_files(id, owner_id, body, is_deleted, path) VALUES($1,$2,$3,false,$4)",
            [(file_id, OWNER_ID, body, f"synthetic/{file_id}") for file_id, body in zip(ids, bodies)],
        )
        await conn.executemany(
            "INSERT INTO grep_bloom(file_id, owner_id, bitset, complete) VALUES($1,$2,$3,true)",
            [(file_id, OWNER_ID, bitmap) for file_id, bitmap in zip(ids, filters) if bitmap is not None],
        )
        timings["insert"].append((time.perf_counter() - started) * 1000)

        edited = [body + "编辑内容" for body in bodies]
        started = time.perf_counter()
        edited_filters = [build_filter(body) for body in edited]
        await conn.executemany(
            "UPDATE grep_files SET body=$2 WHERE id=$1",
            [(file_id, body) for file_id, body in zip(ids, edited)],
        )
        await conn.executemany(
            "UPDATE grep_bloom SET bitset=$2, complete=true WHERE file_id=$1 AND owner_id=$3",
            [(file_id, bitmap, OWNER_ID) for file_id, bitmap in zip(ids, edited_filters)],
        )
        timings["edit"].append((time.perf_counter() - started) * 1000)

        started = time.perf_counter()
        await conn.execute("UPDATE grep_files SET path=path || '/moved' WHERE id = ANY($1::integer[])", ids)
        timings["move"].append((time.perf_counter() - started) * 1000)

        started = time.perf_counter()
        await conn.execute("DELETE FROM grep_files WHERE id = ANY($1::integer[])", ids)
        timings["delete"].append((time.perf_counter() - started) * 1000)

    return {
        kind: {
            "p50_ms": round(statistics.median(values), 2),
            "p95_ms": round(percentile95(values), 2),
        }
        for kind, values in timings.items()
    }


async def main():
    import os

    dsn = os.environ["GREP_BENCH_DATABASE_URL"]
    conn = await asyncpg.connect(dsn)
    started = time.perf_counter()
    corpus = await asyncio.to_thread(make_corpus)
    build_ms = (time.perf_counter() - started) * 1000
    peak_rss_kib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    started = time.perf_counter()
    await conn.execute("""
        CREATE TABLE grep_files (
            id integer PRIMARY KEY,
            owner_id integer NOT NULL,
            body text NOT NULL,
            is_deleted boolean NOT NULL,
            path text NOT NULL
        )
    """)
    await conn.execute("""
        CREATE TABLE grep_bloom (
            file_id integer PRIMARY KEY REFERENCES grep_files(id) ON DELETE CASCADE,
            owner_id integer NOT NULL,
            bitset bytea NOT NULL,
            complete boolean NOT NULL
        )
    """)
    await conn.executemany(
        "INSERT INTO grep_files(id, owner_id, body, is_deleted, path) VALUES($1,$2,$3,false,$4)",
        [(file_id, owner_id, body, f"synthetic/{file_id}") for file_id, owner_id, body, _, _ in corpus],
    )
    await conn.executemany(
        "INSERT INTO grep_bloom(file_id, owner_id, bitset, complete) VALUES($1,$2,$3,$4)",
        [(file_id, owner_id, bitmap, complete) for file_id, owner_id, _, bitmap, complete in corpus if bitmap is not None],
    )
    database_load_ms = (time.perf_counter() - started) * 1000
    # 不完整和缺失索引必须作为候选回退；跨 owner 命中和已删除命中必须被排除。
    await conn.execute("UPDATE grep_bloom SET complete=false WHERE file_id=2")
    await conn.execute("DELETE FROM grep_bloom WHERE file_id=3")
    positions = gram_positions(QUERY.casefold(), FILTER_BYTES * 8)
    await conn.execute("INSERT INTO grep_files VALUES(500001,2,$1,false,'synthetic/other-owner')", QUERY)
    await conn.execute("INSERT INTO grep_files VALUES(500002,1,$1,true,'synthetic/deleted')", QUERY)
    await conn.execute("INSERT INTO grep_bloom SELECT id,owner_id,$1,true FROM grep_files WHERE id=500001", bytes(FILTER_BYTES))
    small_query = await measure_queries(conn, positions, file_count=FILE_COUNT)

    # 复制固定种子的合成行扩展到真实查询的候选行数量级；不重新生成正文/位图。
    scale_started = time.perf_counter()
    for multiplier in range(1, 8):
        offset = multiplier * FILE_COUNT
        await conn.execute("""
            INSERT INTO grep_files(id, owner_id, body, is_deleted, path)
            SELECT id + $1, owner_id, body, is_deleted, path FROM grep_files
            WHERE id BETWEEN 1 AND $2
        """, offset, FILE_COUNT)
        await conn.execute("""
            INSERT INTO grep_bloom(file_id, owner_id, bitset, complete)
            SELECT file_id + $1, owner_id, bitset, complete FROM grep_bloom
            WHERE file_id BETWEEN 1 AND $2
        """, offset, FILE_COUNT)
    scale_ms = (time.perf_counter() - scale_started) * 1000
    large_query = await measure_queries(conn, positions, file_count=FILE_COUNT * 8)
    with __import__("tempfile").TemporaryDirectory(prefix="gugu-grep-synthetic-storage-") as directory:
        storage_scan_report = await measure_application_scans(
            conn, positions, corpus, Path(directory),
        )
    write_report = await measure_writes(conn)
    await conn.execute("ANALYZE grep_files")
    await conn.execute("ANALYZE grep_bloom")
    sizes = await conn.fetchrow("""
        SELECT pg_relation_size('grep_files') AS files_heap,
               pg_relation_size('grep_bloom') AS bloom_heap,
               pg_total_relation_size('grep_bloom') AS bloom_total
    """)
    report = {
        "filter_semantic_property_cases": verify_filter_semantics(),
        "corpus": {
            "files": FILE_COUNT,
            "unique_body_bytes": sum(len(body.encode("utf-8")) for _, _, body, _, _ in corpus),
            "scaled_files": FILE_COUNT * 8,
            "scaled_logical_body_bytes": sum(len(body.encode("utf-8")) for _, _, body, _, _ in corpus) * 8,
            "mean_file_bytes": round(statistics.mean(len(body.encode("utf-8")) for _, _, body, _, _ in corpus)),
            "filter_bytes_per_file": FILTER_BYTES,
            "filter_build_ms": round(build_ms, 2),
            "database_load_ms": round(database_load_ms, 2),
            "scale_to_48000_ms": round(scale_ms, 2),
            "process_peak_rss_kib_after_build": peak_rss_kib,
        },
        "query_6000_files": small_query,
        "query_48000_files": large_query,
        "application_storage_scan_48000_files": storage_scan_report,
        "writes_16_files": write_report,
        "storage": {key: int(value) for key, value in sizes.items()},
    }
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
