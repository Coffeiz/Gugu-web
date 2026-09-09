"""RAG 索引异步更新管线。"""
from __future__ import annotations

import asyncio
import time
from collections import defaultdict

from agent.rag.adapters.memory import MemoryAdapter
from agent.rag.diagnostics import record_index_update
from agent.rag.index_builder import build_source_records, records_to_write_documents
from agent.rag.scope import normalize_memory_scope
from agent.rag.persistent_store import replace_source_documents
from agent.rag.storage import PersistentMemoryIndex
from agent.rag.vector_cache import sync_memory_index_vectors


MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = (0.05, 0.1)
_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
INDEX_EVENT_SOURCE_TYPES = {
    "project", "file", "note", "canvas", "calendar", "scheduled_task", "conversation", "knowledge",
}


async def rebuild_memory_index(user_id: object, *, operation: str = "upsert") -> int:
    """重建一个 owner 的 Memory 索引；同一 owner 串行，返回文档数。"""
    key = str(user_id)
    async with _locks[key]:
        scope = normalize_memory_scope(user_id, "auto")
        records = await MemoryAdapter(user_id).build_source_records(scope=scope)
        documents = await records_to_write_documents(user_id, "memory", records)
        await PersistentMemoryIndex(user_id).replace(documents)
        await sync_memory_index_vectors(user_id, documents)
        return len(documents)


async def handle_memory_index_event(event) -> bool:
    """处理 Memory 更新事件，最多重试三次，失败不影响业务写入。"""
    started = time.monotonic()
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            count = await rebuild_memory_index(event.user_id, operation=event.operation)
            record_index_update(
                source_type=event.source_type,
                operation=event.operation,
                document_count=count,
                attempt=attempt,
                success=True,
                elapsed_ms=int((time.monotonic() - started) * 1000),
            )
            return True
        except Exception:
            if attempt < MAX_RETRIES:
                await asyncio.sleep(RETRY_BACKOFF_SECONDS[attempt - 1])
                continue
            record_index_update(
                source_type=event.source_type,
                operation=event.operation,
                document_count=0,
                attempt=attempt,
                success=False,
                elapsed_ms=int((time.monotonic() - started) * 1000),
            )
            return False


async def rebuild_source_index(user_id: object, source_type: str, *, operation: str = "upsert") -> int:
    """在索引更新事件中构建来源文档；召回阶段不再读取主数据正文。"""
    if source_type not in INDEX_EVENT_SOURCE_TYPES:
        raise ValueError(f"不支持的索引事件来源：{source_type}")
    key = f"{user_id}:{source_type}"
    async with _locks[key]:
        import app.db.session as db_session

        # 测试基座使用 StaticPool 的内存 SQLite；异步索引任务若再开一条
        # session 会和测试事务共享同一连接，破坏 savepoint。真实服务使用
        # 持久数据库，不走这个短路。
        engine = db_session._engine
        if engine is not None and str(engine.url).startswith("sqlite") and engine.url.database is None:
            return 0
        engine = db_session.ensure_engine()
        if str(engine.url).startswith("sqlite") and engine.url.database is None:
            return 0
        async with db_session._SessionLocal() as db:
            records = await build_source_records(db, user_id, source_type)
            if records is None:
                raise RuntimeError(f"来源未提供 canonical source record：{source_type}")
            documents = await records_to_write_documents(user_id, source_type, records)
            count = await replace_source_documents(db, user_id, source_type, documents)
            await db.commit()
        if source_type == "knowledge":
            from agent.rag.vector_cache import sync_knowledge_index_vectors

            await sync_knowledge_index_vectors(user_id, documents)
        return count


async def handle_rag_index_event(event) -> bool:
    """处理非 Memory 来源索引事件，失败重试但不阻塞主业务写入。"""
    started = time.monotonic()
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            count = await rebuild_source_index(
                event.user_id, event.source_type, operation=event.operation,
            )
            record_index_update(
                source_type=event.source_type,
                operation=event.operation,
                document_count=count,
                attempt=attempt,
                success=True,
                elapsed_ms=int((time.monotonic() - started) * 1000),
            )
            return True
        except Exception:
            if attempt < MAX_RETRIES:
                await asyncio.sleep(RETRY_BACKOFF_SECONDS[attempt - 1])
                continue
            record_index_update(
                source_type=event.source_type,
                operation=event.operation,
                document_count=0,
                attempt=attempt,
                success=False,
                elapsed_ms=int((time.monotonic() - started) * 1000),
            )
            return False
