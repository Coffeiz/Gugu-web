"""PRD-LLM-31 阶段 0：并发资格与 dispatch 上下文基线。"""
import asyncio
import json
from datetime import timedelta
from types import SimpleNamespace

import pytest

from app.core.tz import now_ctx
from agent.loop.tools import (
    copy_skill_state_for_parallel,
    partition_tool_calls,
)
from agent.loop.tool_scheduler import ParallelDispatchCancelled, run_parallel_dispatches
from agent.tools.base import Tool, current_dispatch_skill_state, set_dispatch_session, reset_dispatch_session


def _tool(name, **overrides):
    options = {
        "name": name,
        "description": "测试工具",
        "input_schema": {"type": "object", "properties": {}},
        "handler": lambda *_args: None,
    }
    options.update(overrides)
    return Tool(**options)


def _snapshot(*tools):
    by_name = {tool.name: tool for tool in tools}
    return SimpleNamespace(get=by_name.get)


def _call(name, arguments=None, *, parse_error=None):
    return SimpleNamespace(
        name=name,
        input=arguments if arguments is not None else {},
        parse_error=parse_error,
    )


def test_same_round_calls_follow_agent_batch_intent_not_mutation_metadata():
    snapshot = _snapshot(
        _tool("read", parallel_safe=False),
        _tool("write", parallel_safe=False, mutates=True),
        _tool("dangerous", destructive=True),
        _tool("confirmed", requires_confirmation=True),
        _tool("mcp_read", source="mcp"),
        _tool("shell", destructive=True,
              parallel_safe_for_input=lambda args: args.get("command") != "danger"),
    )
    calls = [
        _call("read"),
        _call("write"),
        _call("shell", {"command": "python --version"}),
        _call("shell", {"command": "danger"}),
        _call("confirmed"),
        _call("mcp_read"),
        _call("ask_user"),
    ]

    parallel, serial = partition_tool_calls(calls, snapshot)

    assert [index for index, *_ in parallel] == [0, 1, 2, 5]
    assert [index for index, _call_item in serial] == [3, 4, 6]
    assert parallel[1][2] == "write", "mutates/destructive 元数据不再做冲突推断"


def test_call_tool_and_invalid_schema_are_partitioned_per_call():
    snapshot = _snapshot(
        _tool("call_tool"),
        _tool("read", input_schema={
            "type": "object", "properties": {"limit": {"type": "integer"}},
            "required": ["limit"], "additionalProperties": False,
        }),
        _tool("write", mutates=True),
    )
    calls = [
        _call("call_tool", {"name": "write", "arguments": {}}),
        _call("read", {"limit": "bad"}),
        _call("write"),
        _call("call_tool", {"name": "missing", "arguments": {}}),
    ]

    parallel, serial = partition_tool_calls(calls, snapshot)

    assert [index for index, *_ in parallel] == [0, 1, 2]
    assert [index for index, _call_item in serial] == [3]
    assert parallel[1][1] is calls[1], "Schema 错误在 dispatch 内逐项返回，不阻塞同轮调用"


def test_parallel_dispatch_inherits_context_but_receives_isolated_skill_state():
    async def scenario():
        shared_state = {"notes": "digest-a"}
        token = set_dispatch_session(12, object(), "run-test", object(), shared_state)
        try:
            async def child_state():
                return current_dispatch_skill_state()

            inherited = await asyncio.create_task(child_state())
            first = copy_skill_state_for_parallel(inherited)
            second = copy_skill_state_for_parallel(inherited)
            assert inherited is shared_state, "asyncio task inherits ContextVar value by reference"
            assert first == second == shared_state
            assert first is not shared_state and second is not shared_state and first is not second
            first["notes"] = "digest-b"
            assert shared_state["notes"] == "digest-a"
            assert second["notes"] == "digest-a"
        finally:
            reset_dispatch_session(token)

    asyncio.run(scenario())


def test_shell_confirmation_predicate_failure_isolated_to_that_call():
    def broken_predicate(_arguments):
        raise RuntimeError("参数不应进入可见诊断")

    parallel, serial = partition_tool_calls(
        [_call("conditional_read", {"command": "danger"}), _call("other")],
        _snapshot(
            _tool("conditional_read", destructive=True, parallel_safe_for_input=broken_predicate),
            _tool("other"),
        ),
    )
    assert [index for index, *_ in parallel] == [1]
    assert [index for index, _call_item in serial] == [0]


def test_shell_confirmation_gate_is_per_call_and_does_not_block_peer_tools():
    from agent.tools import registry

    snapshot = registry.snapshot()
    shell = snapshot.get("shell")
    assert shell.parallel_safe_for_input({"command": "pwd"}) is True
    assert shell.parallel_safe_for_input({"command": "mkdir newdir"}) is True
    assert shell.parallel_safe_for_input({"command": "printf ok > result.txt"}) is False
    assert shell.parallel_safe_for_input({"command": "rm -rf result.txt"}) is False
    parallel, serial = partition_tool_calls(
        [
            _call("shell", {"command": "python --version"}),
            _call("shell", {"command": "date"}),
            _call("shell", {"command": "rm -rf result.txt"}),
            _call("get_current_time"),
        ],
        snapshot,
    )
    assert [index for index, *_ in parallel] == [0, 1, 3]
    assert [index for index, _call_item in serial] == [2]


def test_batch_observation_contains_only_bounded_aggregate_fields(caplog):
    from agent.loop.machine import _log_tool_batch_observation

    with caplog.at_level("INFO", logger="agent.traj"):
        _log_tool_batch_observation(
            {
                "mode": "parallel",
                "calls": 2,
                "isolated_invalid": 1,
                "reason": "eligible_batch",
                "query": "must not enter logs",
            },
        )

    record = json.loads(caplog.records[-1].message)
    assert record == {
        "t": "loop",
        "event": "tool_batch",
        "mode": "parallel",
        "calls": 2,
        "isolated_invalid": 1,
        "reason": "eligible_batch",
    }
    assert not {"user", "run", "tool", "args", "url", "query"}.intersection(record)


async def test_agent_selected_mutating_shell_calls_overlap_with_stable_results():
    calls = [
        _call("shell", {"command": f"check-{index}"})
        for index in range(5)
    ]
    parallel, serial = partition_tool_calls(calls, _snapshot(_tool(
        "shell", mutates=True, destructive=True,
        parallel_safe_for_input=lambda _args: True,
    )))
    assert not serial
    active = 0
    max_active = 0
    started = 0
    all_started = asyncio.Event()

    async def dispatch(call):
        nonlocal active, max_active, started
        active += 1
        started += 1
        max_active = max(max_active, active)
        if started == 5:
            all_started.set()
        try:
            await asyncio.wait_for(all_started.wait(), timeout=2)
            return call[3]["command"]
        finally:
            active -= 1

    results = await run_parallel_dispatches(parallel, dispatch, max_concurrency=5)
    assert max_active == 5
    assert results == [f"check-{index}" for index in range(5)]


async def test_phase2_project_and_calendar_reads_preserve_user_scope(db, user_a, user_b):
    from agent.tools.calendar import _create_event, _list_events
    from agent.tools.overview import _get_dashboard_stats, _get_upcoming
    from agent.tools.projects import _create_project, _get_project, _list_projects

    today = now_ctx().date()
    tomorrow = (today + timedelta(days=1)).isoformat()
    next_week = (today + timedelta(days=7)).isoformat()

    project_a = await _create_project(db, user_a.id, {
        "project_name": "用户甲项目", "status": "active",
        "start_date": today.isoformat(), "deadline": next_week,
    })
    project_b = await _create_project(db, user_b.id, {
        "project_name": "用户乙项目", "status": "pending",
        "start_date": today.isoformat(), "deadline": next_week,
    })
    event_a = await _create_event(db, user_a.id, {
        "title": "用户甲活动", "date": tomorrow, "all_day": True,
    })
    event_b = await _create_event(db, user_b.id, {
        "title": "用户乙活动", "date": tomorrow, "all_day": True,
    })
    assert project_a["success"] and project_b["success"]
    assert event_a["success"] and event_b["success"]

    projects_a = await _list_projects(db, user_a.id, {})
    projects_b = await _list_projects(db, user_b.id, {})
    assert [item["name"] for item in projects_a] == ["用户甲项目"]
    assert [item["name"] for item in projects_b] == ["用户乙项目"]
    assert "项目不存在" in json.loads(await _get_project(
        db, user_a.id, {"project_id": project_b["project_id"]},
    ))["error"]

    events_a = await _list_events(db, user_a.id, {})
    events_b = await _list_events(db, user_b.id, {})
    assert [item["title"] for item in events_a] == ["用户甲活动"]
    assert [item["title"] for item in events_b] == ["用户乙活动"]

    stats_a = await _get_dashboard_stats(db, user_a.id, {})
    stats_b = await _get_dashboard_stats(db, user_b.id, {})
    assert stats_a["projects"]["total"] == 1 and stats_a["upcoming_events"] == 1
    assert stats_b["projects"]["total"] == 1 and stats_b["upcoming_events"] == 1
    upcoming_a = await _get_upcoming(db, user_a.id, {"days": 30})
    upcoming_b = await _get_upcoming(db, user_b.id, {"days": 30})
    assert {item["title"] for item in upcoming_a["items"]} == {"用户甲项目", "用户甲活动"}
    assert {item["title"] for item in upcoming_b["items"]} == {"用户乙项目", "用户乙活动"}


def test_parallel_execution_deployment_setting_can_explicitly_disable_parallelism():
    from app.core.config import AgentBehaviorSettings

    assert AgentBehaviorSettings(parallel_tool_execution_enabled=False).parallel_tool_execution_enabled is False


def test_parallel_dispatch_is_bounded_ordered_and_isolates_one_failure():
    async def scenario():
        active = 0
        max_active = 0
        started = []
        completed = []
        release = asyncio.Event()

        async def dispatch(call_id):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            started.append(call_id)
            if len(started) == 2:
                release.set()
            try:
                await asyncio.wait_for(release.wait(), timeout=1)
                await asyncio.sleep((2 - call_id) * 0.01)
                completed.append(call_id)
                if call_id == 1:
                    raise RuntimeError("single read failure")
                return call_id
            finally:
                active -= 1

        results = await run_parallel_dispatches([0, 1, 2], dispatch, max_concurrency=2)

        assert max_active == 2, "调度器必须受单批并发上限约束"
        assert started == [0, 1, 2]
        assert completed == [1, 0, 2], "完成顺序可以不同于输入顺序"
        assert results[0] == 0 and isinstance(results[1], RuntimeError) and results[2] == 2

    asyncio.run(scenario())


def test_parallel_dispatch_cancellation_cancels_and_awaits_children():
    async def scenario():
        started = 0
        all_started = asyncio.Event()
        cleaned = []
        never = asyncio.Event()

        async def dispatch(call_id):
            nonlocal started
            started += 1
            if started == 2:
                all_started.set()
            try:
                await never.wait()
            finally:
                cleaned.append(call_id)

        task = asyncio.create_task(run_parallel_dispatches([1, 2, 3], dispatch))
        await asyncio.wait_for(all_started.wait(), timeout=1)
        task.cancel()
        try:
            await task
        except ParallelDispatchCancelled as exc:
            assert isinstance(exc.results[0], asyncio.CancelledError)
            assert isinstance(exc.results[1], asyncio.CancelledError)
            assert isinstance(exc.results[2], asyncio.CancelledError)
        else:
            raise AssertionError("取消必须向调用方传播")

        assert sorted(cleaned) == [1, 2, 3], "取消返回前必须等待所有已启动 dispatch 清理完毕"

    asyncio.run(scenario())


def test_parallel_cancellation_keeps_completed_results_and_marks_pending_calls():
    async def scenario():
        started = 0
        all_started = asyncio.Event()
        completed = asyncio.Event()
        never = asyncio.Event()

        async def dispatch(call_id):
            nonlocal started
            started += 1
            if started == 3:
                all_started.set()
            await all_started.wait()
            if call_id == "completed":
                completed.set()
                return "actual result"
            await never.wait()

        task = asyncio.create_task(
            run_parallel_dispatches(["completed", "pending-a", "pending-b"], dispatch),
        )
        await asyncio.wait_for(completed.wait(), timeout=1)
        await asyncio.sleep(0)
        task.cancel()
        try:
            await task
        except ParallelDispatchCancelled as exc:
            assert exc.results[0] == "actual result"
            assert all(isinstance(item, asyncio.CancelledError) for item in exc.results[1:])
        else:
            raise AssertionError("批次取消必须携带部分结果并停止后续处理")

    asyncio.run(scenario())


def test_parallel_cancellation_does_not_start_a_later_batch():
    async def scenario():
        started = []
        batch_started = asyncio.Event()
        never = asyncio.Event()

        async def dispatch(call_id):
            started.append(call_id)
            if len(started) == 2:
                batch_started.set()
            await never.wait()

        task = asyncio.create_task(
            run_parallel_dispatches(list(range(6)), dispatch, max_concurrency=2),
        )
        await asyncio.wait_for(batch_started.wait(), timeout=1)
        task.cancel()
        with pytest.raises(ParallelDispatchCancelled):
            await task
        assert started == [0, 1]

    asyncio.run(scenario())


def test_parallel_dispatch_starts_following_batch_only_after_prior_batch_finishes():
    async def scenario():
        active = 0
        max_active = 0

        async def dispatch(call_id):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await asyncio.sleep(0.01)
            active -= 1
            return call_id

        results = await run_parallel_dispatches(list(range(7)), dispatch, max_concurrency=3)

        assert results == list(range(7))
        assert max_active == 3

    asyncio.run(scenario())
