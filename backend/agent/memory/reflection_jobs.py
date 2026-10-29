"""IM 记忆反思任务、群消息游标和闲置收束状态机。"""
from __future__ import annotations

import asyncio
import time
from datetime import timedelta
from typing import Any, List, Optional

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError

from app.core import redis as R
from app.core.tz import now_utc
from agent.memory import reflection_idle
from agent.memory.scopes import MemoryScope


REFLECTION_STREAM = "memory:reflection"
REFLECTION_GROUP = "memory-reflection-workers"
EXTRACTOR_VERSION = "im-memory-v1"
IDLE_WINDOW = reflection_idle.IDLE_WINDOW
# 会话忙、压缩未完成等暂缓执行的重试延迟不随闲置触发窗口变化。
DEFERRED_JOB_RETRY_DELAY = timedelta(minutes=4)
MAX_RETRIES = 5
RETRY_BACKOFF_MINUTES = (1, 5, 30, 120, 360)
GROUP_MESSAGE_THRESHOLD = 50
_LOCAL_SNAPSHOT_TASKS: set[asyncio.Task] = set()
_LOCAL_IDLE_SNAPSHOT_TASKS: dict[str, asyncio.Task] = {}
_LOCAL_IDLE_SNAPSHOT_DRAINING: set[asyncio.Task] = set()
_LOCAL_IDLE_SNAPSHOT_MARKER_PREFIX = "memory:reflection:local-idle-snapshot:"
_LOCAL_IDLE_SNAPSHOT_MARKER_GRACE_SECONDS = 90
_LOCAL_IDLE_SNAPSHOT_MARKER_REFRESH_SECONDS = 30
_REFRESH_LOCAL_IDLE_SNAPSHOT_MARKER_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
return 0
"""
_DELETE_LOCAL_IDLE_SNAPSHOT_MARKER_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""
_async_sleep = asyncio.sleep


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


def _local_idle_snapshot_marker(scope: MemoryScope) -> str:
    return f"{_LOCAL_IDLE_SNAPSHOT_MARKER_PREFIX}{scope.prefix}"


async def _refresh_local_idle_snapshot_marker(redis, marker: str, token: str) -> bool:
    return bool(await redis.eval(
        _REFRESH_LOCAL_IDLE_SNAPSHOT_MARKER_LUA,
        1,
        marker,
        token,
        str(_LOCAL_IDLE_SNAPSHOT_MARKER_REFRESH_SECONDS * 3),
    ))


async def _delete_local_idle_snapshot_marker(redis, marker: str, token: str) -> bool:
    return bool(await redis.eval(
        _DELETE_LOCAL_IDLE_SNAPSHOT_MARKER_LUA,
        1,
        marker,
        token,
    ))


async def _arm_local_idle_snapshot(scope: MemoryScope, session_id: int, settings, snapshot) -> bool:
    """让捕获快照的进程在 idle 窗口到期后执行群反思；worker 只作进程退出后的接管。"""
    from app.core.redis import get_redis

    redis = get_redis()
    marker = _local_idle_snapshot_marker(scope)
    task_key = f"{scope.prefix}:{session_id}"
    token = str(time.time_ns())
    try:
        await redis.set(
            marker, token,
            ex=int(IDLE_WINDOW.total_seconds()) + _LOCAL_IDLE_SNAPSHOT_MARKER_GRACE_SECONDS,
        )
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("agent.memory.reflection_jobs.local_snapshot_marker", exc)
        return False

    previous = _LOCAL_IDLE_SNAPSHOT_TASKS.get(task_key)
    if (previous is not None and not previous.done()
            and previous not in _LOCAL_IDLE_SNAPSHOT_DRAINING):
        previous.cancel()

    async def run_local_idle_snapshot() -> None:
        owning_task = asyncio.current_task()
        marker_task = None
        try:
            await _async_sleep(IDLE_WINDOW.total_seconds())

            async def refresh_marker() -> None:
                while True:
                    await _async_sleep(_LOCAL_IDLE_SNAPSHOT_MARKER_REFRESH_SECONDS)
                    if not await _refresh_local_idle_snapshot_marker(redis, marker, token):
                        return

            marker_task = asyncio.create_task(refresh_marker())
            if owning_task is not None:
                _LOCAL_IDLE_SNAPSHOT_DRAINING.add(owning_task)
            try:
                await _settle_scope_with_snapshot(scope, settings, snapshot)
            finally:
                _LOCAL_IDLE_SNAPSHOT_DRAINING.discard(owning_task)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            from app.core.redaction import diag_log
            diag_log("agent.memory.reflection_jobs.local_snapshot_drain", exc)
        finally:
            if marker_task is not None:
                marker_task.cancel()
                try:
                    await marker_task
                except asyncio.CancelledError:
                    pass
            try:
                await _delete_local_idle_snapshot_marker(redis, marker, token)
            except Exception:
                pass
            if _LOCAL_IDLE_SNAPSHOT_TASKS.get(task_key) is owning_task:
                _LOCAL_IDLE_SNAPSHOT_TASKS.pop(task_key, None)

    task = asyncio.create_task(run_local_idle_snapshot())
    _LOCAL_IDLE_SNAPSHOT_TASKS[task_key] = task
    _LOCAL_SNAPSHOT_TASKS.add(task)
    task.add_done_callback(_LOCAL_SNAPSHOT_TASKS.discard)
    return True


async def shutdown_local_idle_snapshots() -> None:
    """取消尚在等待的群反思定时器，并等待已开始的收束完成。"""
    # 新建任务可能还未获得首个执行机会；先让它进入 try/finally，再取消。
    await asyncio.sleep(0)
    scheduled = list(_LOCAL_IDLE_SNAPSHOT_TASKS.items())
    for _key, task in scheduled:
        if not task.done() and task not in _LOCAL_IDLE_SNAPSHOT_DRAINING:
            task.cancel()
    tasks = list(_LOCAL_SNAPSHOT_TASKS)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _settle_scope_with_snapshot(scope: MemoryScope, settings, snapshot) -> int:
    """在原始请求进程内收束一个已闲置群 scope，并以其 Provider 前缀执行任务。"""
    from app.models import MemoryReflectionCursor

    now = now_utc()
    cutoff = reflection_idle.idle_cutoff(now)
    async with await _db_session() as db:
        cursor = (await db.execute(
            select(MemoryReflectionCursor)
            .where(*_scope_filters(MemoryReflectionCursor, scope))
            .with_for_update()
        )).scalars().first()
        if (cursor is None or cursor.scope_type != "group"
                or cursor.pending_agent_count <= 0
                or cursor.active_started_at is None
                or cursor.active_started_at > cutoff
                or cursor.settled_at is not None):
            return 0
        cursor_id = cursor.id
        version = cursor.scope_version
        active_started_at = cursor.active_started_at
        last = cursor.last_message_id
        group_first = (cursor.last_reflected_message_id or 0) + 1
        member_first = (cursor.last_member_reflected_message_id or 0) + 1
        await db.commit()

    pending: list[int] = []
    if last is not None:
        if group_first <= last:
            job_id = await enqueue_scope(
                scope, group_first, last, "idle", task_type="group",
                defer_dispatch=True, now=now,
            )
            if job_id is not None:
                pending.append(job_id)
        if member_first <= last:
            job_id = await enqueue_scope(
                scope, member_first, last, "idle", task_type="member-batch",
                defer_dispatch=True, now=now,
            )
            if job_id is not None:
                pending.append(job_id)

    async with await _db_session() as db:
        cursor = await db.get(MemoryReflectionCursor, cursor_id)
        if (cursor and cursor.last_message_id == last and cursor.settled_at is None
                and cursor.active_started_at == active_started_at
                and cursor.scope_version == version):
            cursor.settled_at = now
            cursor.pending_passive_count = 0
            cursor.pending_agent_count = 0
            cursor.updated_at = now
            await db.commit()

    if pending:
        from app.models import MemoryReflectionJob

        async with await _db_session() as db:
            jobs = (await db.execute(
                select(MemoryReflectionJob).where(MemoryReflectionJob.id.in_(pending))
            )).scalars().all()
            for job in jobs:
                if job.status in {"pending", "retry"}:
                    job.next_attempt_at = now
                    job.updated_at = now
            await db.commit()

    from agent.memory.im_reflection import execute_job

    for job_id in pending:
        completed = await execute_job(job_id, settings, snapshot=snapshot)
        if not completed:
            # Worker 可接手锁竞争或本地任务失败；重放受 job 状态与幂等键保护。
            await _dispatch_job(job_id)
    return len(pending)


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
    """累计被动消息；只有已完成的主动 run 才登记群闲置窗口。"""
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
                active_started_at=None if member_batch else now,
                last_message_at=message_at or now,
                last_message_id=message_id,
                scope_version=1,
                pending_passive_count=1 if member_batch else 0,
                pending_agent_count=0 if member_batch else 1,
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

        if not member_batch:
            # 群游标的 agent 计数表示尚未收束的主动回合。被动消息不能重置时钟。
            cursor.pending_agent_count += 1
            cursor.settled_at = None
            cursor.active_started_at = now
        if message_id >= (cursor.last_message_id or 0):
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


def _idle_scope_predicate(cutoff):
    """群必须有主动回合；私聊仍以末条消息为闲置起点。"""
    from app.models import MemoryReflectionCursor

    return or_(
        and_(
            MemoryReflectionCursor.scope_type == "group",
            MemoryReflectionCursor.pending_agent_count > 0,
            MemoryReflectionCursor.active_started_at <= cutoff,
        ),
        and_(
            MemoryReflectionCursor.scope_type != "group",
            MemoryReflectionCursor.last_message_at <= cutoff,
        ),
    )


async def settle_idle_scopes(*, now=None, limit: int = 100) -> int:
    """群按主动 run 完成时间收束；私聊保留原消息闲置规则。"""
    from app.models import MemoryReflectionCursor

    now = now or now_utc()
    cutoff = reflection_idle.idle_cutoff(now)
    async with await _db_session() as db:
        rows = (await db.execute(
            select(MemoryReflectionCursor)
            .where(
                _idle_scope_predicate(cutoff),
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
            pending.append((scope, cursor, cursor.id, cursor.active_started_at, cursor.scope_version))
        await db.commit()
    settled = 0
    for scope, cursor, cursor_id, active_started_at, version in pending:
        # 活跃 run 的进程仍持有原始前缀时，由本机 idle drain 执行；Redis 只存协调标记。
        if await R.get_redis().get(_local_idle_snapshot_marker(scope)):
            continue
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
        already_reflected = scope.scope_type == "group" and group_first > last and member_first > last
        if not already_reflected and not any(job_id is not None for job_id in jobs):
            continue
        async with await _db_session() as db:
            cursor = await db.get(MemoryReflectionCursor, cursor_id)
            if (cursor and cursor.last_message_id == last and cursor.settled_at is None
                    and cursor.active_started_at == active_started_at and cursor.scope_version == version):
                cursor.settled_at = now
                if scope.scope_type == "group":
                    cursor.pending_passive_count = 0
                    cursor.pending_agent_count = 0
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
        eligible = []
        for job in rows:
            if job.reason == "idle":
                scope = MemoryScope(
                    job.owner_user_id, job.platform, job.bot_id,
                    job.scope_type, job.scope_id,
                )
                if await R.get_redis().get(_local_idle_snapshot_marker(scope)):
                    continue
            job.status = "pending"
            job.locked_at = None
            job.next_attempt_at = now
            job.updated_at = now
            eligible.append(job)
        await db.commit()
        ids = [job.id for job in eligible]
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
            .order_by(ConversationMessage.conversation_seq.desc())
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
    if scope.scope_type == "group":
        from app.core.config import get_settings

        await _arm_local_idle_snapshot(scope, session_id, get_settings(), snapshot)
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
            .order_by(ConversationMessage.conversation_seq.desc())
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
