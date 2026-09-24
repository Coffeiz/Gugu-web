import json
from contextvars import copy_context
from types import SimpleNamespace

import pytest

from agent.context.assembly import PromptMessages
from agent.context.canonical_tool_history import canonical_tool_round
from agent.loop_drivers import AnthropicDriver, NormalizedToolCall, RoundResult
from agent.runtime.loopscope_trace.state import (
    _ScopeRun,
    _anthropic_structure,
    _now,
    _scope_run,
    activate_llm_span,
    deactivate_llm_span,
    record_anthropic_request_failure,
)


def test_anthropic_tool_round_preserves_all_response_blocks_and_signature():
    call = NormalizedToolCall("call-1", "calendar_list", {"date": "2026-09-01"})
    result = RoundResult(
        text="查一下",
        tool_calls=[call],
        requires_tools=True,
        raw=[
            {"type": "thinking", "thinking": "内部思考", "signature": "sig-1"},
            {"type": "text", "text": "查一下"},
            {"type": "tool_use", "id": "call-1", "name": "calendar_list", "input": {"date": "2026-09-01"}},
        ],
    )
    driver = AnthropicDriver()
    messages = driver.build_tool_round(result, [(call, "ok")])

    assert messages[0]["content"] == result.raw
    assert messages[0]["content"][0]["type"] == "thinking"
    assert messages[0]["content"][0]["signature"] == "sig-1"
    assert messages[0]["content"][2]["type"] == "tool_use"


def test_deactivate_llm_span_ignores_late_async_generator_context():
    """异步生成器延迟 aclose 到其他 Context 时不能产生未捕获异常。"""
    span = SimpleNamespace()
    token = activate_llm_span(span)
    try:
        copy_context().run(deactivate_llm_span, token)
    finally:
        deactivate_llm_span(token)


def test_anthropic_tool_round_drops_unprocessed_parallel_tool_uses():
    """确认门中断并行批次时，assistant/tool_result 必须保持严格配对。"""
    first = NormalizedToolCall("call-1", "delete_one", {})
    second = NormalizedToolCall("call-2", "delete_two", {})
    result = RoundResult(
        text="删除两个任务",
        tool_calls=[first, second],
        requires_tools=True,
        raw=[
            {"type": "text", "text": "删除两个任务"},
            {"type": "tool_use", "id": first.id, "name": first.name, "input": first.input},
            {"type": "tool_use", "id": second.id, "name": second.name, "input": second.input},
        ],
    )
    dispatched = [(first, '{"status":"waiting_input"}')]

    messages = AnthropicDriver().build_tool_round(result, dispatched)

    assert [block["id"] for block in messages[0]["content"] if block["type"] == "tool_use"] == ["call-1"]
    assert [block["tool_use_id"] for block in messages[1]["content"]] == ["call-1"]

    canonical = canonical_tool_round(result, dispatched)
    assert [block["id"] for block in canonical[0]["content"] if block["type"] == "tool_call"] == ["call-1"]
    assert [block["tool_call_id"] for block in canonical[1]["content"]] == ["call-1"]


def test_anthropic_structure_probe_contains_only_safe_structure_and_digest():
    blocks = [
        {"type": "thinking", "thinking": "不要出现在探针", "signature": "sig-1"},
        {"type": "text", "text": "不要出现在探针"},
        {"type": "tool_use", "id": "call-1", "name": "calendar_list", "input": {"date": "2026-09-01"}},
    ]
    summary, digest = _anthropic_structure(blocks)

    assert summary == {
        "blocks": ["thinking", "text", "tool_use"],
        "has_signature": True,
        "tool_names": ["calendar_list"],
        "response_digest": digest,
    }
    assert "thinking" not in summary
    assert "不要出现在探针" not in summary


def test_anthropic_structure_digest_detects_non_identical_roundtrip():
    original = [{"type": "thinking", "thinking": "a", "signature": "sig"}]
    changed = [{"type": "thinking", "thinking": "b", "signature": "sig"}]
    assert _anthropic_structure(original)[1] != _anthropic_structure(changed)[1]


def test_anthropic_request_failure_trace_records_structure_without_payload(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = _ScopeRun(
        id="run-test-provider-request-failure", trace_id="trace-test",
        session_key="gugu:web:test-session", external_session_id="test-session",
        source="web", started_at=_now(),
    )
    messages = [
        {"role": "assistant", "content": [{
            "type": "tool_use", "id": "private-call-id", "name": "test_tool",
            "input": {"secret": "must-not-be-recorded"},
        }]},
        {"role": "user", "content": [{
            "type": "tool_result", "tool_use_id": "private-call-id",
            "content": "private result body",
        }]},
        {"role": "assistant", "content": [{
            "type": "tool_use", "id": "private-call-id", "name": "test_tool", "input": {},
        }]},
        {"role": "user", "content": "private user text"},
    ]

    class ProviderError(Exception):
        status_code = 400
        type = "invalid_request_error"
        message = "invalid params (2013)"

    token = _scope_run.set(run)
    try:
        record_anthropic_request_failure(
            provider="minimax", model="MiniMax-M3", messages=messages,
            error=ProviderError("must-not-be-recorded"),
            restored_blocks=[{
                "type": "tool_use", "id": "private-call-id", "name": "test_tool",
                "input": {"secret": "must-not-be-recorded"},
            }],
            restored_insert_index=3,
            canonical_digest="a" * 64,
            wire_digest="b" * 64,
        )
    finally:
        _scope_run.reset(token)

    diagnostic = run.attributes["provider_request_failures"]["last"]
    assert diagnostic["error_status"] == 400
    assert diagnostic["error_type"] == "invalid_request_error"
    assert diagnostic["provider_code"] == "2013"
    assert diagnostic["restored_state"]["insert_index"] == 3
    restored_tool = diagnostic["restored_state"]["blocks"][0]
    assert restored_tool["type"] == "tool_use"
    assert restored_tool["tool_id_fp"] == diagnostic["tool_pairing"]["tool_uses"][0]["tool_id_fp"]
    assert restored_tool["tool_name_present"] is True
    assert diagnostic["tool_pairing"]["tool_uses"][0]["duplicate_id"] is True
    assert diagnostic["tool_pairing"]["tool_uses"][0]["immediate_result"] is False
    assert diagnostic["tool_pairing"]["tool_results"][0]["follows_matching_tool_use"] is True

    serialized = json.dumps(diagnostic, ensure_ascii=False)
    for private_value in (
        "private-call-id", "private user text", "private result body",
        "must-not-be-recorded",
    ):
        assert private_value not in serialized


@pytest.mark.asyncio
async def test_anthropic_driver_records_failure_trace_only_when_scoped(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = _ScopeRun(
        id="run-test-provider-request-failure", trace_id="trace-test",
        session_key="gugu:web:test-session", external_session_id="test-session",
        source="web", started_at=_now(),
    )

    class ProviderError(Exception):
        status_code = 400
        type = "invalid_request_error"

        @property
        def message(self):
            return "invalid request (2013)"

    async def failing_stream(_client, _kwargs, _adapter):
        raise ProviderError("private provider detail")
        yield  # pragma: no cover - makes this an async generator

    ctx = SimpleNamespace(
        model="MiniMax-M3", max_tokens=32, tools=[], system_param="",
        thinking_param={}, generation_param={}, supports_active_cache=False,
        adapter=SimpleNamespace(
            name="minimax", api_format="anthropic",
            render_history=lambda value: list(value),
        ),
    )
    messages = [{
        "role": "user", "content": [{"type": "text", "text": "private user prompt"}],
    }]

    token = _scope_run.set(run)
    try:
        with pytest.raises(ProviderError):
            async for _ in AnthropicDriver().run_round(
                object(), ctx, messages, stream_round=failing_stream,
            ):
                pass
    finally:
        _scope_run.reset(token)

    diagnostic = run.attributes["provider_request_failures"]["last"]
    assert diagnostic["provider"] == "minimax"
    assert diagnostic["protocol"] == "anthropic"
    assert diagnostic["error_status"] == 400
    assert diagnostic["provider_code"] == "2013"
    assert diagnostic["canonical_history_digest"]
    assert diagnostic["rendered_history_digest"]
    serialized = json.dumps(diagnostic, ensure_ascii=False)
    assert "private user prompt" not in serialized
    assert "private provider detail" not in serialized


@pytest.mark.asyncio
async def test_anthropic_driver_records_final_cached_request_structure(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = _ScopeRun(
        id="run-test-final-anthropic-request", trace_id="trace-test",
        session_key="gugu:web:test-session", external_session_id="test-session",
        source="web", started_at=_now(),
    )
    span = run.span("llm", "LLM round 1", {"assembly": {"cache": {}}})
    captured = {}

    async def successful_stream(_client, kwargs, _adapter):
        captured.update(kwargs)
        yield ("final", SimpleNamespace(
            content=[{"type": "text", "text": "完成"}],
            usage=SimpleNamespace(
                input_tokens=10, output_tokens=1,
                cache_read_input_tokens=0, cache_creation_input_tokens=0,
            ),
        ))

    restored = [{
        "type": "thinking", "thinking": "不可写入 trace 的状态正文",
        "signature": "sig-private",
    }]
    ctx = SimpleNamespace(
        model="MiniMax-M3", max_tokens=32, tools=[], system_param=[{
            "type": "text", "text": "不可写入 trace 的 system 正文",
            "cache_control": {"type": "ephemeral"},
        }],
        thinking_param={}, generation_param={}, supports_active_cache=True,
        restored_blocks=restored,
        adapter=SimpleNamespace(
            name="minimax", api_format="anthropic",
            render_history=lambda value: value,
        ),
    )
    messages = PromptMessages([
        {"role": "user", "content": "历史用户消息"},
        {"role": "assistant", "content": "历史回复"},
        {"role": "user", "content": "本轮问题"},
    ])

    run_token = _scope_run.set(run)
    span_token = activate_llm_span(span)
    try:
        result = [item async for item in AnthropicDriver().run_round(
            object(), ctx, messages, stream_round=successful_stream,
        )]
    finally:
        deactivate_llm_span(span_token)
        _scope_run.reset(run_token)

    assert result[-1][0] == "done"
    actual = span.input["assembly"]["cache"]["actual_request"]
    assert actual["restored_state"]["insert_index"] == 2
    assert actual["restored_state"]["block_count"] == 1
    assert actual["restored_state"]["digest"]
    assert actual["cache"]["cache_anchor_indices"] == [0, 3]
    assert actual["cache"]["cache_control_message_indices"] == [0, 3]
    assert actual["system"]["cache_control_block_indices"] == [0]
    assert actual["message_count"] == len(captured["messages"]) == 4
    serialized = json.dumps(actual, ensure_ascii=False)
    assert "不可写入 trace 的状态正文" not in serialized
    assert "不可写入 trace 的 system 正文" not in serialized
    assert "sig-private" not in serialized
