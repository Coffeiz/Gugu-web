"""统一知识索引的数据库持久化存储。"""
from __future__ import annotations

from datetime import datetime
import time

from sqlalchemy import delete, select, update

from agent.rag.models import IndexDocument, Scope
from app.models import KnowledgeIndexEntry
from app.core.tz import now_utc
from agent.rag.models import RecallResult


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _to_row(document: IndexDocument, owner_user_id: object) -> KnowledgeIndexEntry:
    return KnowledgeIndexEntry(
        owner_user_id=owner_user_id,
        source_type=document.source_type,
        source_id=document.source_id,
        scope_type=document.scope.scope_type,
        scope_id=document.scope.scope_id or "",
        platform=document.scope.platform or "",
        bot_id=document.scope.bot_id or "",
        group_id=document.scope.group_id or "",
        document_id=document.document_id,
        parent_document_id=document.parent_document_id,
        document_version=document.version,
        chunk_index=document.chunk_index,
        chunk_count=document.chunk_count,
        title=document.title,
        summary=document.summary,
        content=document.content,
        content_hash=document.content_hash,
        metadata_json=document.metadata,
        source_updated_at=_parse_datetime(document.updated_at),
    )


def _from_row(row: KnowledgeIndexEntry) -> IndexDocument:
    updated_at = row.source_updated_at.isoformat() if row.source_updated_at else None
    return IndexDocument(
        document_id=row.document_id,
        source_type=row.source_type,
        source_id=row.source_id,
        scope=Scope(
            owner_user_id=str(row.owner_user_id),
            platform=row.platform or "",
            bot_id=row.bot_id or "",
            group_id=row.group_id or "",
            scope_type=row.scope_type or "owner",
            scope_id=row.scope_id or "",
        ),
        title=row.title or "",
        summary=row.summary or "",
        content=row.content or "",
        version=row.document_version,
        chunk_index=row.chunk_index,
        chunk_count=row.chunk_count,
        parent_document_id=row.parent_document_id,
        updated_at=updated_at,
        metadata=row.metadata_json if isinstance(row.metadata_json, dict) else {},
    )


async def replace_source_documents(
    db,
    owner_user_id: object,
    source_type: str,
    documents: list[IndexDocument],
    *,
    stats: dict[str, int] | None = None,
) -> int:
    """按 chunk 增量替换一个来源，主数据不受影响。

    ``stats`` 传出诊断计数（inserted/updated/deleted），返回值保持来源 chunk 总数。
    """
    import time as _time
    _started = _time.monotonic()
    rows = (await db.execute(select(KnowledgeIndexEntry).where(
        KnowledgeIndexEntry.owner_user_id == owner_user_id,
        KnowledgeIndexEntry.source_type == source_type,
    ))).scalars().all()
    existing = {
        (row.source_id, row.document_version, row.chunk_index): row
        for row in rows
    }
    inserted = 0
    wanted: set[tuple[str, str, int]] = set()
    for document in documents:
        key = (document.source_id, document.version, document.chunk_index)
        wanted.add(key)
        row = existing.get(key)
        if row is None:
            db.add(_to_row(document, owner_user_id))
            inserted += 1
            continue
        replacement = _to_row(document, owner_user_id)
        for column in (
            "scope_type", "scope_id", "platform", "bot_id", "group_id", "document_id",
            "parent_document_id", "chunk_count", "title", "summary", "content",
            "content_hash", "metadata_json", "source_updated_at",
        ):
            setattr(row, column, getattr(replacement, column))
        row.deleted_at = None
        row.indexed_at = now_utc()
    stale = [row for key, row in existing.items() if key not in wanted]
    for row in stale:
        await db.delete(row)
    await db.flush()
    if stats is not None:
        stats["inserted"] = inserted
        stats["updated"] = len(documents) - inserted
        stats["deleted"] = len(stale)
        stats["elapsed_ms"] = int((_time.monotonic() - _started) * 1000)
    # 本进程立即失效；其他 worker 会在下一次查询时用 indexed_at revision 检测。
    from agent.rag.index_cache import invalidate_index_cache
    await invalidate_index_cache(owner_user_id, source_type)
    return len(documents)


async def load_parent_documents(
    db, owner_user_id: object, source_type: str, source_id: str,
) -> list[IndexDocument]:
    """读取一个父文档（单 source_id）的全部持久 chunk（文档级增量入口）。"""
    rows = (await db.execute(select(KnowledgeIndexEntry).where(
        KnowledgeIndexEntry.owner_user_id == owner_user_id,
        KnowledgeIndexEntry.source_type == source_type,
        KnowledgeIndexEntry.parent_document_id == str(source_id),
        KnowledgeIndexEntry.deleted_at.is_(None),
    ).order_by(KnowledgeIndexEntry.chunk_index.asc()))).scalars().all()
    return [_from_row(row) for row in rows]


async def apply_document_patch(
    db,
    owner_user_id: object,
    source_type: str,
    source_id: str,
    upserts: list[IndexDocument],
) -> dict[str, int]:
    """把单父文档的最新 chunk 集写入持久索引；只触碰该文档的行。

    语义是「父文档作用域 replace」：该 parent 下不属于 upsert 键集的行一律
    删除——主数据版本推进、chunk 收缩、正文改写都不会残留旧 chunk。
    写完后把该来源全部行的 indexed_at 推进到同一时刻：owner revision 取
    max(indexed_at)，纯删除时若不推进，查询侧会误判 worker 仍是最新的。
    返回 inserted/updated/deleted 计数。
    """
    import time as _time

    started = _time.monotonic()
    stamp = now_utc()
    rows = (await db.execute(select(KnowledgeIndexEntry).where(
        KnowledgeIndexEntry.owner_user_id == owner_user_id,
        KnowledgeIndexEntry.source_type == source_type,
        KnowledgeIndexEntry.parent_document_id == str(source_id),
    ))).scalars().all()
    existing = {(row.source_id, row.document_version, row.chunk_index): row for row in rows}
    wanted: set[tuple[str, str, int]] = set()
    inserted = 0
    updated = 0
    for document in upserts:
        key = (document.source_id, document.version, document.chunk_index)
        wanted.add(key)
        row = existing.get(key)
        if row is None:
            db.add(_to_row(document, owner_user_id))
            inserted += 1
            continue
        replacement = _to_row(document, owner_user_id)
        for column in (
            "scope_type", "scope_id", "platform", "bot_id", "group_id", "document_id",
            "parent_document_id", "chunk_count", "title", "summary", "content",
            "content_hash", "metadata_json", "source_updated_at",
        ):
            setattr(row, column, getattr(replacement, column))
        row.deleted_at = None
        row.indexed_at = stamp
        updated += 1
    deleted = 0
    for key, row in existing.items():
        if key not in wanted:
            await db.delete(row)
            deleted += 1
    # owner revision 取该来源 max(indexed_at)；纯删除时没有任何行推进时间戳，
    # 显式整来源 bump，保证查询侧能检测到变化。
    await db.execute(
        update(KnowledgeIndexEntry)
        .where(
            KnowledgeIndexEntry.owner_user_id == owner_user_id,
            KnowledgeIndexEntry.source_type == source_type,
        )
        .values(indexed_at=stamp)
    )
    await db.flush()
    from agent.rag.index_cache import invalidate_index_cache
    await invalidate_index_cache(owner_user_id, source_type)
    return {
        "inserted": inserted, "updated": updated, "deleted": deleted,
        "elapsed_ms": int((_time.monotonic() - started) * 1000),
    }


async def load_index_documents(
    db,
    owner_user_id: object,
    *,
    source_types: set[str] | None = None,
) -> list[IndexDocument]:
    """按 owner 读取索引；scope 过滤仍由召回层继续执行。"""
    query = select(KnowledgeIndexEntry).where(
        KnowledgeIndexEntry.owner_user_id == owner_user_id,
        KnowledgeIndexEntry.deleted_at.is_(None),
    ).order_by(KnowledgeIndexEntry.id.asc())
    if source_types:
        query = query.where(KnowledgeIndexEntry.source_type.in_(source_types))
    rows = (await db.execute(query)).scalars().all()
    return [_from_row(row) for row in rows]


async def count_index_entries(db, owner_user_id: object) -> dict[str, int]:
    """只返回数量诊断，不返回正文。"""
    rows = (await db.execute(
        select(KnowledgeIndexEntry.source_type).where(
            KnowledgeIndexEntry.owner_user_id == owner_user_id,
            KnowledgeIndexEntry.deleted_at.is_(None),
        )
    )).scalars().all()
    counts: dict[str, int] = {}
    for source_type in rows:
        counts[source_type] = counts.get(source_type, 0) + 1
    return counts


async def search_persistent_index(
    db,
    owner_user_id: object,
    query: str,
    *,
    source_types: set[str] | None = None,
    scope: Scope | list[Scope] | tuple[Scope, ...] | None = None,
    limit: int = 10,
    diagnostics: dict[str, object] | None = None,
) -> list[RecallResult]:
    """在统一 lexical index 上查询持久化 chunk；权限先由 owner 收窄。"""
    requested_limit = max(1, min(int(limit), 50))
    types = sorted(source_types or {
        "memory", "knowledge", "project", "file", "note", "canvas", "calendar", "scheduled_task", "conversation",
    })
    from agent.rag.index_cache import get_index_cache
    from agent.rag.context import get_snapshot_revision

    results = []
    cache_hits: list[bool] = []
    cache_miss_reasons: set[str] = set()
    engines: set[str] = set()
    index_diagnostics: dict[str, object] = {}
    from agent.rag.observation import progress
    for name in types:
        progress(name, "index_lookup")
    lookup_started = time.monotonic()
    index = await get_index_cache().get(
        db, owner_user_id, "all", scope, diagnostics=index_diagnostics,
        baseline_revision=get_snapshot_revision() or None,
    )
    index_lookup_ms = int((time.monotonic() - lookup_started) * 1000)
    if index_diagnostics.get("engine"):
        engines.add(str(index_diagnostics["engine"]))
    if "cache_hit" in index_diagnostics:
        cache_hits.append(bool(index_diagnostics["cache_hit"]))
    reason = index_diagnostics.get("cache_miss_reason")
    if reason:
        cache_miss_reasons.add(str(reason))
    scopes = list(scope) if isinstance(scope, (list, tuple)) else [scope]
    for name in types:
        progress(name, "sidecar_search", index_lookup_ms=index_lookup_ms)
    started = time.monotonic()
    timings = []
    for query_scope in scopes:
        if hasattr(index, "search_with_timing"):
            searched, timing = await index.search_with_timing(
                query, limit=requested_limit, source_types=set(types), scope=query_scope,
            )
        else:
            searched = await index.search(
                query, limit=requested_limit, source_types=set(types), scope=query_scope,
            )
            timing = None
        results.extend(searched)
        if timing is not None:
            timings.append(timing)
    deduplicated = {}
    for result in results:
        deduplicated[result.document.chunk_id] = result
    results = list(deduplicated.values())
    results.sort(key=lambda item: (-item.score, item.document.chunk_id))
    sidecar_search_ms = int((time.monotonic() - started) * 1000)
    if diagnostics is not None:
        for name in types:
            progress(name, "document_count", sidecar_search_ms=sidecar_search_ms)
        counts = await count_index_entries(db, owner_user_id)
        diagnostics["document_count"] = sum(counts.get(source_type, 0) for source_type in types)
        diagnostics["engine"] = next(iter(engines)) if len(engines) == 1 else "mixed"
        diagnostics["cache_hit"] = bool(cache_hits) and all(cache_hits)
        diagnostics["cache_entries"] = len(cache_hits)
        if index_diagnostics.get("shared_index"):
            diagnostics["shared_index"] = True
        diagnostics["cache_miss_reasons"] = ",".join(sorted(cache_miss_reasons))
        diagnostics["cache_miss_reason"] = ",".join(sorted(cache_miss_reasons))
        diagnostics["index_lookup_ms"] = index_lookup_ms
        diagnostics["sidecar_search_ms"] = sidecar_search_ms
        diagnostics["sidecar_queue_wait_ms"] = sum(
            int(getattr(timing, "queue_wait_ms", 0) or 0) for timing in timings
        )
        diagnostics["sidecar_query_ms"] = sum(
            int(getattr(timing, "query_ms", 0) or 0) for timing in timings
        )
        diagnostics["search_ms"] = sidecar_search_ms
        for key in ("index_build_ms", "sidecar_reused", "index_sync", "upsert_count", "delete_count"):
            if key in index_diagnostics:
                diagnostics[key] = index_diagnostics[key]
    return results[:requested_limit]


__all__ = [
    "apply_document_patch",
    "count_index_entries",
    "load_index_documents",
    "load_parent_documents",
    "replace_source_documents",
    "search_persistent_index",
]
