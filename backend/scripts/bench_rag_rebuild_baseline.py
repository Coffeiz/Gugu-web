"""PRD-RAG-9 Phase 0 基线：来源级全量重建在不同规模下的成本。

对 knowledge / file / project 三个来源，按给定规模合成主数据，测量：
    - source record 生成耗时
    - TS canonical projection 耗时（worker 不可用时记录 unavailable 类别）
    - replace_source_documents 写库耗时与 chunk 数

只输出数量与毫秒；不输出任何正文。结果作为 Phase 4 增量对比的基线，
记录到 docs/devlog 的实施记录中。

用法（devserver，worker 制品已构建）：
    cd backend && .venv/bin/python scripts/bench_rag_rebuild_baseline.py \
        --scales 50 200 1000 [--out /tmp/rag-baseline.json]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SCALES = (50, 200, 1000)
SOURCES = ("knowledge", "file", "project")
ROUNDS = 3


async def _make_db():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.models import Base

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(db, owner: uuid.UUID, source_type: str, scale: int) -> None:
    """合成 scale 个主数据对象；knowledge 走存储（tmp 根），file/project 走内存库。"""
    from app.models import File, Project

    if source_type == "knowledge":
        from agent.knowledge.capture import normalize_capture, save_capture

        for index in range(scale):
            values = normalize_capture(
                f"条目 {index}",
                f"这是第 {index} 条知识正文。" + "细节内容。" * 40,
                source_type="user", confidence="confirmed", capture_mode="explicit",
                keywords=[f"标签{index % 7}"],
            )
            await save_capture(owner, values)
        return
    rows = [
        File(
            user_id=owner, display_name=f"文档-{index}.md", ext="md",
            space="project", storage_key=f"{owner}/bench/{index}.md",
            size="1KB", size_bytes=1024, mime_type="text/markdown",
        )
        for index in range(scale)
    ] if source_type == "file" else [
        Project(user_id=owner, name=f"项目 {index}", status="active")
        for index in range(scale)
    ]
    db.add_all(rows)
    await db.commit()


async def measure(source_type: str, scale: int, rounds: int) -> dict:
    from agent.rag.index_builder import build_source_records, records_to_write_documents
    from agent.rag.persistent_store import replace_source_documents

    engine, session_factory = await _make_db()
    owner = uuid.uuid4()
    results = []
    try:
        async with session_factory() as db:
            await _seed(db, owner, source_type, scale)
            for _ in range(rounds):
                started = time.monotonic()
                records = await build_source_records(db, owner, source_type)
                record_ms = int((time.monotonic() - started) * 1000)
                projection_error = ""
                projection_started = time.monotonic()
                stats: dict[str, int] = {}
                documents = []
                write_ms = -1
                try:
                    documents = await records_to_write_documents(owner, source_type, records)
                    projection_ms = int((time.monotonic() - projection_started) * 1000)
                except Exception as exc:  # worker 不可用：只记录异常类别
                    projection_error = type(exc).__name__
                    projection_ms = -1
                if documents:
                    write_started = time.monotonic()
                    await replace_source_documents(
                        db, owner, source_type, documents, stats=stats,
                    )
                    write_ms = int((time.monotonic() - write_started) * 1000)
                results.append({
                    "record_count": len(records),
                    "chunk_count": len(documents),
                    "record_ms": record_ms,
                    "projection_ms": projection_ms,
                    "projection_error": projection_error,
                    "write_ms": write_ms,
                    "inserted": stats.get("inserted", 0),
                    "updated": stats.get("updated", 0),
                    "deleted": stats.get("deleted", 0),
                })
    finally:
        await engine.dispose()

    def median(field: str) -> float:
        values = [r[field] for r in results if r[field] >= 0]
        return round(statistics.median(values), 1) if values else -1

    return {
        "source_type": source_type,
        "scale": scale,
        "rounds": rounds,
        "record_count": results[0]["record_count"],
        "chunk_count": results[0]["chunk_count"],
        "record_ms_median": median("record_ms"),
        "projection_ms_median": median("projection_ms"),
        "write_ms_median": median("write_ms"),
        "projection_error": results[0]["projection_error"],
        "write_counts": {
            "inserted": results[0]["inserted"],
            "updated": results[0]["updated"],
            "deleted": results[0]["deleted"],
        },
    }


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scales", type=int, nargs="*", default=list(SCALES))
    parser.add_argument("--rounds", type=int, default=ROUNDS)
    parser.add_argument("--sources", nargs="*", default=list(SOURCES))
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    from app.core.config import get_settings

    settings = get_settings()
    tmp_root = Path("/tmp") / f"rag-bench-{uuid.uuid4().hex[:8]}"
    tmp_root.mkdir(parents=True, exist_ok=True)
    settings.storage.local_path = str(tmp_root)

    report = []
    for source_type in args.sources:
        for scale in args.scales:
            row = await measure(source_type, scale, args.rounds)
            report.append(row)
            print(json.dumps(row, ensure_ascii=False))
    if args.out:
        Path(args.out).write_text(
            json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8",
        )


if __name__ == "__main__":
    asyncio.run(main())
