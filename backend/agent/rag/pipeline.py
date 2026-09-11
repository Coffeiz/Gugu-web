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
    load_index_documents,
    load_parent_documents,
    replace_source_documents,
)
from agent.rag.storage import PersistentMemoryIndex
from agent.rag.vector_cache import sync_memory_index_vectors


MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = (0.05, 0.1)
_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
INDEX_EVENT_SOURCE_TYPES = {
    "project", "file", "note", "canvas", "calendar", "scheduled_task", "conversation", "knowledge",
}


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


async def _knowledge_client(user_id: object):
    from app.core.config import get_settings
    from agent.rag.index_cache import index_dir_for_owner
    from agent.rag.ts_sidecar import get_lexical_client

    settings = get_settings()
    return await get_lexical_client(
        user_id,
        command=settings.search.ts_sidecar_command,
        index_dir=index_dir_for_owner(user_id),
    )


async def _replace_worker_index(
    user_id: object, db, revision: str | None, *, source_type: str = "knowledge",
    diagnostics: dict[str, object] | None = None,
) -> None:
    """mismatch 回退：worker 侧整来源 replace（不动主数据库，DB 已是最新）。"""
    from agent.rag.index_cache import _persistent_vectors
    from agent.rag.ts_sidecar import TsSidecarUnavailable

    records = await build_source_records(db, user_id, source_type)
    if records is None:
        raise RuntimeError(f"来源未提供 canonical source record：{source_type}")
    documents = await records_to_write_documents(user_id, source_type, records)
    vectors, vector_tag = await _persistent_vectors(user_id, documents, diagnostics)
    client = await _knowledge_client(user_id)
    try:
        await client.replace(documents, revision, vectors=vectors, vector_version=vector_tag)
    except TsSidecarUnavailable:
        await client.close()
        raise


DOCUMENT_PATCH_SOURCE_TYPES = {"knowledge", "file", "project", "calendar", "note", "canvas"}


async def update_knowledge_document(
    user_id: object, source_id: str, *, operation: str = "upsert",
    stats_out: dict[str, object] | None = None,
) -> int:
    """兼容别名：knowledge 文档级增量（PRD-RAG-9 Phase 1 入口）。"""
    return await update_document(
        user_id, "knowledge", source_id, operation=operation, stats_out=stats_out,
    )


async def update_document(
    user_id: object, source_type: str, source_id: str, *, operation: str = "upsert",
    stats_out: dict[str, object] | None = None,
) -> int:
    """文档级增量：只读取/投影/写入发生变化的单个对象（PRD-RAG-9）。

    支持 knowledge/file/project（三者都有稳定的单对象 canonical record）。
    DB 持久索引按 chunk 增量替换；knowledge 额外做向量 upsert/delete；
    TS worker patch 失败时回退来源级 replace（mode 显式记 source_replace）。
    返回该文档当前 chunk 数。
    """
    if source_type not in DOCUMENT_PATCH_SOURCE_TYPES:
        raise ValueError(f"来源不支持文档级增量：{source_type}")
    from agent.rag.delta import compute_chunk_delta
    from agent.rag.ts_sidecar import TsSidecarUnavailable

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
            # DB 侧是父文档作用域 replace：版本推进/收缩的旧行由键集差删除，
            # worker 侧 deletes 只需要消失的 slot（delta 契约）。
            await apply_document_patch(
                db, user_id, source_type, str(source_id), upserts,
            )
            revision = await _owner_revision(db, user_id)
            await db.commit()
            all_documents = await load_index_documents(db, user_id, source_types={source_type})
        if source_type == "knowledge":
            from agent.knowledge.vector_cache import apply_vector_delta

            await apply_vector_delta(user_id, upserts, vector_delete_keys)
        patch_started = time.monotonic()
        status = "ready"
        base_revision_match: bool | None = None
        try:
            from agent.rag.index_cache import _persistent_vectors

            diagnostics: dict[str, object] = {}
            vectors, vector_tag = await _persistent_vectors(user_id, all_documents, diagnostics)
            client = await _knowledge_client(user_id)
            await client.patch(
                upserts, delete_slots, revision,
                getattr(client, "_revision", None),
                vectors=vectors, vector_version=vector_tag,
            )
        except TsSidecarUnavailable as exc:
            if exc.code == "revision_mismatch":
                base_revision_match = False
                try:
                    async with db_session._SessionLocal() as db:
                        await _replace_worker_index(user_id, db, revision, source_type=source_type)
                except TsSidecarUnavailable:
                    status = "worker_unavailable"
            else:
                status = "worker_unavailable"
        if stats_out is not None:
            stats_out.update({
                "patch_ms": int((time.monotonic() - patch_started) * 1000),
                "base_revision_match": base_revision_match,
                "status": status,
            })
        return len(new_documents) if new_documents else len(old_documents) - len(delete_slots)


async def handle_rag_index_event(event) -> bool:
    """处理非 Memory 来源索引事件，失败重试但不阻塞主业务写入。

    knowledge/file/project 事件带 source_id 时走文档级增量；其余保持来源级
    全量重建（无 id 的批量事件、管理端校准）。
    """
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
                status=str(stats.get("status", "ready")),
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
            )
            return False
