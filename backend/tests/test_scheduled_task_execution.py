from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_scheduled_execution_always_uses_full_loop(monkeypatch, db, user_a):
    """创建任务不再调用 LLM 选择工具，执行阶段直接使用完整工具集。"""
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=("执行结果", False, {"tool_names": [], "mutated": False}))
    report = AsyncMock()
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", report)

    result = await scheduled._run_agent(user_a.id, "测试任务", trial=True)

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

    result = await scheduled._run_agent(user_a.id, "查资料", trial=True)

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

    result = await scheduled._run_agent(user_a.id, "修改文件", trial=False)

    assert result == "写入后模型失败"
    execution.assert_awaited_once()


@pytest.mark.asyncio
async def test_scheduled_report_failure_retries_report_only(monkeypatch, db, user_a):
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=("查询结果", False, {"tool_names": ["web_search"], "mutated": False}))
    report = AsyncMock(side_effect=[("报告暂时失败", True), ("整理后的报告", False)])
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", report)

    result = await scheduled._run_agent(user_a.id, "查天气", trial=False)

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

    monkeypatch.setattr(scheduled, "_run_agent", AsyncMock(return_value="正文"))
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
async def test_scheduled_report_failure_twice_falls_back_to_execution_text(monkeypatch, db, user_a):
    """report 重试后仍然失败：必须回退到已经成功的 execution 结果，不能把 report 的
    错误文案当正文发出去——`report_text or execution_text` 这种写法在 report_text 是
    错误提示（非空字符串）时会误判成"有内容"，优先把错误文案发给用户。"""
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=("查询结果", False, {"tool_names": ["web_search"], "mutated": False}))
    report = AsyncMock(side_effect=[("报告生成失败，请稍后重试", True), ("报告生成失败，请稍后重试", True)])
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)
    monkeypatch.setattr("agent.runner.run_scheduled_report", report)

    result = await scheduled._run_agent(user_a.id, "查天气", trial=False)

    assert result == "查询结果"
    execution.assert_awaited_once()
    assert report.await_count == 2
