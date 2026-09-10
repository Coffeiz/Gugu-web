"""RAG 索引更新的持久任务状态与恢复查询。"""
from __future__ import annotations

from datetime import timedelta
from typing import Optional
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError

from agent.events.types import RagIndexUpdated
from app.core.tz import now_utc
from app.models import RagIndexJob


_LEASE_SECONDS = 600
_RETRY_BASE_SECONDS = 5
_RETRY_MAX_SECONDS = 300
NOT_CLAIMED = -1


def _user_uuid(user_id: object) -> Optional[UUID]:
    try:
        return UUID(str(user_id))
    except (ValueError, TypeError, AttributeError):
        return None


def _session_factory():
    from app.db.session import _SessionLocal

    return _SessionLocal


def _is_ephemeral_sqlite(session_factory) -> bool:
    """测试用单连接内存 SQLite 不具备生产数据库的并发连接语义。"""
    bind = session_factory.kw.get("bind")
    url = getattr(bind, "url", None)
    return bool(
        url is not None
        and url.get_backend_name() == "sqlite"
        and url.database in (None, "", ":memory:")
    )


async def persist_event(event: RagIndexUpdated) -> Optional[int]:
    """合并一条最新事件并返回当前 generation。

    测试和未初始化数据库的轻量进程仍可使用内存事件总线；这类场景返回 None，
    不让持久化旁路阻塞业务写入。
    """
    user_id = _user_uuid(event.user_id)
    session_factory = _session_factory()
    if user_id is None or session_factory is None or _is_ephemeral_sqlite(session_factory):
        return None

    # 两个进程可能同时看到“没有任务”并尝试 INSERT；唯一键冲突后重试一次，
    # 第二次会拿到已存在的行并转为 UPDATE。
    for attempt in range(2):
        try:
            async with session_factory() as db:
                job = (
                    await db.execute(
                        select(RagIndexJob)
                        .where(
                            RagIndexJob.user_id == user_id,
                            RagIndexJob.source_type == str(event.source_type),
                        )
                        .with_for_update()
                    )
                ).scalar_one_or_none()
                now = now_utc()
                if job is None:
                    job = RagIndexJob(
                        user_id=user_id,
                        source_type=str(event.source_type),
                        source_id=str(event.source_id or ""),
                        version=str(event.version or ""),
                        operation=str(event.operation or "upsert"),
                        status="queued",
                        generation=1,
                        next_attempt_at=now,
                    )
                    db.add(job)
                else:
                    job.source_id = str(event.source_id or "")
                    job.version = str(event.version or "")
                    job.operation = str(event.operation or "upsert")
                    job.status = "queued"
                    job.generation = int(job.generation or 0) + 1
                    job.next_attempt_at = now
                    job.lease_until = None
                    job.last_error_code = None
                await db.commit()
                await db.refresh(job)
                return int(job.generation)
        except IntegrityError:
            if attempt == 1:
                raise
    return None


async def mark_running(event: RagIndexUpdated) -> Optional[int]:
    """抢占当前 generation 的租约，并增加尝试次数。"""
    user_id = _user_uuid(event.user_id)
    session_factory = _session_factory()
    if user_id is None or session_factory is None or _is_ephemeral_sqlite(session_factory):
        return None

    async with session_factory() as db:
        job = (
            await db.execute(
                select(RagIndexJob)
                .where(
                    RagIndexJob.user_id == user_id,
                    RagIndexJob.source_type == str(event.source_type),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if job is None:
            return None
        now = now_utc()
        if job.status not in {"queued", "retrying"}:
            if job.status == "running" and job.lease_until and job.lease_until <= now:
                pass
            else:
                return NOT_CLAIMED
        job.status = "running"
        job.attempts = int(job.attempts or 0) + 1
        job.last_started_at = now
        job.lease_until = now + timedelta(seconds=_LEASE_SECONDS)
        job.next_attempt_at = None
        await db.commit()
        return int(job.generation)


async def mark_result(
    event: RagIndexUpdated,
    generation: Optional[int],
    *,
    success: bool,
    error_code: str = "index_update_failed",
) -> Optional[float]:
    """记录结果；若期间已有更新，只保留新 generation 的 queued 状态。"""
    user_id = _user_uuid(event.user_id)
    session_factory = _session_factory()
    if (
        user_id is None
        or session_factory is None
        or generation is None
        or _is_ephemeral_sqlite(session_factory)
    ):
        return None

    async with session_factory() as db:
        job = (
            await db.execute(
                select(RagIndexJob)
                .where(
                    RagIndexJob.user_id == user_id,
                    RagIndexJob.source_type == str(event.source_type),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if job is None or int(job.generation) != int(generation):
            return None
        now = now_utc()
        job.lease_until = None
        if success:
            job.status = "ready"
            job.completed_generation = int(generation)
            job.next_attempt_at = None
            job.last_error_code = None
            job.last_succeeded_at = now
            await db.commit()
            return 0.0

        delay = min(
            _RETRY_MAX_SECONDS,
            _RETRY_BASE_SECONDS * (2 ** max(0, min(int(job.attempts or 1) - 1, 6))),
        )
        job.status = "retrying"
        job.next_attempt_at = now + timedelta(seconds=delay)
        job.last_error_code = error_code
        await db.commit()
        return float(delay)


async def due_events(limit: int = 100) -> list[RagIndexUpdated]:
    """读取到期任务；running 租约过期也视为可恢复。"""
    session_factory = _session_factory()
    if session_factory is None or _is_ephemeral_sqlite(session_factory):
        return []
    now = now_utc()
    async with session_factory() as db:
        rows = (
            await db.execute(
                select(RagIndexJob)
                .where(
                    or_(
                        (
                            RagIndexJob.status.in_(("queued", "retrying"))
                            & (RagIndexJob.next_attempt_at <= now)
                        ),
                        (
                            (RagIndexJob.status == "running")
                            & (RagIndexJob.lease_until <= now)
                        ),
                    )
                )
                .order_by(RagIndexJob.next_attempt_at, RagIndexJob.id)
                .limit(limit)
            )
        ).scalars().all()
        return [
            RagIndexUpdated(
                user_id=row.user_id,
                source_type=row.source_type,
                source_id=row.source_id,
                version=row.version,
                operation=row.operation,
            )
            for row in rows
        ]
