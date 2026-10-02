"""PRD-LLM-31 阶段 0：并发资格与 dispatch 上下文基线。"""
import asyncio
from types import SimpleNamespace

from agent.loop.tools import copy_skill_state_for_parallel, parallel_safe_batch
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
