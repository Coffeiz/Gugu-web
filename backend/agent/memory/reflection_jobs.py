"""IM 记忆反思任务、游标和活跃窗口状态机。"""
from __future__ import annotations

from datetime import timedelta
from typing import Any, List, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core import redis as R
from app.core.tz import now_utc
from agent.memory.scopes import MemoryScope


REFLECTION_STREAM = "memory:reflection"
REFLECTION_GROUP = "memory-reflection-workers"
EXTRACTOR_VERSION = "im-memory-v1"
ACTIVE_WINDOW = timedelta(hours=1)
IDLE_WINDOW = timedelta(minutes=15)
MAX_RETRIES = 5
RETRY_BACKOFF_MINUTES = (1, 5, 30, 120, 360)
GROUP_MESSAGE_THRESHOLD = 50


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
    now=None,
) -> Optional[int]:
    """创建一个幂等反思任务并投递 Stream；没有新消息时不创建任务。"""
    if first_message_id is None or last_message_id is None or first_message_id > last_message_id:
        return None
    from agent.memory.scope_lifecycle import is_tombstoned

    if await is_tombstoned(scope):
        return None
    from app.models import MemoryReflectionJob

    now = now or now_utc()
    key = _idempotency_key(scope, first_message_id, last_message_id, task_type)
    async with await _db_session() as db:
        existing = (await db.execute(
            select(MemoryReflectionJob).where(MemoryReflectionJob.idempotency_key == key)
        )).scalars().first()
        if existing is not None:
            if existing.status == "dead":
                existing.status = "pending"
                existing.retry_count = 0
                existing.dead_at = None
                existing.next_attempt_at = now
                existing.updated_at = now
                await db.commit()
            return existing.id
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
            next_attempt_at=now,
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
            existing = (await db.execute(
                select(MemoryReflectionJob.id).where(
                    MemoryReflectionJob.idempotency_key == key
                )
            )).scalar_one_or_none()
            if existing is None:
                raise
            job_id = existing
    try:
        await R.ensure_group(REFLECTION_STREAM, REFLECTION_GROUP)
        await R.produce(REFLECTION_STREAM, {"job_id": job_id}, maxlen=10000)
    except Exception:
        # DB 任务保留 pending，补偿扫描会再次投递；不让 Redis 瞬时故障丢记忆任务。
        return job_id
    return job_id


async def observe_group_message(
    scope: MemoryScope,
    message_id: int,
    message_at,
    *,
    now=None,
    trigger_mode: str = "passive",
    force: bool = False,
    member_batch: bool = True,
) -> Optional[int]:
    """推进群级游标；成员记忆由群消息累计 50 条触发批量任务。"""
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
        should_hourly = bool(
            cursor.active_started_at and now - cursor.active_started_at >= ACTIVE_WINDOW
        )
        should_threshold = (
            member_batch and cursor.pending_passive_count >= GROUP_MESSAGE_THRESHOLD
        )
        group_first = (cursor.last_reflected_message_id or 0) + 1
        member_first = (cursor.last_member_reflected_message_id or 0) + 1
        last = cursor.last_message_id
        should_group = should_hourly
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
        job_id = await enqueue_scope(scope, group_first, last, "active-window", now=now)
        if job_id is not None:
            job_ids.append(job_id)
    if should_threshold:
        job_id = await enqueue_scope(
            scope, member_first, last, "message-threshold", task_type="member-batch", now=now,
        )
        if job_id is not None:
            job_ids.append(job_id)
    return job_ids[0] if job_ids else None


async def settle_idle_scopes(*, now=None, limit: int = 100) -> int:
    """扫描 15 分钟无新消息且未收束的 scope，每轮只投递一次。"""
    from app.models import MemoryReflectionCursor

    now = now or now_utc()
    cutoff = now - IDLE_WINDOW
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
    return await observe_group_message(
        scope, message.id, message.created_at or now, now=now, member_batch=member_batch,
    )


async def observe_private_member_activity(
    scope: MemoryScope,
    session_id: int,
    platform_user_id: str,
    *,
    now=None,
    force: bool = False,
) -> Optional[int]:
    """私聊完成一个回合后立即复用 owner 反思策略，写入隔离的 platform-user scope。

    私聊不再有独立的成员计数阈值；scope 只用于隔离目标用户的记忆文件，反思的
    触发时机、Prompt 和 JSON 契约与 owner 保持一致。
    """
    from app.models import MemoryReflectionCursor, ConversationMessage

    if scope.scope_type != "platform-user":
        return None
    now = now or now_utc()
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
                scope_version=1,
                created_at=now,
                updated_at=now,
            )
            db.add(cursor)
            await db.commit()
            await db.close()
            return await enqueue_scope(
                scope, message.id, message.id, "active-turn", task_type="private-owner", now=now,
            )
        cursor.last_message_id = message.id
        cursor.last_message_at = message.created_at or now
        cursor.scope_version += 1
        first = (cursor.last_reflected_message_id or 0) + 1
        cursor.active_started_at = message.created_at or now
        await db.commit()
    return await enqueue_scope(
        scope, first, message.id, "active-turn" if not force else "tool",
        task_type="private-owner", now=now,
    )
