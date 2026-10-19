"""群被动记录、主动闲置与上下文压力的独立触发契约。"""
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from agent.memory import reflection_jobs
from agent.memory.scopes import MemoryScope
from app.core.tz import now_utc
from app.models import ConversationMessage, ConversationSession, MemoryReflectionCursor, MemoryReflectionJob


@pytest.mark.asyncio
async def test_passive_group_does_not_arm_idle_but_active_clock_ignores_later_passive(db, user_a, monkeypatch):
    scope = MemoryScope(user_a.id, "qq", "bot-synthetic", "group", "group-synthetic")
    now = now_utc()
    enqueue = AsyncMock(return_value=1)
    monkeypatch.setattr(reflection_jobs, "enqueue_scope", enqueue)
    await reflection_jobs.observe_group_message(scope, 1, now, now=now)
    assert await reflection_jobs.settle_idle_scopes(now=now + timedelta(hours=1)) == 0
    assert enqueue.await_count == 0

    ended = now + timedelta(hours=1)
    await reflection_jobs.observe_group_message(scope, 2, now, now=ended, member_batch=False)
    await reflection_jobs.observe_group_message(scope, 3, ended + timedelta(minutes=4), now=ended + timedelta(minutes=4))
    assert await reflection_jobs.settle_idle_scopes(now=ended + reflection_jobs.IDLE_WINDOW - timedelta(seconds=1)) == 0
    assert await reflection_jobs.settle_idle_scopes(now=ended + reflection_jobs.IDLE_WINDOW) == 1
    assert [(call.args[2], call.kwargs.get("task_type", "group")) for call in enqueue.await_args_list] == [
        (3, "group"), (3, "member-batch"),
    ]
    assert await reflection_jobs.settle_idle_scopes(now=ended + timedelta(hours=1)) == 0


@pytest.mark.asyncio
async def test_new_active_run_restarts_clock_without_moving_message_watermark_backward(db, user_a, monkeypatch):
    scope = MemoryScope(user_a.id, "qq", "bot-synthetic", "group", "group-active")
    now = now_utc()
    monkeypatch.setattr(reflection_jobs, "enqueue_scope", AsyncMock(return_value=1))
    await reflection_jobs.observe_group_message(scope, 10, now, now=now, member_batch=False)
    await reflection_jobs.observe_group_message(scope, 12, now, now=now)
    ended = now + timedelta(minutes=4)
    await reflection_jobs.observe_group_message(scope, 11, now, now=ended, member_batch=False)
    assert await reflection_jobs.settle_idle_scopes(now=now + reflection_jobs.IDLE_WINDOW) == 0
    assert await reflection_jobs.settle_idle_scopes(now=ended + reflection_jobs.IDLE_WINDOW) == 1
    cursor = (await db.execute(select(MemoryReflectionCursor))).scalars().one()
    assert cursor.last_message_id == 12


@pytest.mark.asyncio
async def test_old_idle_scan_cannot_clear_new_active_window_with_same_message_id(db, user_a, monkeypatch):
    scope = MemoryScope(user_a.id, "qq", "bot-synthetic", "group", "group-race")
    now = now_utc()
    await reflection_jobs.observe_group_message(scope, 10, now, now=now, member_batch=False)
    scan_at = now + reflection_jobs.IDLE_WINDOW
    switched = False

    async def enqueue(*args, **kwargs):
        nonlocal switched
        if not switched:
            switched = True
            await reflection_jobs.observe_group_message(scope, 10, now, now=scan_at, member_batch=False)
        return 1

    monkeypatch.setattr(reflection_jobs, "enqueue_scope", enqueue)
    assert await reflection_jobs.settle_idle_scopes(now=scan_at) == 0
    cursor = (await db.execute(select(MemoryReflectionCursor))).scalars().one()
    assert cursor.active_started_at == scan_at
    assert cursor.settled_at is None
    assert cursor.pending_agent_count == 2


@pytest.mark.asyncio
async def test_idle_closes_already_reflected_window_without_repeating_jobs(db, user_a, monkeypatch):
    scope = MemoryScope(user_a.id, "qq", "bot-synthetic", "group", "group-reflected")
    now = now_utc()
    await reflection_jobs.observe_group_message(scope, 10, now, now=now, member_batch=False)
    cursor = (await db.execute(select(MemoryReflectionCursor))).scalars().one()
    cursor.last_reflected_message_id = cursor.last_member_reflected_message_id = 10
    await db.commit()
    enqueue = AsyncMock()
    monkeypatch.setattr(reflection_jobs, "enqueue_scope", enqueue)
    assert await reflection_jobs.settle_idle_scopes(now=now + reflection_jobs.IDLE_WINDOW) == 1
    assert await reflection_jobs.settle_idle_scopes(now=now + timedelta(hours=1)) == 0
    await db.refresh(cursor)
    assert cursor.pending_agent_count == 0
    assert cursor.settled_at is not None
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_owner_passive_buffer_neither_arms_nor_extends_idle(monkeypatch):
    from agent.memory import reflection, reflection_idle
    from app.core.redis import get_redis

    redis = get_redis()
    arm = AsyncMock()
    monkeypatch.setattr(reflection, "_arm_local_idle_drain", arm)
    key = reflection._owner_group_buffer_key("synthetic-owner", 17)
    member = reflection._owner_idle_member("synthetic-owner", 17)
    settings = SimpleNamespace()
    await reflection._schedule_group_owner("synthetic-owner", "小北", "背景", "", settings, 17, passive=True)
    assert await redis.llen(key) == 1
    assert await redis.zscore(reflection_idle.GROUP_OWNER_IDLE_KEY, member) is None
    arm.assert_not_awaited()
    await reflection._schedule_group_owner("synthetic-owner", "小北", "问题", "回复", settings, 17)
    score = await redis.zscore(reflection_idle.GROUP_OWNER_IDLE_KEY, member)
    await reflection._schedule_group_owner("synthetic-owner", "小北", "背景二", "", settings, 17, passive=True)
    assert await redis.zscore(reflection_idle.GROUP_OWNER_IDLE_KEY, member) == score
    assert arm.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("estimated,expected", [(899, False), (900, True), (901, True)])
async def test_passive_pressure_at_ninety_percent_enqueues_both_scopes_below_fifty(
    db, user_a, monkeypatch, estimated, expected,
):
    from agent.memory import group_pressure, im_reflection

    now = now_utc()
    scope = MemoryScope(user_a.id, "qq", "bot-synthetic", "group", "group-pressure")
    session = ConversationSession(user_id=user_a.id, source="qq", bot_id=scope.bot_id, chat_id=scope.scope_id, chat_type="group")
    db.add(session)
    await db.flush()
    message = ConversationMessage(session_id=session.id, role="user", content="一条较长的背景消息", platform_user_id="member-synthetic")
    db.add(message)
    await db.commit()
    await reflection_jobs.observe_group_message(scope, message.id, now, now=now)
    model = SimpleNamespace(context_tokens=1000, max_tokens=100)
    monkeypatch.setattr("agent.llm.llm_select.resolve_run_config_for_user", AsyncMock(return_value=SimpleNamespace(model=model)))
    monkeypatch.setattr(im_reflection, "_rebuild_session_snapshot", AsyncMock(return_value=SimpleNamespace(history=(), system_prompt="")))
    monkeypatch.setattr(group_pressure.ContextBudget, "from_messages", lambda *a, **kw: SimpleNamespace(total_tokens=estimated))
    dispatch = AsyncMock()
    monkeypatch.setattr(reflection_jobs, "_dispatch_job", dispatch)
    assert await group_pressure.observe_passive_context_pressure(scope, session.id) is expected
    jobs = (await db.execute(select(MemoryReflectionJob))).scalars().all()
    assert {job.task_type for job in jobs} == ({"group", "member-batch"} if expected else set())
    assert all(job.reason == "context-pressure" for job in jobs)
    if expected:
        assert await group_pressure.observe_passive_context_pressure(scope, session.id) is False
        assert dispatch.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("can_compact", [True, False])
async def test_pressure_job_rebuilds_stale_run_then_compacts_before_reflecting(db, user_a, monkeypatch, can_compact):
    """贯穿任务执行器和真实预算预检；被动增量不能沿用旧 run 的低用量/已压缩标记。"""
    from agent.context import compress_conv
    from agent.context.branch_types import BranchInput
    from agent.memory import im_reflection

    session = ConversationSession(user_id=user_a.id, source="qq", bot_id="bot-synthetic", chat_id="pressure-group", chat_type="group")
    db.add(session)
    await db.flush()
    message = ConversationMessage(session_id=session.id, role="user", content="中" * 2000, platform_user_id="member-synthetic")
    db.add(message)
    await db.flush()
    job = MemoryReflectionJob(
        owner_user_id=user_a.id, platform="qq", bot_id="bot-synthetic", scope_type="group", scope_id="pressure-group",
        task_type="member-batch", from_message_id=message.id, to_message_id=message.id,
        idempotency_key="synthetic-pressure-job", reason="context-pressure", status="pending",
    )
    db.add(job)
    await db.commit()
    model = SimpleNamespace(context_tokens=1000, max_tokens=100)
    stale = SimpleNamespace(provider_context_input=1, provider_compacted=True)
    large = SimpleNamespace(history=({"role": "user", "content": message.content},), system_prompt="")
    small = SimpleNamespace(history=({"role": "user", "content": "已压缩摘要"},), system_prompt="")
    monkeypatch.setattr("agent.llm.llm_select.resolve_run_config_for_user", AsyncMock(return_value=SimpleNamespace(model=model)))
    monkeypatch.setattr("app.byok.service.resolve_and_bind_user_embedding", AsyncMock())
    monkeypatch.setattr("agent.context.reflection_snapshot.peek_reflection_snapshot", lambda *args: stale)
    rebuild = AsyncMock(side_effect=[large, small])
    monkeypatch.setattr(im_reflection, "_rebuild_session_snapshot", rebuild)
    operations = []

    async def compact(*args, **kwargs):
        assert kwargs["only_if_idle"] is True
        assert kwargs["cache_snapshot"] is large
        operations.append("compress")
        return can_compact

    monkeypatch.setattr(compress_conv, "compress_if_needed", compact)
    monkeypatch.setattr(im_reflection, "_aggregate_members", AsyncMock(return_value={}))
    monkeypatch.setattr(im_reflection, "read_scope_json", AsyncMock(return_value={}))
    monkeypatch.setattr(im_reflection, "write_scope_json", AsyncMock())
    monkeypatch.setattr(im_reflection, "read_scope", AsyncMock(return_value={}))
    monkeypatch.setattr(im_reflection, "_apply_member_batch_output", AsyncMock())

    def build(*args, **kwargs):
        assert kwargs["snapshot"] is small
        return BranchInput(stable_system="合成提示")

    async def reflect(*args, **kwargs):
        operations.append("reflect")
        return SimpleNamespace(ok=True, output={"members": []}, return_reason="ok")

    monkeypatch.setattr(im_reflection, "_build_append_branch_input", build)
    monkeypatch.setattr(im_reflection, "run_reflection_branch", reflect)
    assert await im_reflection._execute_job_locked(job.id, SimpleNamespace()) is can_compact
    await db.refresh(job)
    assert operations == (["compress", "reflect"] if can_compact else ["compress"])
    assert job.status == ("completed" if can_compact else "pending")
    assert rebuild.await_count == (2 if can_compact else 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("body_length,job_count", [(500, 0), (2000, 2)])
async def test_passive_recording_dispatches_pressure_jobs_without_waiting_for_fifty(db, user_a, monkeypatch, body_length, job_count):
    """从真实被动入库入口经过真实预算估算，长消息立即产生持久任务，不调用模型。"""
    from agent.im import loop
    from agent.memory import im_reflection, reflection

    request = SimpleNamespace(
        attachments=[], user_id=user_a.id, source="qq", platform_bot_id="bot-synthetic",
        chat_id="passive-pressure", platform_user_id="member-synthetic", platform_user_name="小北",
        platform_bot_user_id=None, message="中" * body_length, quoted_text=None,
        im_group_memory_enabled=True, im_role="member", user_name="小北",
    )
    model = SimpleNamespace(context_tokens=1000, max_tokens=100)
    monkeypatch.setattr("agent.llm.llm_select.resolve_run_config_for_user", AsyncMock(return_value=SimpleNamespace(model=model)))
    monkeypatch.setattr(im_reflection, "_rebuild_session_snapshot", AsyncMock(return_value=SimpleNamespace(
        history=({"role": "user", "content": request.message},), system_prompt="",
    )))
    monkeypatch.setattr("app.core.events.publish", AsyncMock())
    monkeypatch.setattr(reflection, "flush_group_owner_buffer", lambda *a: None)
    dispatch = AsyncMock()
    monkeypatch.setattr(reflection_jobs, "_dispatch_job", dispatch)
    session_id = await loop.record_passive_im_message(request)
    jobs = (await db.execute(select(MemoryReflectionJob))).scalars().all()
    assert len(jobs) == job_count
    assert all(job.reason == "context-pressure" for job in jobs)
    assert dispatch.await_count == job_count
    cursor = (await db.execute(select(MemoryReflectionCursor))).scalars().one()
    assert cursor.pending_passive_count == 1
    assert cursor.pending_agent_count == 0
    assert cursor.active_started_at is None
    assert await reflection_jobs.settle_idle_scopes(now=now_utc() + timedelta(hours=1)) == 0
    assert session_id is not None
