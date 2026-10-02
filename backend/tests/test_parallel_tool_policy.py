"""PRD-LLM-31 阶段 0：并发资格与 dispatch 上下文基线。"""
import asyncio
from types import SimpleNamespace

from agent.loop.tools import (
    copy_skill_state_for_parallel,
    parallel_safe_batch,
    prepare_parallel_batch,
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


def test_parallel_safe_is_explicit_and_rejects_mutating_or_interactive_tools():
    safe = _tool("safe_read", parallel_safe=True)
    snapshot = _snapshot(
        safe,
        _tool("unreviewed_read"),
        _tool("write_even_if_flagged", parallel_safe=True, mutates=True),
        _tool("confirmation", parallel_safe=True, requires_confirmation=True),
        _tool("mcp_read", parallel_safe=True, source="mcp"),
    )

    assert parallel_safe_batch([_call("safe_read"), _call("safe_read")], snapshot)
    assert not parallel_safe_batch(
        [_call("safe_read"), _call("unreviewed_read")], snapshot,
    ), "mutates=False 或工具名像只读都不能替代显式并发授权"
    assert not parallel_safe_batch(
        [_call("safe_read"), _call("write_even_if_flagged")], snapshot,
    )
    assert not parallel_safe_batch(
        [_call("safe_read"), _call("confirmation")], snapshot,
    )
    assert not parallel_safe_batch(
        [_call("safe_read"), _call("ask_user")], snapshot,
    )
    assert not parallel_safe_batch(
        [_call("safe_read"), _call("mcp_read")], snapshot,
    )
    assert not parallel_safe_batch([_call("safe_read")], snapshot)


def test_call_tool_eligibility_uses_resolved_target_not_adapter_metadata():
    snapshot = _snapshot(
        _tool("call_tool", parallel_safe=True),
        _tool("safe_read", parallel_safe=True),
        _tool("write", parallel_safe=False, mutates=True),
    )

    wrapped_safe = _call("call_tool", {"name": "safe_read", "arguments": {}})
    wrapped_write = _call("call_tool", {"name": "write", "arguments": {}})
    unknown = _call("call_tool", {"name": "missing", "arguments": {}})
    malformed = _call("call_tool", {"name": "safe_read", "arguments": []})

    assert parallel_safe_batch([wrapped_safe, _call("safe_read")], snapshot)
    assert not parallel_safe_batch([wrapped_write, _call("safe_read")], snapshot)
    assert not parallel_safe_batch([unknown, _call("safe_read")], snapshot)
    assert not parallel_safe_batch([malformed, _call("safe_read")], snapshot)
    assert not parallel_safe_batch(
        [_call("safe_read"), _call("safe_read", parse_error="截断")], snapshot,
    )


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


def test_parallel_safe_predicate_failure_falls_back_to_serial():
    def broken_predicate(_arguments):
        raise RuntimeError("参数不应进入可见诊断")

    snapshot = _snapshot(_tool(
        "conditional_read", parallel_safe=True, mutates_for_input=broken_predicate,
    ))

    assert not parallel_safe_batch(
        [_call("conditional_read"), _call("conditional_read")], snapshot,
    )


def test_parallel_preflight_validates_the_entire_batch_without_dispatching():
    safe = _tool(
        "safe_read",
        parallel_safe=True,
        input_schema={
            "type": "object",
            "properties": {"limit": {"type": "integer"}},
            "required": ["limit"],
            "additionalProperties": False,
        },
    )
    snapshot = _snapshot(safe)

    prepared = prepare_parallel_batch(
        [_call("safe_read", {"limit": "2"}), _call("safe_read", {"limit": 3})],
        snapshot,
    )
    invalid_batch = prepare_parallel_batch(
        [_call("safe_read", {"limit": 2}), _call("safe_read", {"limit": "not-a-number"})],
        snapshot,
    )

    assert prepared is not None
    assert [arguments for _call_item, _target, arguments in prepared] == [
        {"limit": 2}, {"limit": 3},
    ]
    assert invalid_batch is None, "单项 Schema 无效时整批必须回到原串行校验路径"


def test_parallel_execution_deployment_setting_defaults_to_serial():
    from app.core.config import AgentBehaviorSettings

    assert AgentBehaviorSettings().parallel_tool_execution_enabled is False


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
