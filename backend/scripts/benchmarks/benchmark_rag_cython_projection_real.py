#!/usr/bin/env python3
"""只读比较真实 owner source records 的 TS adapt 与 Cython projection。

只输出来源数量、差异数量和耗时；source record 正文只在当前进程内处理。
TS index_dir 使用临时目录，脚本不写数据库、向量存储或生产索引。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any
from uuid import UUID

from agent.rag.cython_projection import project_source_records
from agent.rag.index_builder import INDEX_SOURCE_TYPES, _chunk_projection_payload, build_source_records
from agent.rag.ts_sidecar import TsSidecarClient, scope_to_wire, wire_document_to_persistent
from app.core.config import get_settings
from app.db.session import dispose_engine, get_db


async def _run(owner: UUID) -> dict[str, Any]:
    settings = get_settings().search
    with tempfile.TemporaryDirectory(prefix="gugu-rag-projection-ab-") as index_dir:
        client = TsSidecarClient(
            f"cython-projection-ab:{owner}", command=settings.ts_sidecar_command,
            index_dir=index_dir,
        )
        source_results: dict[str, Any] = {}
        try:
            async for db in get_db():
                for source_type in INDEX_SOURCE_TYPES:
                    records = await build_source_records(db, owner, source_type)
                    if records is None:
                        raise RuntimeError("source record provider unavailable")

                    cython_started = time.perf_counter()
                    cython_documents = project_source_records(owner, source_type, records)
                    cython_elapsed_ms = (time.perf_counter() - cython_started) * 1000

                    payload = [
                        {**record, "scope": scope_to_wire(scope)}
                        for record, scope in records
                    ]
                    ts_started = time.perf_counter()
                    ts_wire_documents: list[dict[str, Any]] = []
                    for batch in _chunk_projection_payload(payload):
                        ts_wire_documents.extend(await client.adapt_records(source_type, batch))
                    ts_documents = [
                        wire_document_to_persistent(item, owner)
                        for item in ts_wire_documents
                    ]
                    ts_elapsed_ms = (time.perf_counter() - ts_started) * 1000

                    mismatch_count = 0
                    first_mismatch: str | None = None
                    for index in range(max(len(ts_documents), len(cython_documents))):
                        ts_document = ts_documents[index] if index < len(ts_documents) else None
                        cython_document = cython_documents[index] if index < len(cython_documents) else None
                        if ts_document != cython_document:
                            mismatch_count += 1
                            if first_mismatch is None:
                                if ts_document is None or cython_document is None:
                                    first_mismatch = "document_count_or_order"
                                else:
                                    first_mismatch = next((
                                        field for field in (
                                            "document_id", "source_type", "source_id", "scope", "title",
                                            "summary", "content", "version", "chunk_index", "chunk_count",
                                            "parent_document_id", "updated_at", "metadata",
                                        )
                                        if getattr(ts_document, field) != getattr(cython_document, field)
                                    ), "unknown")

                    source_results[source_type] = {
                        "records": len(records),
                        "ts_documents": len(ts_documents),
                        "cython_documents": len(cython_documents),
                        "mismatch_count": mismatch_count,
                        "first_mismatch_field": first_mismatch,
                        "ts_adapt_ms": round(ts_elapsed_ms, 2),
                        "cython_projection_ms": round(cython_elapsed_ms, 2),
                    }
                break
        finally:
            await client.close()
            await dispose_engine()

    return {
        "status": "completed",
        "sources": source_results,
        "total_records": sum(row["records"] for row in source_results.values()),
        "total_ts_documents": sum(row["ts_documents"] for row in source_results.values()),
        "total_cython_documents": sum(row["cython_documents"] for row in source_results.values()),
        "total_mismatches": sum(row["mismatch_count"] for row in source_results.values()),
        "scope_note": "只读 owner 数据；输出不含 source 正文、标题、ID 或账号标识。",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="真实 owner 数据上的只读 TS/Cython source projection A/B")
    parser.add_argument("--owner-user-id", required=True, help="须是明确授权的单用户 UUID")
    parser.add_argument("--allow-real-data", action="store_true", help="确认读取该 owner 的 source records")
    args = parser.parse_args()
    if not args.allow_real_data:
        parser.error("真实数据读取需显式指定 --allow-real-data")
    try:
        owner = UUID(args.owner_user_id)
        result = asyncio.run(_run(owner))
    except Exception as error:
        frame = traceback.extract_tb(error.__traceback__)[-1]
        print(
            f"A/B 失败：{type(error).__name__}；位置={Path(frame.filename).name}:{frame.lineno}"
            "；异常详情省略以保护用户数据",
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
