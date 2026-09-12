"""PRD-RAG-9 Phase 4：单文档变更下「文档级增量」与「来源级全量重建」的耗时对比。

在 scale 条 knowledge 中修改 1 条，分别走 update_document（document_patch）
与 rebuild_source_index（source_replace），各 ROUNDS 轮输出 P50/P95（毫秒）。
只输出计数与毫秒，不输出正文。

用法：cd backend && .venv/bin/python scripts/bench_rag_delta_compare.py --scale 1000
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


async def _make_db():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models import Base

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


class _NoWorker:
    """统计对比只关心 DB/投影路径；worker 侧走 patch 计时由 stats 提供。"""

    async def patch(self, upserts, deletes, revision, base_revision, **kwargs):
        return None

    async def replace(self, documents, revision, **kwargs):
        return None

    async def close(self):
        return None


async def _seed(owner, scale: int, tmp_root: Path):
    from agent.knowledge.capture import normalize_capture, save_capture

    from app.core.config import get_settings

    get_settings().storage.local_path = str(tmp_root)
    ids = []
    for index in range(scale):
        values = normalize_capture(
            f"条目 {index}", f"第 {index} 条正文。" + "细节。" * 40,
            topic=f"主题{index}",
            source_type="user", confidence="confirmed", capture_mode="explicit",
        )
        entry = await save_capture(owner, values)
        ids.append(entry.id)
    return ids


async def _measure(owner, scale: int, rounds: int, tmp_root: Path) -> dict:
    import app.db.session as db_session

    from agent.rag import pipeline
    from agent.rag.adapters.knowledge import KnowledgeAdapter
    from agent.rag.persistent_store import replace_source_documents

    engine, session_factory = await _make_db()
    monkey_engine = engine  # 直接接进 db_session 供管线使用
    db_session._engine = monkey_engine
    db_session._SessionLocal = session_factory
    pipeline._in_memory_sqlite = lambda _engine: False  # noqa: SLF001 基线脚本专用

    async def fake_client(_user_id):
        return _NoWorker()

    pipeline._knowledge_client = fake_client
    original = pipeline.records_to_write_documents

    async def counting_projection(user_id, source_type, records, **kwargs):
        started = time.monotonic()
        docs = await original(user_id, source_type, records, **kwargs)
        _PROJ_LOG.append(int((time.monotonic() - started) * 1000))
        return docs

    _PROJ_LOG: list[int] = []
    pipeline.records_to_write_documents = counting_projection

    try:
        async with session_factory() as db:
            ids = await _seed(owner, scale, tmp_root)
            records = await KnowledgeAdapter(owner).build_source_records()
            documents = await original(owner, "knowledge", records)
            await replace_source_documents(db, owner, "knowledge", documents)
            await db.commit()
        target_index = len(ids) // 2
        target = ids[target_index]
        doc_times, src_times = [], []
        for round_index in range(rounds):
            # 修改同一条（轮换正文使 digest 变化）
            from agent.knowledge.capture import build_entry
            from agent.knowledge.store import KnowledgeStore

            entry = build_entry(owner, {
                "title": f"条目 {target_index}", "content": f"第 {round_index} 轮修改正文。" + "新细节。" * 40,
                "topic": f"主题{target_index}", "keywords": [], "source_type": "user",
                "source_ref": "", "source_label": "bench", "confidence": "confirmed",
            })
            entry.id = target
            await KnowledgeStore(owner).save(entry)

            stats: dict = {}
            started = time.monotonic()
            await pipeline.update_document(owner, "knowledge", target, stats_out=stats)
            doc_times.append(int((time.monotonic() - started) * 1000))

            started = time.monotonic()
            await pipeline.rebuild_source_index(owner, "knowledge")
            src_times.append(int((time.monotonic() - started) * 1000))
        return {
            "scale": scale,
            "rounds": rounds,
            "document_patch_ms": doc_times,
            "source_replace_ms": src_times,
        }
    finally:
        await engine.dispose()


def _p(values: list[int], q: float) -> int:
    if not values:
        return -1
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scale", type=int, default=1000)
    parser.add_argument("--rounds", type=int, default=5)
    args = parser.parse_args()

    from app.core.config import get_settings

    settings = get_settings()
    tmp_root = Path("/tmp") / f"rag-delta-{uuid.uuid4().hex[:8]}"
    tmp_root.mkdir(parents=True, exist_ok=True)
    settings.storage.local_path = str(tmp_root)

    owner = uuid.uuid4()
    result = await _measure(owner, args.scale, args.rounds, tmp_root)
    doc = result["document_patch_ms"]
    src = result["source_replace_ms"]
    summary = {
        "scale": args.scale,
        "rounds": args.rounds,
        "document_patch_p50_ms": _p(doc, 0.5),
        "document_patch_p95_ms": _p(doc, 0.95),
        "source_replace_p50_ms": _p(src, 0.5),
        "source_replace_p95_ms": _p(src, 0.95),
        "document_patch_all_ms": doc,
        "source_replace_all_ms": src,
    }
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
