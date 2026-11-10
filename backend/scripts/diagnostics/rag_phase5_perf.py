"""PRD-RAG-9 性能测量：单文档持久索引更新 vs 来源级重建。

纯内存 SQLite + fake 投影，不触碰真实数据库/存储/模型；测量数据库投影和
缓存失效的 pipeline 耗时，不含 Cython 索引重建与 embedding。

用法：cd backend && PYTHONPATH=. .venv/bin/python scripts/diagnostics/rag_phase5_perf.py
"""
from __future__ import annotations

import asyncio
import statistics
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import agent.rag.pipeline as pipeline
from agent.rag.models import IndexDocument, Scope
from agent.rag.persistent_store import replace_source_documents


def _fake_projection(records):
    documents = []
    for record, scope in records:
        parts = [p for p in record["content"].split("|") if p]
        version = str(record.get("document_version") or "1").split(":")[0]
        for index, part in enumerate(parts):
            documents.append(IndexDocument(
                document_id=f"{record['source_id']}:{version}:{index}",
                source_type="knowledge", source_id=record["source_id"],
                scope=scope, title=record["title"], summary=record["summary"],
                content=part, version=version, chunk_index=index,
                chunk_count=len(parts), parent_document_id=record["source_id"],
            ))
    return documents


async def _save_entry(owner_id, entry_id: str, content: str):
    from agent.knowledge.capture import build_entry
    from agent.knowledge.store import KnowledgeStore

    entry = build_entry(owner_id, {
        "title": f"条目 {entry_id}", "content": content, "topic": f"主题{entry_id}",
        "keywords": ["关键词"], "source_type": "user", "source_ref": "",
        "source_label": "测试", "confidence": "confirmed",
    })
    entry.id = entry_id
    return await KnowledgeStore(owner_id).save(entry)


def _percentiles(values: list[float]) -> dict[str, float]:
    if not values:
        return {}
    ordered = sorted(values)
    return {
        "p50": round(statistics.median(ordered), 2),
        "p95": round(ordered[max(0, int(len(ordered) * 0.95) - 1)], 2),
        "max": round(max(ordered), 2),
    }


async def main() -> None:
    scale = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    chunk_count = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    print(f"# 规模：{scale} 条 knowledge × {chunk_count} chunk/条（内存 SQLite）")

    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    from app.models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as db:
        from app.models import User

        owner = User(id=uuid.uuid4(), username=f"perf-{uuid.uuid4().hex[:6]}",
                     email="perf@test.local", hashed_password="x")
        db.add(owner)
        await db.commit()
        owner_id = owner.id

    pipeline._in_memory_sqlite = lambda _engine: False
    import app.db.session as db_session

    db_session._engine = engine
    db_session._SessionLocal = session_factory
    db_session._engine_loop = asyncio.get_running_loop()

    async def fake_project(owner_user_id, source_type, records, **_kwargs):
        return _fake_projection(records)
    pipeline.records_to_write_documents = fake_project

    body = "|".join(f"第{n}段：关于主题{n}的正文内容，包含若干中文词项用于投影。" for n in range(chunk_count))

    async with session_factory() as db:
        from agent.rag.adapters.knowledge import KnowledgeAdapter

        seed_start = time.perf_counter()
        for i in range(scale):
            await _save_entry(owner_id, f"k-{i}", body)
        records = await KnowledgeAdapter(owner_id).build_source_records()
        documents = _fake_projection(records)
        await replace_source_documents(db, owner_id, "knowledge", documents)
        await db.commit()
    print(f"# 全量种子：{time.perf_counter() - seed_start:.2f}s（{len(documents)} chunk）")

    # 场景 1：单文档修改 ×20
    modify_ms, proj_ms, patch_ms = [], [], []
    for i in range(20):
        entry_id = f"k-{i}"
        await _save_entry(owner_id, entry_id, body.replace("第1段", f"改后第1段v{i}"))
        stats: dict = {}
        t0 = time.perf_counter()
        await pipeline.update_document(owner_id, "knowledge", entry_id, stats_out=stats)
        total = (time.perf_counter() - t0) * 1000
        modify_ms.append(total)
        proj_ms.append(float(stats.get("projection_ms") or 0))
        patch_ms.append(float(stats.get("patch_ms") or 0))
    print(f"单文档修改 ×20：端到端 ms {_percentiles(modify_ms)}；"
          f"projection_ms {_percentiles(proj_ms)}；cache_invalidation_ms {_percentiles(patch_ms)}")

    # 场景 2：单文档删除 ×20
    delete_ms = []
    for i in range(20, 40):
        entry_id = f"k-{i}"
        stats = {}
        t0 = time.perf_counter()
        await pipeline.update_document(
            owner_id, "knowledge", entry_id, operation="delete", stats_out=stats)
        delete_ms.append((time.perf_counter() - t0) * 1000)
    print(f"单文档删除 ×20：端到端 ms {_percentiles(delete_ms)}")

    # 场景 3：连续 10 次同源多文档变更（不同 ID 各一次 patch，不合并成全量）
    batch_ms = []
    for round_no in range(5):
        # 主数据先落，测量只含索引管线（对齐 PRD「实际重建次数」口径）
        ids = [f"k-{40 + round_no * 10 + j}" for j in range(10)]
        for entry_id in ids:
            await _save_entry(owner_id, entry_id, body.replace("第2段", f"轮{round_no}改第2段{entry_id}"))
        t0 = time.perf_counter()
        for entry_id in ids:
            stats = {}
            await pipeline.update_document(owner_id, "knowledge", entry_id, stats_out=stats)
        batch_ms.append((time.perf_counter() - t0) * 1000)
    print(f"连续 10 次同源多文档变更 ×5 轮：每轮 ms {[round(v, 1) for v in batch_ms]}")
    # 场景 4：来源级全量重建基线
    from agent.rag.adapters.knowledge import KnowledgeAdapter

    async with session_factory() as db:
        t0 = time.perf_counter()
        records = await KnowledgeAdapter(owner_id).build_source_records()
        docs = _fake_projection(records)
        stats = {}
        from agent.rag.persistent_store import replace_source_documents as rsd

        await rsd(db, owner_id, "knowledge", docs, stats=stats)
        await db.commit()
    print(f"来源级全量重建基线：{(time.perf_counter() - t0) * 1000:.1f}ms"
          f"（projection_ms={stats.get('projection_ms')}）")


if __name__ == "__main__":
    asyncio.run(main())
