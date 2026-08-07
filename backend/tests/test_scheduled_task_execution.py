import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest


@pytest.mark.asyncio
async def test_scheduled_execution_always_uses_full_loop(monkeypatch, db, user_a):
    """创建任务不再调用 LLM 选择工具，执行阶段直接使用完整工具集。"""
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=("执行结果", False, {"tool_names": [], "mutated": False}))
    report = AsyncMock()
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", report)

    result, _files = await scheduled._run_agent(user_a.id, "测试任务", trial=True)

    assert result == "执行结果"
    execution.assert_awaited_once()
    report.assert_not_awaited()


@pytest.mark.asyncio
async def test_scheduled_tools_run_report_without_reexecuting(monkeypatch, db, user_a):
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=("工具执行结果", False, {"tool_names": ["web_search"], "mutated": False}))
    report = AsyncMock(return_value=("整理后的报告", False))
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", report)

    result, _files = await scheduled._run_agent(user_a.id, "查资料", trial=True)

    assert result == "整理后的报告"
    execution.assert_awaited_once()
    report.assert_awaited_once()
    assert report.await_args.args[0] == user_a.id
    assert report.await_args.args[2:] == ("查资料", "工具执行结果")


@pytest.mark.asyncio
async def test_scheduled_execution_failure_after_mutation_is_not_replayed(monkeypatch, db, user_a):
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=("写入后模型失败", True, {"tool_names": ["update_file"], "mutated": True}))
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)

    result, _files = await scheduled._run_agent(user_a.id, "修改文件", trial=False)

    assert result == "写入后模型失败"
    execution.assert_awaited_once()


@pytest.mark.asyncio
async def test_scheduled_report_failure_retries_report_only(monkeypatch, db, user_a):
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=("查询结果", False, {"tool_names": ["web_search"], "mutated": False}))
    report = AsyncMock(side_effect=[("报告暂时失败", True), ("整理后的报告", False)])
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", report)

    result, _files = await scheduled._run_agent(user_a.id, "查天气", trial=False)

    assert result == "整理后的报告"
    execution.assert_awaited_once()
    assert report.await_count == 2


@pytest.mark.asyncio
async def test_execute_task_marks_last_run_failed_on_exception(monkeypatch, db, user_a):
    """一次性任务执行抛异常：last_run_at 已经被写了，但不能就这么在"失败"状态里
    永远卡住——必须标 last_run_failed，且不能被当成"已经跑过"删掉或永久拒绝重试。"""
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask

    task = ScheduledTask(
        user_id=user_a.id, name="会失败的任务", payload="占位",
        cron="@once:2099-01-01T00:00:00", channels="qq", delivery_targets=None,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    monkeypatch.setattr(scheduled, "_run_agent", AsyncMock(side_effect=RuntimeError("boom")))

    result = await scheduled.execute_task(task.id, is_trial=False)
    assert "错误" in result

    await db.refresh(task)
    assert task.last_run_failed is True
    assert task.last_run_at is not None   # 行还在，没被当成"已完成"删掉


@pytest.mark.asyncio
async def test_execute_task_allows_retry_after_previous_failure(monkeypatch, db, user_a):
    """失败过一次的一次性任务，必须还能再正式触发一次——不能被 last_run_at 永久挡住。"""
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask
    from app.core.tz import now_utc

    task = ScheduledTask(
        user_id=user_a.id, name="重试任务", payload="占位",
        cron="@once:2099-01-01T00:00:00", channels="qq", delivery_targets=None,
        last_run_at=now_utc(),
        last_run_failed=True,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    monkeypatch.setattr(scheduled, "_run_agent", AsyncMock(return_value=("正文", [])))
    monkeypatch.setattr(scheduled, "deliver_to_channels", AsyncMock(return_value={"QQ": "已发送"}))

    result = await scheduled.execute_task(task.id, is_trial=False)

    assert result == {"QQ": "已发送"}
    # 成功后一次性任务会被删除，查不到就是删成功了。
    from sqlalchemy import select
    row = (await db.execute(select(ScheduledTask).where(ScheduledTask.id == task.id))).scalars().first()
    assert row is None


@pytest.mark.asyncio
async def test_execute_task_still_blocks_when_last_run_succeeded_state(db, user_a):
    """last_run_at 非空且没标失败（正在跑/刚成功）时，仍然要拒绝重复的正式触发。"""
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask
    from app.core.tz import now_utc

    task = ScheduledTask(
        user_id=user_a.id, name="已在跑的任务", payload="占位",
        cron="@once:2099-01-01T00:00:00", channels="qq", delivery_targets=None,
        last_run_at=now_utc(), last_run_failed=False,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    result = await scheduled.execute_task(task.id, is_trial=False)
    assert result == {"错误": "一次性任务已经执行过或正在执行"}


@pytest.mark.asyncio
async def test_once_task_in_flight_when_redis_lock_held(db, user_a, monkeypatch):
    """Redis 锁还在 = 真的正在跑，不能被列表清理/GC 当成"过期没跑"或"崩了"清掉。"""
    import app.scheduled_tasks as scheduled
    from app.core.tz import now_utc

    async def fake_exists(key):
        assert key == scheduled._scheduled_lock_key(999)
        return True

    monkeypatch.setattr("app.core.redis.get_redis", lambda: SimpleNamespace(exists=fake_exists))

    in_flight = await scheduled._once_task_is_in_flight(999, now_utc())
    assert in_flight is True


@pytest.mark.asyncio
async def test_once_task_not_in_flight_after_lock_expires_and_grace_passes(monkeypatch):
    """锁没了、last_run_at 也早就超过锁的 timeout：判定为不在跑（大概率是崩了），
    不再挡列表清理——调用方据此把它转成失败态，而不是当成"还在跑"一直悬着。"""
    import app.scheduled_tasks as scheduled
    from datetime import timedelta
    from app.core.tz import now_utc

    async def fake_exists(key):
        return False

    monkeypatch.setattr("app.core.redis.get_redis", lambda: SimpleNamespace(exists=fake_exists))

    long_ago = now_utc() - timedelta(seconds=scheduled._SCHEDULED_LOCK_TIMEOUT + 30)
    in_flight = await scheduled._once_task_is_in_flight(999, long_ago)
    assert in_flight is False


@pytest.mark.asyncio
async def test_once_task_in_flight_grace_window_after_lock_release(monkeypatch):
    """锁刚释放（执行刚结束），但还在锁 timeout 的宽限窗口内：不能立刻判定"不在跑"，
    避免执行结果还没来得及写 last_run_failed 的这一瞬间被误判成崩溃。"""
    import app.scheduled_tasks as scheduled
    from app.core.tz import now_utc

    async def fake_exists(key):
        return False

    monkeypatch.setattr("app.core.redis.get_redis", lambda: SimpleNamespace(exists=fake_exists))

    just_now = now_utc()
    in_flight = await scheduled._once_task_is_in_flight(999, just_now)
    assert in_flight is True


@pytest.mark.asyncio
async def test_run_now_uses_formal_execution_to_retry_failed_once_task(monkeypatch, db, user_a):
    """"立即运行"对已经失败过的一次性任务，必须走正式执行（is_trial=False），
    不然点了也不会清 last_run_failed、成功了也不会删任务——用户看起来毫无反应。"""
    import app.api.v1.scheduled_tasks as scheduled_api
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask
    from app.core.tz import now_utc

    task = ScheduledTask(
        user_id=user_a.id, name="失败过的一次性任务", payload="占位",
        cron="@once:2099-01-01T00:00:00", channels="qq", delivery_targets=None,
        last_run_at=now_utc(), last_run_failed=True,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    execute = AsyncMock(return_value={"QQ": "已发送"})
    monkeypatch.setattr(scheduled, "execute_task", execute)

    await scheduled_api.run_now(task.id, user_a, db)

    execute.assert_awaited_once_with(task.id, is_trial=False)


@pytest.mark.asyncio
async def test_run_now_uses_trial_for_normal_task(monkeypatch, db, user_a):
    """普通任务（没失败过/还没跑过）"立即运行"仍然是试运行，不写 last_run_at、
    不会因为这次点击就让任务被标记完成或删除。"""
    import app.api.v1.scheduled_tasks as scheduled_api
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask

    task = ScheduledTask(
        user_id=user_a.id, name="普通任务", payload="占位",
        cron="0 9 * * *", channels="web", delivery_targets=None,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    execute = AsyncMock(return_value={"网页通知": "已发送"})
    monkeypatch.setattr(scheduled, "execute_task", execute)

    await scheduled_api.run_now(task.id, user_a, db)

    execute.assert_awaited_once_with(task.id, is_trial=True)


@pytest.mark.asyncio
async def test_scheduled_report_failure_twice_falls_back_to_execution_text(monkeypatch, db, user_a):
    """report 重试后仍然失败：必须回退到已经成功的 execution 结果，不能把 report 的
    错误文案当正文发出去——`report_text or execution_text` 这种写法在 report_text 是
    错误提示（非空字符串）时会误判成"有内容"，优先把错误文案发给用户。"""
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=("查询结果", False, {"tool_names": ["web_search"], "mutated": False}))
    report = AsyncMock(side_effect=[("报告生成失败，请稍后重试", True), ("报告生成失败，请稍后重试", True)])
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", report)

    result, _files = await scheduled._run_agent(user_a.id, "查天气", trial=False)

    assert result == "查询结果"
    execution.assert_awaited_once()
    assert report.await_count == 2


@pytest.mark.asyncio
async def test_execute_task_renews_lock_for_long_running_task(monkeypatch, db, user_a):
    """任务执行时间超过一个续租周期：锁必须被 extend 续期，而不是放任它在任务还在跑
    的时候自然过期——否则 `_once_task_is_in_flight()` 会把仍在执行的任务误判成崩溃。"""
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask

    task = ScheduledTask(
        user_id=user_a.id, name="慢任务", payload="占位",
        cron="0 9 * * *", channels="web", delivery_targets=None,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    fake_lock = SimpleNamespace(
        acquire=AsyncMock(return_value=True),
        release=AsyncMock(),
        extend=AsyncMock(),
    )
    monkeypatch.setattr("app.core.redis.get_redis", lambda: SimpleNamespace(lock=lambda *a, **kw: fake_lock))
    monkeypatch.setattr(scheduled, "_SCHEDULED_LOCK_RENEW_INTERVAL", 0.01)

    async def slow_run_agent(*a, **kw):
        await asyncio.sleep(0.05)   # 跨越多个续租周期
        return "正文", []

    monkeypatch.setattr(scheduled, "_run_agent", slow_run_agent)
    monkeypatch.setattr(scheduled, "deliver_to_channels", AsyncMock(return_value={"网页通知": "已发送"}))

    result = await scheduled.execute_task(task.id, is_trial=True)

    assert result == {"网页通知": "已发送"}
    assert fake_lock.extend.await_count >= 1
    fake_lock.extend.assert_awaited_with(scheduled._SCHEDULED_LOCK_TIMEOUT, replace_ttl=True)
    fake_lock.release.assert_awaited_once()


@pytest.mark.asyncio
async def test_execute_task_stops_renewing_after_completion(monkeypatch, db, user_a):
    """任务结束后续租协程必须被取消——不能留着一个孤儿协程继续给已释放的锁 extend。"""
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask

    task = ScheduledTask(
        user_id=user_a.id, name="快任务", payload="占位",
        cron="0 9 * * *", channels="web", delivery_targets=None,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    fake_lock = SimpleNamespace(
        acquire=AsyncMock(return_value=True),
        release=AsyncMock(),
        extend=AsyncMock(),
    )
    monkeypatch.setattr("app.core.redis.get_redis", lambda: SimpleNamespace(lock=lambda *a, **kw: fake_lock))
    monkeypatch.setattr(scheduled, "_SCHEDULED_LOCK_RENEW_INTERVAL", 10)
    monkeypatch.setattr(scheduled, "_run_agent", AsyncMock(return_value=("正文", [])))
    monkeypatch.setattr(scheduled, "deliver_to_channels", AsyncMock(return_value={"网页通知": "已发送"}))

    await scheduled.execute_task(task.id, is_trial=True)
    await asyncio.sleep(0)   # 让被取消的续租任务有机会真正结束

    running = [t for t in asyncio.all_tasks() if t.get_coro().__qualname__ == "_renew_lock_periodically" and not t.done()]
    assert running == []
    fake_lock.extend.assert_not_awaited()


# ── PR #9 复审 P1-3 回归：自动标题 vs 手动改名竞态 ──────────────────────────

@pytest.mark.asyncio
async def test_auto_title_skipped_when_title_locked(monkeypatch, db, user_a):
    """P1-3：手动改名后 title_locked=True，_gen_title_bg 跳过——手动标题永远赢。

    复现：用户首轮消息触发 _schedule_title（异步启动 _gen_title_bg）→ 异步任务
    还没拿到 LLM 返回 → 用户手动 rename → 自动标题生成完成 → 若无 title_locked
    会无条件覆盖手动标题。
    """
    from app.models import ConversationSession
    from agent import runner

    sess = ConversationSession(
        user_id=user_a.id, title="临时标题", source="web",
        bot_id=None, chat_id=None, platform_user_id=None, chat_type=None,
    )
    db.add(sess)
    await db.commit()
    await db.refresh(sess)

    # mock LLM：返回会自动覆盖的标题
    async def fake_generate_title(user_msg, ai_reply, settings, use_anthropic):
        return "自动生成的标题"

    # 模拟"先生成标题，但 LLM 还在跑"：suspend 生成以确保 rename 先完成
    title_started = Mock()
    generated_title = "LLM_自动生成标题"
    async def slow_generate(user_msg, ai_reply, settings, use_anthropic):
        title_started()
        return generated_title
    monkeypatch.setattr("agent.gateway.web._generate_title", slow_generate)

    # 先模拟用户手动 rename（title_locked=True）
    sess.title = "用户手动改的标题"
    sess.title_locked = True
    await db.commit()

    # 然后 _gen_title_bg 跑
    from app.core.config import get_settings
    settings = get_settings()
    await runner._gen_title_bg(user_a.id, sess.id, "用户首轮", "咕咕首轮回复", settings, use_anthropic=False)

    # 验证：自动标题没覆盖手动标题
    await db.refresh(sess)
    assert sess.title == "用户手动改的标题", f"自动标题覆盖了手动标题：{sess.title!r}"
    assert sess.title_locked is True

    # 再跑一次也仍不覆盖（title_locked 永久生效）
    await runner._gen_title_bg(user_a.id, sess.id, "用户首轮", "咕咕首轮回复", settings, use_anthropic=False)
    await db.refresh(sess)
    assert sess.title == "用户手动改的标题"


@pytest.mark.asyncio
async def test_rename_session_api_sets_title_locked(monkeypatch, db, user_a):
    """P1-3：PATCH /sessions/{id} rename API 写 title_locked=True。"""
    from app.models import ConversationSession
    from app.api.v1.agent import rename_session
    from app.api.v1.agent import RenameSessionRequest

    sess = ConversationSession(
        user_id=user_a.id, title="旧标题", source="web",
        bot_id=None, chat_id=None, platform_user_id=None, chat_type=None,
    )
    db.add(sess)
    await db.commit()
    await db.refresh(sess)

    result = await rename_session(
        session_id=sess.id,
        body=RenameSessionRequest(title="用户改名"),
        current_user=user_a,
        db=db,
    )
    assert result["title"] == "用户改名"
    assert result["title_locked"] is True

    await db.refresh(sess)
    assert sess.title == "用户改名"
    assert sess.title_locked is True


@pytest.mark.asyncio
async def test_rename_session_rejects_empty_and_overlong(monkeypatch, db, user_a):
    """P1-3 + 基础校验：rename API 必须拒绝空标题和超长标题（之前已有，顺带回归）。"""
    import pytest
    from fastapi import HTTPException
    from app.models import ConversationSession
    from app.api.v1.agent import rename_session
    from app.api.v1.agent import RenameSessionRequest

    sess = ConversationSession(
        user_id=user_a.id, title="原", source="web",
        bot_id=None, chat_id=None, platform_user_id=None, chat_type=None,
    )
    db.add(sess)
    await db.commit()
    await db.refresh(sess)

    # 空
    with pytest.raises(HTTPException) as exc:
        await rename_session(sess.id, RenameSessionRequest(title=""), user_a, db)
    assert exc.value.status_code == 422

    # 纯空白
    with pytest.raises(HTTPException) as exc:
        await rename_session(sess.id, RenameSessionRequest(title="   "), user_a, db)
    assert exc.value.status_code == 422

    # 超长
    with pytest.raises(HTTPException) as exc:
        await rename_session(sess.id, RenameSessionRequest(title="x" * 301), user_a, db)
    assert exc.value.status_code == 422
