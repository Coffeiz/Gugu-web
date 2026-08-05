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
