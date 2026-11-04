"""RAG 索引异步更新管线。"""
from __future__ import annotations

import asyncio
import time
from collections import defaultdict

from agent.rag.adapters.memory import MemoryAdapter
from agent.rag.diagnostics import record_index_update
from agent.rag.index_builder import build_source_records, records_to_write_documents
from agent.rag.scope import normalize_memory_scope
from agent.rag.persistent_store import (
    apply_document_patch,
    load_parent_documents,
    replace_source_documents,
)
from agent.rag.storage import PersistentMemoryIndex
from agent.rag.vector_cache import sync_memory_index_vectors


MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = (0.05, 0.1)
_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
INDEX_EVENT_SOURCE_TYPES = {
    "project", "note", "canvas", "calendar", "scheduled_task", "conversation", "knowledge",
}
INDEX_REBUILD_SOURCE_TYPES = ("memory", *sorted(INDEX_EVENT_SOURCE_TYPES))


def _in_memory_sqlite(engine) -> bool:
    """测试基座使用 StaticPool 的内存 SQLite；异步索引任务若再开一条
    session 会和测试事务共享同一连接，破坏 savepoint。真实服务使用
    持久数据库，不走这个短路（单测驱动管线时把本函数 monkeypatch 成 False）。"""
    return str(engine.url).startswith("sqlite") and engine.url.database is None


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
                mode="source_replace",
                status="failed",
            )
            return False


async def rebuild_source_index(
    user_id: object, source_type: str, *, operation: str = "upsert",
    stats_out: dict[str, object] | None = None,
) -> int:
    """在索引更新事件中构建来源文档；召回阶段不再读取主数据正文。

    这是来源级全量重建（PRD-RAG-9 的 ``source_replace`` 回退/基线路径）：
    读取来源全部对象并做来源内 chunk 对比替换。
    """
    if source_type not in INDEX_EVENT_SOURCE_TYPES:
        raise ValueError(f"不支持的索引事件来源：{source_type}")
    key = f"{user_id}:{source_type}"
    async with _locks[key]:
        import app.db.session as db_session

        engine = db_session._engine
        if engine is not None and _in_memory_sqlite(engine):
            return 0
        engine = db_session.ensure_engine()
        if _in_memory_sqlite(engine):
            return 0
        projection_started = time.monotonic()
        async with db_session._SessionLocal() as db:
            records = await build_source_records(db, user_id, source_type)
            if records is None:
                raise RuntimeError(f"来源未提供 canonical source record：{source_type}")
            documents = await records_to_write_documents(user_id, source_type, records)
            stats: dict[str, int] = {}
            count = await replace_source_documents(db, user_id, source_type, documents, stats=stats)
            await db.commit()
        projection_ms = int((time.monotonic() - projection_started) * 1000)
        if source_type == "knowledge":
            from agent.rag.vector_cache import sync_knowledge_index_vectors

            await sync_knowledge_index_vectors(user_id, documents)
        if stats_out is not None:
            stats_out.update({
                "mode": "source_replace",
                "upsert_count": stats.get("inserted", 0) + stats.get("updated", 0),
                "delete_count": stats.get("deleted", 0),
                "projection_ms": projection_ms,
            })
        return count


async def _owner_revision(db, user_id: object) -> str | None:
    """DB 推导的 owner revision（与查询侧 index_cache 同一实现）。"""
    from agent.rag.index_cache import get_index_cache

    return await get_index_cache()._revision(db, user_id)


DOCUMENT_PATCH_SOURCE_TYPES = {"knowledge", "project", "calendar", "note", "canvas"}


async def update_document(
    user_id: object, source_type: str, source_id: str, *, operation: str = "upsert",
    stats_out: dict[str, object] | None = None,
) -> int:
    """文档级增量：只读取/投影/写入发生变化的单个对象（PRD-RAG-9）。

    支持 knowledge/project（两者都有稳定的单对象 canonical record）。
    DB 持久索引按 chunk 增量替换；knowledge 额外做向量 upsert/delete；
    持久索引以数据库 revision 为准，写入后使本地缓存失效；Cython 生命周期按新 revision 同步。
    返回该文档当前 chunk 数。
    """
    if source_type not in DOCUMENT_PATCH_SOURCE_TYPES:
        raise ValueError(f"来源不支持文档级增量：{source_type}")
    from agent.rag.delta import compute_chunk_delta

    key = f"{user_id}:{source_type}:doc:{source_id}"
    async with _locks[key]:
        import app.db.session as db_session

        # 与 rebuild_source_index 相同的测试内存库短路。
        engine = db_session._engine
        if engine is not None and _in_memory_sqlite(engine):
            return 0
        engine = db_session.ensure_engine()
        if _in_memory_sqlite(engine):
            return 0
        started = time.monotonic()
        async with db_session._SessionLocal() as db:
            old_documents = await load_parent_documents(db, user_id, source_type, str(source_id))
            projection_started = time.monotonic()
            new_documents: list = []
            if operation != "delete":
                if source_type == "knowledge":
                    from agent.rag.adapters.knowledge import KnowledgeAdapter

                    record = await KnowledgeAdapter(user_id).build_source_record_for(str(source_id))
                else:
                    from agent.rag.index_builder import build_single_source_record

                    record = await build_single_source_record(
                        db, user_id, source_type, str(source_id),
                    )
                if record is not None:
                    new_documents = await records_to_write_documents(user_id, source_type, [record])
            delta = compute_chunk_delta(old_documents, new_documents)
            upserts = list(delta.upserts)
            delete_slots = list(delta.deletes)
            if stats_out is not None:
                stats_out.update({
                    "mode": "document_patch",
                    "upsert_count": len(upserts),
                    "delete_count": len(delete_slots),
                    "projection_ms": int((time.monotonic() - projection_started) * 1000),
                })
            if not upserts and not delete_slots:
                # 主数据与索引一致：不推进 revision，避免无谓的缓存失效。
                if stats_out is not None:
                    stats_out["status"] = "no_change"
                return len(old_documents)
            # knowledge 向量删除键来自旧 chunk（cache_key 含 version，不能用 slot key）。
            vector_delete_keys: set[str] = set()
            if source_type == "knowledge":
                from agent.rag.vector_cache import cache_key

                old_keys = {cache_key(doc) for doc in old_documents}
                new_keys = {cache_key(doc) for doc in new_documents}
                vector_delete_keys = {key for key in (old_keys - new_keys) if key}
            # DB 侧是父文档作用域 replace：必须传「当前全量 chunk 集」，
            # 未变化 chunk 的行才能按 PRD §6.3 保留（只传 delta.upserts 会把
            # 未变化 chunk 误打墓碑，部分编辑后索引静默丢内容）。
            # worker 侧只收 delta（变化 upserts + 消失 slot），保持增量语义。
            await apply_document_patch(
                db, user_id, source_type, str(source_id), new_documents,
            )
            revision = await _owner_revision(db, user_id)
            await db.commit()
        if source_type == "knowledge":
            from agent.knowledge.vector_cache import apply_vector_delta

            await apply_vector_delta(user_id, upserts, vector_delete_keys)
        patch_started = time.monotonic()
        from agent.rag.index_cache import get_index_cache

        get_index_cache().invalidate(user_id, include_snapshot=True)
        if stats_out is not None:
            stats_out.update({
                "patch_ms": int((time.monotonic() - patch_started) * 1000),
                "status": "index_invalidated",
            })
        return len(new_documents) if new_documents else len(old_documents) - len(delete_slots)


async def handle_rag_index_event(event) -> bool:
    """处理非 Memory 来源索引事件，失败重试但不阻塞主业务写入。

    旧版本排队的 file 事件直接消费，不再重建文件索引；knowledge/project 事件带 source_id 时走文档级增量；其余保持来源级
    全量重建（无 id 的批量事件、管理端校准）。
    """
    if event.source_type == "file":
        return True
    started = time.monotonic()
    use_document_patch = (
        event.source_type in DOCUMENT_PATCH_SOURCE_TYPES
        and bool(str(getattr(event, "source_id", "") or "").strip())
    )
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            stats_out: dict[str, object] = {}
            if use_document_patch:
                count = await update_document(
                    event.user_id, event.source_type, event.source_id,
                    operation=event.operation, stats_out=stats_out,
                )
                mode = str(stats_out.get("mode", "document_patch"))
            else:
                count = await rebuild_source_index(
                    event.user_id, event.source_type, operation=event.operation,
                    stats_out=stats_out,
                )
                mode = str(stats_out.get("mode", "source_replace"))
            stats = stats_out
            status = str(stats.get("status", "ready"))
            if getattr(event, "replayed", False) and status in {"ready", "index_invalidated"}:
                # durable outbox 重放成功的收敛，与首投递区分开（PRD-RAG-9 §9）。
                status = "event_replayed"
            record_index_update(
                source_type=event.source_type,
                operation=event.operation,
                document_count=count,
                attempt=attempt,
                success=True,
                elapsed_ms=int((time.monotonic() - started) * 1000),
                mode=mode,
                upsert_count=stats.get("upsert_count"),
                delete_count=stats.get("delete_count"),
                projection_ms=stats.get("projection_ms"),
                status=status,
                base_revision_match=stats.get("base_revision_match"),
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
                mode=str(stats_out.get("mode") or (
                    "document_patch" if use_document_patch else "source_replace"
                )),
                status="projection_failed",
            )
            return False
