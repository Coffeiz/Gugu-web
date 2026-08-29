"""IM 记忆 scope 的删除屏障、异步清理和只读管理查询。"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import delete, select

from app.core import redis as R
from app.core.tz import now_utc
from agent.memory.scoped_store import read_scope
from agent.memory.scopes import MemoryScope


CLEANUP_STREAM = "memory:cleanup"
CLEANUP_GROUP = "memory-cleanup-workers"


def _filters(model, scope: MemoryScope) -> List[Any]:
    return [
        model.owner_user_id == scope.owner_user_id,
        model.platform == scope.platform,
        model.bot_id == scope.bot_id,
        model.scope_type == scope.scope_type,
        model.scope_id == scope.scope_id,
    ]


async def _db_session():
    import app.db.session as db_session

    if db_session._engine is None:
        db_session._build_engine()
    return db_session._SessionLocal()


async def is_tombstoned(scope: MemoryScope) -> bool:
    from app.models import MemoryScopeTombstone

    async with await _db_session() as db:
        row = (await db.execute(
            select(MemoryScopeTombstone.id).where(*_filters(MemoryScopeTombstone, scope))
        )).scalar_one_or_none()
        return row is not None


async def request_scope_deletion(scope: MemoryScope, reason: str = "admin") -> int:
    """写入 tombstone 并投递清理任务；重复请求保持幂等。"""
    from app.models import MemoryScopeTombstone

    now = now_utc()
    async with await _db_session() as db:
        row = (await db.execute(
            select(MemoryScopeTombstone).where(*_filters(MemoryScopeTombstone, scope))
        )).scalars().first()
        if row is None:
            row = MemoryScopeTombstone(
                owner_user_id=scope.owner_user_id,
                platform=scope.platform,
                bot_id=scope.bot_id,
                scope_type=scope.scope_type,
                scope_id=scope.scope_id,
                status="pending",
                reason=reason[:100],
                created_at=now,
                updated_at=now,
            )
            db.add(row)
            await db.flush()
        elif row.status == "completed":
            return row.id
        row.status = "pending"
        row.updated_at = now
        tombstone_id = row.id
        await db.commit()
    await R.ensure_group(CLEANUP_STREAM, CLEANUP_GROUP)
    await R.produce(CLEANUP_STREAM, {"tombstone_id": tombstone_id}, maxlen=10000)
    return tombstone_id


async def requeue_pending_cleanups(limit: int = 100) -> int:
    from app.models import MemoryScopeTombstone

    async with await _db_session() as db:
        rows = (await db.execute(
            select(MemoryScopeTombstone.id)
            .where(MemoryScopeTombstone.status.in_(("pending", "failed")))
            .order_by(MemoryScopeTombstone.updated_at)
            .limit(limit)
        )).scalars().all()
    if not rows:
        return 0
    await R.ensure_group(CLEANUP_STREAM, CLEANUP_GROUP)
    count = 0
    for tombstone_id in rows:
        try:
            await R.produce(CLEANUP_STREAM, {"tombstone_id": tombstone_id}, maxlen=10000)
            count += 1
        except Exception:
            continue
    return count


async def execute_scope_deletion(tombstone_id: int) -> bool:
    """清理存储和来源索引；成功后移除 tombstone，允许未来重新建 scope。"""
    lock = R.get_redis().lock(
        f"memory:cleanup:lock:{tombstone_id}", timeout=1800, blocking=False
    )
    if not await lock.acquire(blocking=False):
        return False
    try:
        return await _execute_scope_deletion_locked(tombstone_id)
    finally:
        try:
            await lock.release()
        except Exception:
            pass


async def _execute_scope_deletion_locked(tombstone_id: int) -> bool:
    """在清理锁内执行存储和数据库级联删除。"""
    from app.models import (
        MemoryEntry,
        MemoryReflectionCursor,
        MemoryReflectionJob,
        MemoryScopeTombstone,
    )

    async with await _db_session() as db:
        tombstone = await db.get(MemoryScopeTombstone, tombstone_id)
        if tombstone is None:
            return False
        scope = MemoryScope(
            tombstone.owner_user_id,
            tombstone.platform,
            tombstone.bot_id,
            tombstone.scope_type,
            tombstone.scope_id,
        )
    scope_lock = R.get_redis().lock(scope.lock_key, timeout=1800, blocking=False)
    if not await scope_lock.acquire(blocking=False):
        return False
    try:
        async with await _db_session() as db:
            tombstone = await db.get(MemoryScopeTombstone, tombstone_id)
            if tombstone is None:
                return False
            tombstone.status = "running"
            tombstone.updated_at = now_utc()
            await db.commit()
        from app.services.storage import get_storage

        await get_storage().delete_prefix(scope.prefix + "/")
        async with await _db_session() as db:
            await db.execute(delete(MemoryReflectionJob).where(*_filters(MemoryReflectionJob, scope)))
            await db.execute(delete(MemoryReflectionCursor).where(*_filters(MemoryReflectionCursor, scope)))
            await db.execute(delete(MemoryEntry).where(*_filters(MemoryEntry, scope)))
            tombstone = await db.get(MemoryScopeTombstone, tombstone_id)
            if tombstone:
                await db.delete(tombstone)
            await db.commit()
        return True
    except Exception:
        async with await _db_session() as db:
            tombstone = await db.get(MemoryScopeTombstone, tombstone_id)
            if tombstone:
                tombstone.status = "failed"
                tombstone.updated_at = now_utc()
                await db.commit()
        return False
    finally:
        try:
            await scope_lock.release()
        except Exception:
            pass


async def list_scopes(limit: int = 200) -> List[Dict[str, object]]:
    """返回管理面板需要的 scope 摘要，不返回消息正文。"""
    from app.models import MemoryEntry, MemoryReflectionCursor, MemoryReflectionJob, MemoryScopeTombstone

    async with await _db_session() as db:
        cursors = (await db.execute(
            select(MemoryReflectionCursor).order_by(MemoryReflectionCursor.updated_at.desc()).limit(limit)
        )).scalars().all()
        tombstones = (await db.execute(select(MemoryScopeTombstone))).scalars().all()
        entries = (await db.execute(select(MemoryEntry))).scalars().all()
        jobs = (await db.execute(
            select(MemoryReflectionJob).order_by(MemoryReflectionJob.updated_at.desc())
        )).scalars().all()
    tombstone_keys = {
        (str(row.owner_user_id), row.platform, row.bot_id, row.scope_type, row.scope_id): row.status
        for row in tombstones
    }
    entry_counts: Dict[Tuple[str, str, str, str, str], int] = {}
    for row in entries:
        key = (str(row.owner_user_id), row.platform, row.bot_id, row.scope_type, row.scope_id)
        entry_counts[key] = entry_counts.get(key, 0) + 1
    job_stats: Dict[Tuple[str, str, str, str, str], Dict[str, object]] = {}
    for job in jobs:
        key = (str(job.owner_user_id), job.platform, job.bot_id, job.scope_type, job.scope_id)
        stat = job_stats.setdefault(key, {"pending": 0, "failed": 0, "last_status": None, "last_error_code": None})
        if job.status in {"pending", "retry", "running"}:
            stat["pending"] = int(stat["pending"]) + 1
        if job.status in {"dead", "failed"}:
            stat["failed"] = int(stat["failed"]) + 1
        if stat["last_status"] is None:
            stat["last_status"] = job.status
            stat["last_error_code"] = job.last_error_code
    result = []
    cursor_keys = set()
    for row in cursors:
        key = (str(row.owner_user_id), row.platform, row.bot_id, row.scope_type, row.scope_id)
        cursor_keys.add(key)
        job_stat = job_stats.get(key, {})
        result.append({
            "owner_user_id": str(row.owner_user_id),
            "platform": row.platform,
            "bot_id": row.bot_id,
            "scope_type": row.scope_type,
            "scope_id": row.scope_id,
            "last_message_id": row.last_message_id,
            "last_reflected_message_id": row.last_reflected_message_id,
            "settled": row.settled_at is not None,
            "entry_count": entry_counts.get(key, 0),
            "tombstone": tombstone_keys.get(key),
            "pending_jobs": job_stat.get("pending", 0),
            "failed_jobs": job_stat.get("failed", 0),
            "last_job_status": job_stat.get("last_status"),
            "last_job_error_code": job_stat.get("last_error_code"),
        })
    # 删除屏障可能先于 cursor 创建，管理面板仍需能看到 pending/running scope。
    for key, status in tombstone_keys.items():
        if key in cursor_keys:
            continue
        owner_user_id, platform, bot_id, scope_type, scope_id = key
        job_stat = job_stats.get(key, {})
        result.append({
            "owner_user_id": owner_user_id,
            "platform": platform,
            "bot_id": bot_id,
            "scope_type": scope_type,
            "scope_id": scope_id,
            "last_message_id": None,
            "last_reflected_message_id": None,
            "settled": False,
            "entry_count": entry_counts.get(key, 0),
            "tombstone": status,
            "pending_jobs": job_stat.get("pending", 0),
            "failed_jobs": job_stat.get("failed", 0),
            "last_job_status": job_stat.get("last_status"),
            "last_job_error_code": job_stat.get("last_error_code"),
        })
    result.sort(key=lambda row: (row["tombstone"] is None, row["platform"], row["scope_id"]))
    return result[:limit]


async def preview_scope(scope: MemoryScope) -> Optional[dict]:
    if await is_tombstoned(scope):
        return None
    return await read_scope(scope)
