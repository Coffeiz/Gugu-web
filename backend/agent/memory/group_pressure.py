"""被动群消息的上下文压力事件；不注册 idle、不调用模型。"""
import logging

from sqlalchemy import select

from agent.context.budget import ContextBudget
from agent.context.compaction import compaction_trigger_tokens
from agent.memory import reflection_jobs
from agent.memory.scopes import MemoryScope

logger = logging.getLogger(__name__)


async def observe_passive_context_pressure(scope: MemoryScope, session_id: int) -> bool:
    """无新 provider usage 的被动历史仅作估算预检；超阈值交回正式反思流程。"""
    from app.core.redis import get_redis

    if scope.scope_type != "group":
        return False
    lock = get_redis().lock(f"memory:group-pressure:{scope.prefix}", timeout=60)
    if not await lock.acquire(blocking=False):
        return False
    try:
        return await _enqueue_pressure_if_needed(scope, session_id)
    finally:
        await lock.release()


async def _enqueue_pressure_if_needed(scope: MemoryScope, session_id: int) -> bool:
    from agent.llm.llm_select import resolve_run_config_for_user
    from agent.memory.im_reflection import _rebuild_session_snapshot
    from app.core.config import get_settings
    from app.models import MemoryReflectionCursor, MemoryReflectionJob

    settings = get_settings()
    async with await reflection_jobs._db_session() as db:
        # 在途压力任务自行重试；新被动消息不能每次都排一份重叠任务。
        pending = set((await db.execute(select(MemoryReflectionJob.task_type).where(
            *reflection_jobs._scope_filters(MemoryReflectionJob, scope),
            MemoryReflectionJob.reason == "context-pressure",
            MemoryReflectionJob.status.in_(("pending", "running", "retry")),
        ))).scalars().all())
        if {"group", "member-batch"} <= pending:
            return False
        cursor = (await db.execute(select(MemoryReflectionCursor).where(
            *reflection_jobs._scope_filters(MemoryReflectionCursor, scope),
        ))).scalars().first()
        if cursor is None or cursor.last_message_id is None:
            return False
        model = (await resolve_run_config_for_user(settings, db, scope.owner_user_id, None)).model
        if model.context_tokens <= 0:
            return False
        # 必须重建当前历史；旧 run 的 usage/压缩标志不能代表新增的被动消息。
        snapshot = await _rebuild_session_snapshot(db, scope, session_id, model, [])
        if snapshot is None:
            return False
        # 被动正文已经在重建历史中，不能再次作为 current turn 重复估算。
        budget = ContextBudget.from_messages(
            model.context_tokens, snapshot.history, system_text=snapshot.system_prompt,
            output_reserve_tokens=min(max(1, int(model.max_tokens or 900)), 900),
        )
        if budget.total_tokens < compaction_trigger_tokens(model.context_tokens):
            return False
        logger.info(
            "[group-reflection-pressure] session=%s source=estimate total_tokens=%s context_tokens=%s",
            session_id, budget.total_tokens, model.context_tokens,
        )
        windows = (
            ("group", (cursor.last_reflected_message_id or 0) + 1),
            ("member-batch", (cursor.last_member_reflected_message_id or 0) + 1),
        )
        last = cursor.last_message_id
    enqueued = False
    for task_type, start in windows:
        if task_type in pending:
            continue
        job_id = await reflection_jobs.enqueue_scope(
            scope, start, last, "context-pressure", task_type=task_type,
        )
        enqueued = job_id is not None or enqueued
    return enqueued
