"""在隔离 PostgreSQL 临时表上比较 pg_trgm 搜索与写入维护成本。"""
from __future__ import annotations

import asyncio
import json
import math
import statistics
import time

from sqlalchemy import text

from app.db.session import dispose_engine, ensure_engine


ROW_COUNT = 512
LINES_PER_ROW = 32
REPEATS = 11


def percentile95(values):
    return sorted(values)[math.ceil(0.95 * len(values)) - 1]


def make_body(index):
    rows = []
    for line in range(LINES_PER_ROW):
        marker = "synthetic-index-hit" if index % 31 == 0 and line == 9 else "synthetic-no-match"
        rows.append((f"row-{index:04d} 合成样本 {marker} {line:02d} " + "alpha beta gamma delta " * 8)[:220])
    if index == 0:
        rows[10] = "Straße multilingual edge"
    return "\n".join(rows)


async def timed_query(conn, table, pattern, operator):
    values = []
    for _ in range(REPEATS):
        started = time.perf_counter()
        await conn.execute(text(
            f"SELECT count(*) FROM {table} WHERE body {operator} :pattern"
        ), {"pattern": pattern})
        values.append((time.perf_counter() - started) * 1000)
    return {
        "p50_ms": round(statistics.median(values), 3),
        "p95_ms": round(percentile95(values), 3),
    }


async def timed_write(conn, table, operation):
    values = []
    for repeat in range(REPEATS):
        transaction = await conn.begin()
        started = time.perf_counter()
        if operation == "update":
            await conn.execute(text(
                f"UPDATE {table} SET body = body || :suffix WHERE id BETWEEN 1 AND 16"
            ), {"suffix": " synthetic-update"})
        elif operation == "insert":
            await conn.execute(text(
                f"INSERT INTO {table} (id, body, path) SELECT :base + n, :body, :path FROM generate_series(1, 16) n"
            ), {"base": 10000 + repeat * 100, "body": "synthetic insert row", "path": "synthetic/insert"})
        elif operation == "move":
            await conn.execute(text(
                f"UPDATE {table} SET path = path || :suffix WHERE id BETWEEN 1 AND 16"
            ), {"suffix": "/synthetic-move"})
        else:
            await conn.execute(text(
                f"DELETE FROM {table} WHERE id BETWEEN 1 AND 16"
            ))
        values.append((time.perf_counter() - started) * 1000)
        await transaction.rollback()
    return {
        "p50_ms": round(statistics.median(values), 3),
        "p95_ms": round(percentile95(values), 3),
    }


async def main():
    engine = ensure_engine()
    index_build_ms = 0.0
    report = {}
    try:
        async with engine.connect() as conn:
            await conn.execute(text("CREATE TEMP TABLE grep_bench_plain (id integer PRIMARY KEY, body text NOT NULL, path text NOT NULL)"))
            await conn.execute(text("CREATE TEMP TABLE grep_bench_trgm (id integer PRIMARY KEY, body text NOT NULL, path text NOT NULL)"))
            bodies = [
                {"id": index + 1, "body": make_body(index), "path": f"synthetic/{index // 16}"}
                for index in range(ROW_COUNT)
            ]
            await conn.execute(text("INSERT INTO grep_bench_plain (id, body, path) VALUES (:id, :body, :path)"), bodies)
            await conn.execute(text("INSERT INTO grep_bench_trgm (id, body, path) VALUES (:id, :body, :path)"), bodies)
            await conn.commit()

            started = time.perf_counter()
            await conn.execute(text(
                "CREATE INDEX grep_bench_trgm_idx ON grep_bench_trgm USING gin (body gin_trgm_ops)"
            ))
            await conn.commit()
            index_build_ms = (time.perf_counter() - started) * 1000

            plan = (await conn.execute(text(
                "EXPLAIN (FORMAT JSON) SELECT count(*) FROM grep_bench_trgm WHERE body LIKE :pattern"
            ), {"pattern": "%synthetic-no-hit-unique%"})).scalar_one()
            plan_text = json.dumps(plan)
            candidate_counts = {}
            for label, pattern, operator in (
                ("three_char_no_hit", "%xyz%", "LIKE"),
                ("short_char", "%a%", "LIKE"),
                ("cjk_two_char", "%合成%", "LIKE"),
            ):
                plain_count = (await conn.execute(text(
                    f"SELECT count(*) FROM grep_bench_plain WHERE body {operator} :pattern"
                ), {"pattern": pattern})).scalar_one()
                indexed_count = (await conn.execute(text(
                    f"SELECT count(*) FROM grep_bench_trgm WHERE body {operator} :pattern"
                ), {"pattern": pattern})).scalar_one()
                candidate_counts[label] = {
                    "plain": int(plain_count),
                    "trigram": int(indexed_count),
                    "equal": plain_count == indexed_count,
                }

            unicode_pg = (await conn.execute(text(
                "SELECT count(*) FROM grep_bench_trgm WHERE body ILIKE :pattern"
            ), {"pattern": "%strasse%"})).scalar_one()
            unicode_python_casefold_match = "strasse" in "Straße".casefold()

            query_timings = {
                "plain_no_hit": await timed_query(conn, "grep_bench_plain", "%synthetic-no-hit-unique%", "LIKE"),
                "trigram_no_hit": await timed_query(conn, "grep_bench_trgm", "%synthetic-no-hit-unique%", "LIKE"),
                "plain_short": await timed_query(conn, "grep_bench_plain", "%a%", "LIKE"),
                "trigram_short": await timed_query(conn, "grep_bench_trgm", "%a%", "LIKE"),
            }
            await conn.commit()
            write_timings = {}
            for operation in ("insert", "update", "move", "delete"):
                write_timings[f"plain_{operation}"] = await timed_write(conn, "grep_bench_plain", operation)
                write_timings[f"trigram_{operation}"] = await timed_write(conn, "grep_bench_trgm", operation)
            index_bytes = (await conn.execute(text(
                "SELECT pg_relation_size('grep_bench_trgm_idx')"
            ))).scalar_one()
            report = {
                "corpus": {
                    "rows": ROW_COUNT,
                    "bytes_utf8": sum(len(item["body"].encode("utf-8")) for item in bodies),
                    "max_row_bytes": max(len(item["body"].encode("utf-8")) for item in bodies),
                    "repeats": REPEATS,
                },
                "index_build_ms": round(index_build_ms, 2),
                "index_bytes": int(index_bytes),
                "indexed_plan_uses_gin": "Bitmap Index Scan" in plan_text,
                "query_timings": query_timings,
                "write_timings_16_rows": write_timings,
                "candidate_counts": candidate_counts,
                "unicode_casefold_python_match": unicode_python_casefold_match,
                "unicode_casefold_pg_ilike_candidates": int(unicode_pg),
            }
            await conn.execute(text("DROP TABLE grep_bench_plain, grep_bench_trgm"))
            await conn.commit()
        print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    finally:
        await dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())
