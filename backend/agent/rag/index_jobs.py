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


def _merge_pending_ids(existing: Optional[list], source_id: str) -> list[str]:
    """同源待处理文档 ID 并集（保持插入顺序、去重）；空 ID 表示来源级事件。"""
    merged = [str(item) for item in (existing or []) if str(item)]
    if source_id and source_id not in merged:
        merged.append(source_id)
    return merged


async def persist_event(event: RagIndexUpdated) -> Optional[int]:
    """合并一条最新事件并返回当前 generation。

    文档级事件（带 source_id）把 ID 并入 pending_source_ids——同源多文档
    合并只去重、不丢文档（PRD-RAG-9 §5.2）；来源级事件（无 source_id）
    清空集合，语义为全量重建。测试和未初始化数据库的轻量进程仍可使用
    内存事件总线；这类场景返回 None，不让持久化旁路阻塞业务写入。
    """
    user_id = _user_uuid(event.user_id)
    session_factory = _session_factory()
    if user_id is None or session_factory is None or _is_ephemeral_sqlite(session_factory):
        return None

    source_id = str(event.source_id or "").strip()
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
                        source_id=source_id,
                        pending_source_ids=[source_id] if source_id else [],
                        version=str(event.version or ""),
                        operation=str(event.operation or "upsert"),
                        status="queued",
                        generation=1,
                        next_attempt_at=now,
                    )
                    db.add(job)
                else:
                    job.source_id = source_id
                    if source_id:
                        job.pending_source_ids = _merge_pending_ids(
                            job.pending_source_ids, source_id,
                        )
                    else:
                        job.pending_source_ids = []
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
            # 该文档已成功入索引，从待处理集合移除；来源级事件（空 ID）成功
            # 即全量收敛，清空整个集合。失败时保留集合供到期重放。
            completed_id = str(event.source_id or "").strip()
            pending_ids = [str(item) for item in (job.pending_source_ids or []) if str(item)]
            if completed_id:
                job.pending_source_ids = [i for i in pending_ids if i != completed_id]
            else:
                job.pending_source_ids = []
            job.completed_generation = int(generation)
            if job.pending_source_ids:
                # 同源还有待重放文档：保持 queued 让恢复循环继续逐 ID 收敛，
                # 不能置 ready（ready 行不会被 due_events 捞起，剩余 ID 会卡死）。
                job.status = "queued"
                job.next_attempt_at = now
            else:
                job.status = "ready"
                job.next_attempt_at = None
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
    """读取到期任务；running 租约过期也视为可恢复。

    pending_source_ids 非空时按 ID 逐条展开成文档级事件（操作统一为
    upsert：最终动作由当前主数据决定，对象已删时投影返回空、按 delete
    收敛，见 PRD-RAG-9 §5.2 规则 4）；重放成功后由 mark_result 逐 ID 移除。
    """
    session_factory = _session_factory()
    if session_factory is None or _is_ephemeral_sqlite(session_factory):
        return []
    now = now_utc()
    events: list[RagIndexUpdated] = []
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
        for row in rows:
            pending_ids = [str(item) for item in (row.pending_source_ids or []) if str(item)]
            if pending_ids:
                events.extend(
                    RagIndexUpdated(
                        user_id=row.user_id,
                        source_type=row.source_type,
                        source_id=source_id,
                        version=row.version,
                        operation="upsert",
                        replayed=True,
                    )
                    for source_id in pending_ids
                )
            else:
                events.append(
                    RagIndexUpdated(
                        user_id=row.user_id,
                        source_type=row.source_type,
                        source_id=row.source_id,
                        version=row.version,
                        operation=row.operation,
                        replayed=True,
                    )
                )
    return events
