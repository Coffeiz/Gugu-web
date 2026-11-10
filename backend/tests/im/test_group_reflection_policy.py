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
async def test_worker_takes_over_group_idle_after_local_snapshot_marker_expires(
    db, user_a, monkeypatch,
):
    """本地快照标记存续时 worker 避让；标记失效后 worker 收束同一闲置批次。"""
    from app.core.redis import get_redis

    scope = MemoryScope(user_a.id, "qq", "bot-synthetic", "group", "group-handoff")
    now = now_utc()
    await reflection_jobs.observe_group_message(scope, 10, now, now=now, member_batch=False)
    redis = get_redis()
    marker = reflection_jobs._local_idle_snapshot_marker(scope)
    await redis.set(marker, "snapshot-token", ex=90)
    enqueue = AsyncMock(return_value=1)
    monkeypatch.setattr(reflection_jobs, "enqueue_scope", enqueue)
    due_at = now + reflection_jobs.IDLE_WINDOW

    assert await reflection_jobs.settle_idle_scopes(now=due_at) == 0
    enqueue.assert_not_awaited()

    await redis.delete(marker)
    assert await reflection_jobs.settle_idle_scopes(now=due_at) == 1
    assert enqueue.await_count == 2
    assert [call.kwargs.get("task_type", "group") for call in enqueue.await_args_list] == [
        "group", "member-batch",
    ]


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
async def test_existing_pressure_job_reflects_without_estimating_rebuilt_history(db, user_a, monkeypatch):
    """迁移前入队的压力任务仍可消费；重建历史没有 Provider 用量时不触发压缩。"""
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
    monkeypatch.setattr("agent.llm.llm_select.resolve_run_config_for_user", AsyncMock(return_value=SimpleNamespace(model=model)))
    monkeypatch.setattr("app.byok.service.resolve_and_bind_user_embedding", AsyncMock())
    monkeypatch.setattr("agent.context.reflection_snapshot.peek_reflection_snapshot", lambda *args: stale)
    rebuild = AsyncMock(return_value=large)
    monkeypatch.setattr(im_reflection, "_rebuild_session_snapshot", rebuild)
    operations = []
    compact = AsyncMock()
    monkeypatch.setattr(compress_conv, "compress_if_needed", compact)

    monkeypatch.setattr(im_reflection, "_aggregate_members", AsyncMock(return_value={}))
    monkeypatch.setattr(im_reflection, "read_scope_json", AsyncMock(return_value={}))
    monkeypatch.setattr(im_reflection, "write_scope_json", AsyncMock())
    monkeypatch.setattr(im_reflection, "read_scope", AsyncMock(return_value={}))
    monkeypatch.setattr(im_reflection, "_apply_member_batch_output", AsyncMock())

    def build(*args, **kwargs):
        assert kwargs["snapshot"] is large
        return BranchInput(stable_system="合成提示")

    async def reflect(*args, **kwargs):
        operations.append("reflect")
        return SimpleNamespace(ok=True, output={"members": []}, return_reason="ok")

    monkeypatch.setattr(im_reflection, "_build_append_branch_input", build)
    monkeypatch.setattr(im_reflection, "run_reflection_branch", reflect)
    assert await im_reflection._execute_job_locked(job.id, SimpleNamespace()) is True
    await db.refresh(job)
    compact.assert_not_awaited()
    assert operations == ["reflect"]
    assert job.status == "completed"
    rebuild.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("body_length", [500, 20000])
async def test_passive_recording_does_not_estimate_context_pressure(db, user_a, monkeypatch, body_length):
    """长消息入库时继续累积条数，没有 Provider 用量时不触发压力任务。"""
    from agent.im import conversation
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
    session_id = await conversation.record_passive_im_message(request)
    jobs = (await db.execute(select(MemoryReflectionJob))).scalars().all()
    assert jobs == []
    dispatch.assert_not_awaited()
    cursor = (await db.execute(select(MemoryReflectionCursor))).scalars().one()
    assert cursor.pending_passive_count == 1
    assert cursor.pending_agent_count == 0
    assert cursor.active_started_at is None
    assert await reflection_jobs.settle_idle_scopes(now=now_utc() + timedelta(hours=1)) == 0
    assert session_id is not None
