"""保护内联压缩后的保留窗口与后续请求缓存前缀。"""
from types import SimpleNamespace

import pytest

from agent.context.assembly import MessageArea
from agent.context.compaction import format_compacted_summary
from agent.loop.context_runtime import ContextRuntime
from agent.loop.models import RunState


def _runtime():
    area = MessageArea.from_canonical_messages([
        *[{"role": "user", "content": f"可压缩旧历史 {i}"} for i in range(12)],
        {"role": "user", "content": "上轮保留的问题"},
        {"role": "assistant", "content": "上轮保留的答复"},
        {"role": "user", "content": "当前用户原文"},
        {"role": "assistant", "content": "当前执行轮"},
    ])
    area.protected_history_start = 12
    state = RunState(run_id="synthetic-run", session_id=None)
    state.round_number = 2
    state.round_start_indices = [(1, 15), (2, 16)]
    state.run_context_usage = 118_000
    return ContextRuntime(
        messages=area, run_state=state,
        ai=SimpleNamespace(context_tokens=128_000, max_tokens=8_000),
        system_text="", session_id=None, run_start_index=14,
    )


@pytest.mark.asyncio
async def test_repeated_threshold_keeps_previous_run_window_without_rewriting_summary(monkeypatch):
    """压缩后新轮尚未越过保留窗口时，不再摘要受保护历史或改写缓存前缀。"""
    calls = []

    async def summary(*args, **kwargs):
        calls.append(True)
        return "已压缩的旧历史"

    monkeypatch.setattr("agent.context.compaction._generate_append_summary", summary)
    runtime = _runtime()
    assert await runtime.compact_now(keep_rounds=10, preserve_previous_run=True)
    first = runtime.messages.provider_projection().to_messages()
    runtime.messages.append({"role": "assistant", "content": "新增执行结果"})
    runtime.run_state.round_number = 3
    runtime.run_state.round_start_indices.append((3, len(runtime.messages.provider_projection())))

    assert not await runtime.compact_now(keep_rounds=10, preserve_previous_run=True)
    assert len(calls) == 1
    assert runtime.messages.provider_projection().to_messages() == [
        *first, {"role": "assistant", "content": "新增执行结果"},
    ]
    assert "上轮保留的问题" in str(first)
    assert "当前用户原文" in str(first)


@pytest.mark.asyncio
async def test_pressure_compacts_current_run_but_preserves_user_and_latest_tool_round(monkeypatch):
    """不足十轮的长任务也能压缩旧工具正文，最后用户原文和最新往返完整保留。"""
    async def summary(*args, **kwargs):
        return "任务目标与较早执行结果的摘要"

    monkeypatch.setattr("agent.context.compaction._generate_append_summary", summary)
    runtime = _runtime()
    current = {"role": "user", "content": "继续完成原任务，不要遗漏原始要求"}
    messages = [
        {"role": "user", "content": "上个 run 的大段结果" * 100}, current,
    ]
    for number in (1, 2):
        messages.extend([
            {"role": "assistant", "content": [{
                "type": "tool_call", "id": f"call-{number}", "name": "read_file",
                "arguments": {"file_id": number},
            }]},
            {"role": "user", "content": [{
                "type": "tool_result", "tool_call_id": f"call-{number}",
                "content": f"执行轮 {number} 正文" * 100,
            }]},
        ])
    runtime.messages = MessageArea.from_canonical_messages(messages)
    runtime.messages.protected_history_start = 0
    runtime.run_start_index = 1
    runtime.run_state.round_number = 3
    runtime.run_state.round_start_indices = [(1, 2), (2, 4), (3, 6)]

    assert await runtime.compact_after_usage_threshold()
    retained = runtime.messages.provider_projection().to_messages()
    assert current in retained
    assert "上个 run 的大段结果" not in str(retained)
    assert "执行轮 1 正文" not in str(retained)
    assert "执行轮 2 正文" in str(retained)
    assert retained[-2]["tool_calls"][0]["id"] == "call-2"
    assert retained[-1]["tool_call_id"] == "call-2"


@pytest.mark.asyncio
async def test_wire_cleanup_does_not_move_the_user_anchor_into_a_tool_round(monkeypatch):
    """出站清理删除旧孤儿调用后，保护索引仍按 Area 投影解释，摘要复用真实 wire。"""
    from agent.context.compaction import compact_context
    from agent.providers import adapter_for
    from agent.providers.message_utils import render_openai_request_history

    captured = []

    async def summary(history, *args, **kwargs):
        captured.extend(history)
        return "旧历史摘要"

    monkeypatch.setattr("agent.context.compaction._generate_append_summary", summary)
    current = {"role": "user", "content": "最后的真实用户请求"}
    area = MessageArea.from_canonical_messages([
        {"role": "user", "content": "旧历史"},
        {"role": "assistant", "content": [{
            "type": "tool_call", "id": "orphan", "name": "read_file", "arguments": {},
        }]},
        current,
        {"role": "assistant", "content": "最近完成的执行轮"},
    ])
    ai = SimpleNamespace(provider="deepseek", model="test-model", api_format="openai",
                         context_tokens=128_000, max_tokens=8_000)
    wire = render_openai_request_history(area.provider_projection(), adapter_for(ai))
    assert len(wire) < len(area.provider_projection())
    area.last_provider_projection = wire

    result = await compact_context(area, protected_from=3, protected_anchor_index=2, model_cfg=ai)

    assert result.changed
    assert result.messages[result.anchor_index] == current
    assert result.messages[result.protected_start_index]["content"] == "最近完成的执行轮"
    assert captured == wire.to_messages()


@pytest.mark.asyncio
async def test_threshold_without_compressible_history_does_not_use_overflow_truncation(monkeypatch):
    """90% 用量并非上游溢出；受保护窗口不能因本地估算偏高而被裁切。"""
    runtime = _runtime()
    runtime.messages = MessageArea.from_canonical_messages([
        {"role": "user", "content": format_compacted_summary("已有摘要")},
        {"role": "user", "content": "当前用户原文"},
        {"role": "assistant", "content": "保留结果" * 100},
    ])
    runtime.messages.protected_history_start = None
    runtime.run_start_index = 1
    runtime.run_state.round_start_indices = [(1, 2), (2, 3)]
    before = runtime.messages.provider_projection().to_messages()

    def forbidden(*args, **kwargs):
        pytest.fail("未收到 Provider overflow 时不能调用硬裁切")

    monkeypatch.setattr("agent.context.budget.enforce_provider_overflow_fallback", forbidden)
    assert not await runtime.compact_after_usage_threshold()
    assert runtime.messages.provider_projection().to_messages() == before
