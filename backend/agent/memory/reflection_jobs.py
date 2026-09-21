"""IM 记忆反思任务、群消息游标和闲置收束状态机。"""
from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any, List, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core import redis as R
from app.core.tz import now_utc
from agent.memory import reflection_idle
from agent.memory.scopes import MemoryScope


REFLECTION_STREAM = "memory:reflection"
REFLECTION_GROUP = "memory-reflection-workers"
EXTRACTOR_VERSION = "im-memory-v1"
IDLE_WINDOW = reflection_idle.IDLE_WINDOW
MAX_RETRIES = 5
RETRY_BACKOFF_MINUTES = (1, 5, 30, 120, 360)
GROUP_MESSAGE_THRESHOLD = 50
_LOCAL_SNAPSHOT_TASKS: set[asyncio.Task] = set()


def _scope_filters(model, scope: MemoryScope) -> List[Any]:
    return [
        model.owner_user_id == scope.owner_user_id,
        model.platform == scope.platform,
        model.bot_id == scope.bot_id,
        model.scope_type == scope.scope_type,
        model.scope_id == scope.scope_id,
    ]


def _idempotency_key(scope: MemoryScope, first: int, last: int, task_type: str = "group") -> str:
    return ":".join((scope.prefix, task_type, str(first), str(last), EXTRACTOR_VERSION))


async def _db_session():
    import app.db.session as db_session

    if db_session._engine is None:
        db_session._build_engine()
    return db_session._SessionLocal()


async def enqueue_scope(
    scope: MemoryScope,
    first_message_id: Optional[int],
    last_message_id: Optional[int],
    reason: str,
    *,
    task_type: str = "group",
    defer_dispatch: bool = False,
    now=None,
) -> Optional[int]:
    """创建幂等任务；可暂缓投递，让主会话快照先被同进程分支复用。"""
    if first_message_id is None or last_message_id is None or first_message_id > last_message_id:
        return None
    from agent.memory.scope_lifecycle import is_tombstoned

    if await is_tombstoned(scope):
        return None
    from app.models import MemoryReflectionJob

    now = now or now_utc()
    key = _idempotency_key(scope, first_message_id, last_message_id, task_type)
    next_attempt = now + IDLE_WINDOW if defer_dispatch else now
    async with await _db_session() as db:
        existing = (await db.execute(
            select(MemoryReflectionJob).where(MemoryReflectionJob.idempotency_key == key)
        )).scalars().first()
        if existing is not None:
            if existing.status == "dead":
                existing.status = "pending"
                existing.retry_count = 0
                existing.dead_at = None
                existing.next_attempt_at = next_attempt
                existing.updated_at = now
                await db.commit()
            else:
                if reason == "idle" and existing.status in {"pending", "retry"}:
                    existing.reason = "idle"
                    existing.next_attempt_at = now
                    existing.updated_at = now
                    await db.commit()
                elif defer_dispatch and existing.status in {"pending", "retry"}:
                    existing.next_attempt_at = next_attempt
                    existing.updated_at = now
                    await db.commit()
                elif existing.status in {"pending", "retry"}:
                    existing.next_attempt_at = now
                    existing.updated_at = now
                    await db.commit()
            job_id = existing.id
        else:
            job = MemoryReflectionJob(
                owner_user_id=scope.owner_user_id,
                platform=scope.platform,
                bot_id=scope.bot_id,
                scope_type=scope.scope_type,
                scope_id=scope.scope_id,
                from_message_id=first_message_id,
                to_message_id=last_message_id,
                idempotency_key=key,
                extractor_version=EXTRACTOR_VERSION,
                task_type=task_type,
                reason=reason,
                next_attempt_at=next_attempt,
                created_at=now,
                updated_at=now,
            )
            db.add(job)
            try:
                await db.flush()
                job_id = job.id
                await db.commit()
            except IntegrityError:
                await db.rollback()
                existing_id = (await db.execute(
                    select(MemoryReflectionJob.id).where(
                        MemoryReflectionJob.idempotency_key == key
                    )
                )).scalar_one_or_none()
                if existing_id is None:
                    raise
                job_id = existing_id
    if defer_dispatch:
        return job_id
    await _dispatch_job(job_id)
    return job_id


async def _dispatch_job(job_id: int) -> None:
    try:
        await R.ensure_group(REFLECTION_STREAM, REFLECTION_GROUP)
        await R.produce(REFLECTION_STREAM, {"job_id": job_id}, maxlen=10000)
    except Exception:
        # DB 任务保留 pending，补偿扫描会再次投递。
        return


async def observe_group_message(
    scope: MemoryScope,
    message_id: int,
    message_at,
    *,
    now=None,
    member_batch: bool = True,
) -> Optional[int]:
    """推进群级游标；群级和群友记忆都由群消息累计 50 条触发。"""
    from app.models import MemoryReflectionCursor
    from agent.memory.scope_lifecycle import is_tombstoned

    now = now or now_utc()
    if scope.scope_type != "group":
        return None
    if await is_tombstoned(scope):
        return None
    async with await _db_session() as db:
        cursor = (await db.execute(
            select(MemoryReflectionCursor)
            .where(*_scope_filters(MemoryReflectionCursor, scope))
            .with_for_update()
        )).scalars().first()
        if cursor is None:
            cursor = MemoryReflectionCursor(
                owner_user_id=scope.owner_user_id,
                platform=scope.platform,
                bot_id=scope.bot_id,
                scope_type=scope.scope_type,
                scope_id=scope.scope_id,
                active_started_at=message_at or now,
                last_message_at=message_at or now,
                last_message_id=message_id,
                scope_version=1,
                pending_passive_count=1 if member_batch else 0,
                created_at=now,
                updated_at=now,
            )
            db.add(cursor)
            try:
                await db.commit()
                return None
            except IntegrityError:
                # 并发首条消息可能同时尝试建 cursor；唯一约束胜出后重新
                # 读取并在锁内推进，不丢掉这条消息的窗口状态。
                await db.rollback()
                cursor = (await db.execute(
                    select(MemoryReflectionCursor)
                    .where(*_scope_filters(MemoryReflectionCursor, scope))
                    .with_for_update()
                )).scalars().first()
                if cursor is None:
                    raise

        if cursor.settled_at is not None:
            cursor.settled_at = None
            cursor.active_started_at = message_at or now
        elif cursor.active_started_at is None:
            cursor.active_started_at = message_at or now
        cursor.last_message_id = message_id
        cursor.last_message_at = message_at or now
        cursor.scope_version += 1
        if member_batch:
            cursor.pending_passive_count += 1
        should_threshold = (
            member_batch and cursor.pending_passive_count >= GROUP_MESSAGE_THRESHOLD
        )
        group_first = (cursor.last_reflected_message_id or 0) + 1
        member_first = (cursor.last_member_reflected_message_id or 0) + 1
        last = cursor.last_message_id
        should_group = should_threshold
        if should_group or should_threshold:
            cursor.active_started_at = message_at or now
            if should_threshold:
                cursor.pending_passive_count = 0
            cursor.updated_at = now
            await db.commit()
        else:
            await db.commit()
            return None
    job_ids = []
    if should_group:
        job_id = await enqueue_scope(
            scope, group_first, last, "message-threshold", defer_dispatch=True, now=now,
        )
        if job_id is not None:
            job_ids.append(job_id)
    if should_threshold:
        job_id = await enqueue_scope(
            scope, member_first, last, "message-threshold", task_type="member-batch",
            defer_dispatch=True, now=now,
        )
        if job_id is not None:
            job_ids.append(job_id)
    return job_ids[0] if job_ids else None


async def settle_idle_scopes(*, now=None, limit: int = 100) -> int:
    """扫描 3 分钟无新消息且未收束的 scope，每轮只投递一次。"""
    from app.models import MemoryReflectionCursor

    now = now or now_utc()
    cutoff = reflection_idle.idle_cutoff(now)
    async with await _db_session() as db:
        rows = (await db.execute(
            select(MemoryReflectionCursor)
            .where(
                MemoryReflectionCursor.last_message_at <= cutoff,
                MemoryReflectionCursor.settled_at.is_(None),
            )
            .order_by(MemoryReflectionCursor.last_message_at)
            .limit(limit)
        )).scalars().all()
        pending = []
        for cursor in rows:
            scope = MemoryScope(
                cursor.owner_user_id, cursor.platform, cursor.bot_id,
                cursor.scope_type, cursor.scope_id,
            )
            pending.append((scope, cursor, cursor.id))
        await db.commit()
    settled = 0
    for scope, cursor, cursor_id in pending:
        last = cursor.last_message_id
        jobs = []
        group_first = (cursor.last_reflected_message_id or 0) + 1
        member_first = (cursor.last_member_reflected_message_id or 0) + 1
        try:
            if scope.scope_type == "group":
                if group_first <= last:
                    jobs.append(await enqueue_scope(scope, group_first, last, "idle", now=now))
                if member_first <= last:
                    jobs.append(await enqueue_scope(
                        scope, member_first, last, "idle", task_type="member-batch", now=now,
                    ))
            elif scope.scope_type == "platform-user" and group_first <= last:
                jobs.append(await enqueue_scope(
                    scope, group_first, last, "idle", task_type="private-owner", now=now,
                ))
        except Exception:
            continue
        if not any(job_id is not None for job_id in jobs):
            continue
        async with await _db_session() as db:
            cursor = await db.get(MemoryReflectionCursor, cursor_id)
            if cursor and cursor.last_message_id == last and cursor.settled_at is None:
                cursor.settled_at = now
                if scope.scope_type == "group":
                    cursor.pending_passive_count = 0
                elif scope.scope_type == "platform-user":
                    cursor.pending_agent_count = 0
                cursor.updated_at = now
                await db.commit()
                settled += 1
    return settled


async def requeue_due_jobs(*, now=None, limit: int = 100) -> int:
    """补偿已到重试时间的任务，并回收长时间失联的 running 任务。"""
    from app.models import MemoryReflectionJob

    now = now or now_utc()
    stale_at = now - timedelta(minutes=30)
    async with await _db_session() as db:
        rows = (await db.execute(
            select(MemoryReflectionJob)
            .where(
                (
                    (MemoryReflectionJob.status.in_(("pending", "retry")))
                    & (
                        MemoryReflectionJob.next_attempt_at.is_(None)
                        | (MemoryReflectionJob.next_attempt_at <= now)
                    )
                )
                | (
                    (MemoryReflectionJob.status == "running")
                    & (MemoryReflectionJob.locked_at <= stale_at)
                )
            )
            .order_by(MemoryReflectionJob.updated_at)
            .limit(limit)
        )).scalars().all()
        for job in rows:
            job.status = "pending"
            job.locked_at = None
            job.next_attempt_at = now
            job.updated_at = now
        await db.commit()
        ids = [job.id for job in rows]
    count = 0
    for job_id in ids:
        try:
            await R.ensure_group(REFLECTION_STREAM, REFLECTION_GROUP)
            await R.produce(REFLECTION_STREAM, {"job_id": job_id}, maxlen=10000)
            count += 1
        except Exception:
            continue
    return count


async def observe_session_activity(
    scope: MemoryScope,
    session_id: int,
    *,
    now=None,
    member_batch: bool = False,
) -> Optional[int]:
    """从已完成的 IM 会话读取最新消息，推进群记忆窗口。"""
    from app.models import ConversationMessage

    now = now or now_utc()
    async with await _db_session() as db:
        message = (await db.execute(
            select(ConversationMessage)
            .where(
                ConversationMessage.session_id == session_id,
                ConversationMessage.role == "user",
                ConversationMessage.platform_user_id.is_not(None),
            )
            .order_by(ConversationMessage.id.desc())
            .limit(1)
        )).scalars().first()
    if message is None:
        return None
    job_id = await observe_group_message(
        scope, message.id, message.created_at or now, now=now, member_batch=member_batch,
    )
    await _schedule_scope_jobs_with_snapshot(scope, session_id)
    return job_id


async def _schedule_scope_jobs_with_snapshot(scope: MemoryScope, session_id: int) -> int:
    """在主会话进程用刚完成的真实快照处理同 session 的待运行 IM 反思。"""
    from app.models import MemoryReflectionJob

    from agent.context.reflection_snapshot import peek_reflection_snapshot

    snapshot = peek_reflection_snapshot(scope.owner_user_id, session_id)
    if snapshot is None:
        return 0
    async with await _db_session() as db:
        jobs = (await db.execute(
            select(MemoryReflectionJob).where(
                *_scope_filters(MemoryReflectionJob, scope),
                MemoryReflectionJob.status == "pending",
            ).order_by(MemoryReflectionJob.id)
        )).scalars().all()
        from agent.memory.im_reflection import _messages_for_job

        job_ids = []
        for job in jobs:
            messages = await _messages_for_job(db, job)
            if messages and all(int(message.session_id) == int(session_id) for message in messages):
                job_ids.append(job.id)
    if not job_ids:
        return 0

    from app.core.config import get_settings
    from agent.memory.im_reflection import execute_job

    settings = get_settings()

    async def run_snapshot_jobs() -> None:
        for job_id in job_ids:
            try:
                await execute_job(job_id, settings, snapshot=snapshot)
            except Exception as exc:
                from app.core.redaction import diag_log
                diag_log("agent.memory.im_reflection.snapshot_job", exc)

    task = asyncio.create_task(run_snapshot_jobs())
    _LOCAL_SNAPSHOT_TASKS.add(task)
    task.add_done_callback(_LOCAL_SNAPSHOT_TASKS.discard)
    return len(job_ids)


async def observe_private_member_activity(
    scope: MemoryScope,
    session_id: int,
    platform_user_id: str,
    *,
    now=None,
    force: bool = False,
) -> Optional[int]:
    """按网页/私聊共享阈值累计私聊 Agent 回合，写入隔离的 platform-user scope。"""
    from app.models import MemoryReflectionCursor, ConversationMessage
    from app.core.config import get_settings

    if scope.scope_type != "platform-user":
        return None
    now = now or now_utc()
    threshold = max(1, min(100, int(get_settings().agent.web_private_reflection_threshold)))
    from agent.context.reflection_snapshot import peek_reflection_snapshot

    snapshot = peek_reflection_snapshot(scope.owner_user_id, session_id)
    async with await _db_session() as db:
        message = (await db.execute(
            select(ConversationMessage)
            .where(
                ConversationMessage.session_id == session_id,
                ConversationMessage.role == "user",
                ConversationMessage.platform_user_id == platform_user_id,
            )
            .order_by(ConversationMessage.id.desc())
            .limit(1)
        )).scalars().first()
        if message is None:
            return None
        cursor = (await db.execute(
            select(MemoryReflectionCursor)
            .where(*_scope_filters(MemoryReflectionCursor, scope))
            .with_for_update()
        )).scalars().first()
        if cursor is None:
            cursor = MemoryReflectionCursor(
                owner_user_id=scope.owner_user_id,
                platform=scope.platform,
                bot_id=scope.bot_id,
                scope_type=scope.scope_type,
                scope_id=scope.scope_id,
                active_started_at=message.created_at or now,
                last_message_at=message.created_at or now,
                last_message_id=message.id,
                pending_agent_count=1,
                scope_version=1,
                created_at=now,
                updated_at=now,
            )
            db.add(cursor)
            await db.flush()
        else:
            cursor.pending_agent_count += 1
            cursor.last_message_id = message.id
            cursor.last_message_at = message.created_at or now
            cursor.scope_version += 1
            cursor.active_started_at = message.created_at or now
            cursor.settled_at = None
        first = (cursor.last_reflected_message_id or 0) + 1
        last = cursor.last_message_id
        should_reflect = cursor.pending_agent_count >= threshold
        if should_reflect:
            # 预留本批轮数；若后续任务入队失败，idle 扫描仍会按反思游标补齐消息范围。
            cursor.pending_agent_count -= threshold
        await db.commit()
    if not should_reflect:
        return None
    job_id = await enqueue_scope(
        scope, first, last, "message-threshold" if not force else "tool",
        task_type="private-owner", defer_dispatch=True, now=now,
    )
    if job_id is not None and snapshot is not None:
        await _schedule_scope_jobs_with_snapshot(scope, session_id)
    return job_id
