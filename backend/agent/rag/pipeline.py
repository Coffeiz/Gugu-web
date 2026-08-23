"""RAG 索引异步更新管线。"""
from __future__ import annotations

import asyncio
import time
from collections import defaultdict

from agent.rag.adapters.memory import MemoryAdapter
from agent.rag.diagnostics import record_index_update
from agent.rag.scope import normalize_memory_scope
from agent.rag.storage import PersistentMemoryIndex


MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = (0.05, 0.1)
_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


async def rebuild_memory_index(user_id: object, *, operation: str = "upsert") -> int:
    """重建一个 owner 的 Memory 索引；同一 owner 串行，返回文档数。"""
    key = str(user_id)
    async with _locks[key]:
        scope = normalize_memory_scope(user_id, "auto")
        documents = await MemoryAdapter(user_id).build_documents(scope=scope)
        await PersistentMemoryIndex(user_id).replace(documents)
        return len(documents)


async def handle_memory_index_event(event) -> None:
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
            return
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
