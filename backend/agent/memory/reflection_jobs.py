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
PASSIVE_MESSAGE_THRESHOLD = 30
AGENT_MESSAGE_THRESHOLD = 5


def _scope_filters(model, scope: MemoryScope) -> List[Any]:
    return [
        model.owner_user_id == scope.owner_user_id,
        model.platform == scope.platform,
        model.bot_id == scope.bot_id,
        model.scope_type == scope.scope_type,
        model.scope_id == scope.scope_id,
    ]


def _idempotency_key(scope: MemoryScope, first: int, last: int) -> str:
    return ":".join((scope.prefix, str(first), str(last), EXTRACTOR_VERSION))


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
    key = _idempotency_key(scope, first_message_id, last_message_id)
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
) -> Optional[int]:
    """推进群/成员游标。

    group scope 仍按活跃窗口整理；platform-user scope 将被动消息和进入
    Agent 的回合分开计数，分别按 30/5 条触发。工具调用用 force 立即触发。
    """
    from app.models import MemoryReflectionCursor
    from agent.memory.scope_lifecycle import is_tombstoned

    now = now or now_utc()
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
                pending_passive_count=1 if scope.scope_type == "platform-user" and trigger_mode == "passive" else 0,
                pending_agent_count=1 if scope.scope_type == "platform-user" and trigger_mode == "agent" else 0,
                created_at=now,
                updated_at=now,
            )
            db.add(cursor)
            try:
                await db.commit()
                if scope.scope_type == "platform-user" and force:
                    await db.close()
                    return await enqueue_scope(
                        scope, message_id, message_id, "tool", now=now,
                    )
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
        if scope.scope_type == "platform-user":
            if trigger_mode == "agent":
                cursor.pending_agent_count += 1
            else:
                cursor.pending_passive_count += 1
        should_hourly = bool(
            cursor.active_started_at and now - cursor.active_started_at >= ACTIVE_WINDOW
        )
        should_threshold = scope.scope_type == "platform-user" and (
            force
            or cursor.pending_agent_count >= AGENT_MESSAGE_THRESHOLD
            or cursor.pending_passive_count >= PASSIVE_MESSAGE_THRESHOLD
        )
        first = (cursor.last_reflected_message_id or 0) + 1
        last = cursor.last_message_id
        if should_hourly or should_threshold:
            cursor.active_started_at = message_at or now
            if should_threshold:
                cursor.pending_passive_count = 0
                cursor.pending_agent_count = 0
            cursor.updated_at = now
            await db.commit()
        else:
            await db.commit()
            return None
    return await enqueue_scope(scope, first, last, "active-window", now=now)


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
            first = (cursor.last_reflected_message_id or 0) + 1
            pending.append((scope, first, cursor.last_message_id, cursor.id))
        await db.commit()
    settled = 0
    for scope, first, last, cursor_id in pending:
        try:
            job_id = await enqueue_scope(scope, first, last, "idle", now=now)
        except Exception:
            continue
        if job_id is None:
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


async def observe_session_activity(scope: MemoryScope, session_id: int, *, now=None) -> Optional[int]:
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
    return await observe_group_message(scope, message.id, message.created_at or now, now=now)


async def observe_member_activity(
    scope: MemoryScope,
    session_id: int,
    platform_user_id: str,
    *,
    now=None,
    used_tools: bool = False,
) -> Optional[int]:
    """只用当前平台用户的 Agent 回合推进 member scope。"""
    from app.models import ConversationMessage

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
    return await observe_group_message(
        scope, message.id, message.created_at or now, now=now,
        trigger_mode="agent", force=used_tools,
    )


async def observe_member_message(
    scope: MemoryScope,
    message_id: int,
    message_at,
    *,
    now=None,
) -> Optional[int]:
    """记录未进入 Agent 的成员消息，达到 30 条或空闲时再反思。"""
    return await observe_group_message(
        scope, message_id, message_at, now=now,
        trigger_mode="passive", force=False,
    )
