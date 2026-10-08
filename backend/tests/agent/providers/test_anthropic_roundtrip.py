import json
from contextvars import copy_context
from types import SimpleNamespace

import pytest

from app.core.errors import RetryableError
from agent.context.assembly import MessageArea
from agent.context.provider_conversation import ProviderConversation
from agent.context.canonical_tool_history import canonical_tool_round
from agent.context.history import _anthropic_history_blocks
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


@pytest.mark.asyncio
async def test_restored_tool_rows_keep_signed_thinking_in_next_run_request(db, user_a, monkeypatch):
    """工具落库再恢复为 row envelope 后，下一 run 仍回传每轮签名且不污染 canonical。"""
    from sqlalchemy import select

    from agent import providers
    from agent.context.message_area_repository import restore_entries
    from agent.llm import llm_select
    from app.models import ConversationMessage, ConversationSession

    session = ConversationSession(user_id=user_a.id, title="历史工具续接测试")
    db.add(session)
    await db.flush()
    db.add(ConversationMessage(session_id=session.id, role="user", content="检查工具契约"))
    driver = AnthropicDriver()
    state_ctx = SimpleNamespace(history_thinking_by_tool_id={}, persisted_tail_blocks=None)
    expected_blocks = {}
    for index in range(2):
        call = NormalizedToolCall(f"call-{index}", "get_tool_schema", {"tools": ["get_project"]})
        thinking = [{"type": "thinking", "thinking": f"检查步骤 {index}", "signature": f"sig-{index}"}]
        expected_blocks[call.id] = thinking
        result = RoundResult(text="", tool_calls=[call], raw=thinking + [{
            "type": "tool_use", "id": call.id, "name": call.name, "input": call.input,
        }])
        state = driver.extract_provider_state(result, ctx=state_ctx)
        for message in canonical_tool_round(result, [(call, "测试工具结果")]):
            db.add(ConversationMessage(
                session_id=session.id, role=message["role"], content="", content_json=message["content"],
            ))
    await db.commit()
    rows = (await db.execute(select(ConversationMessage).where(
        ConversationMessage.session_id == session.id,
    ).order_by(ConversationMessage.id))).scalars().all()
    area = restore_entries(rows)
    area.configure_request(fixed_prefix=[], render_options={"api_format": "anthropic"})
    area.append({"role": "user", "content": "继续检查"})
    before = area.snapshot().digest
    adapter = SimpleNamespace(
        name="minimax", api_format="anthropic", render_history=lambda value: value.provider_projection(),
        build_anthropic_thinking_params=lambda _: {}, build_anthropic_generation_params=lambda _: {},
    )
    monkeypatch.setattr(providers, "adapter_for", lambda _: adapter)
    monkeypatch.setattr(providers, "build_anthropic_client", lambda *_: object())
    monkeypatch.setattr(llm_select, "supports_anthropic_active_cache", lambda _: False)
    client, ctx = driver.prepare(
        [], SimpleNamespace(model="test-model", max_tokens=32), area, "测试前缀",
        tool_snapshot=SimpleNamespace(anthropic_schemas=lambda _: []),
    )
    state["payload"]["history_thinking_by_tool_id"]["removed-call"] = [{
        "type": "thinking", "thinking": "已被压缩的调用", "signature": "removed-signature",
    }]
    assert driver.restore_provider_state(ctx, state["payload"])
    captured = {}

    async def stream(_client, kwargs, _adapter):
        captured.update(kwargs)
        yield "final", SimpleNamespace(
            content=[{"type": "text", "text": "完成"}],
            usage=SimpleNamespace(input_tokens=10, output_tokens=1,
                                  cache_read_input_tokens=0, cache_creation_input_tokens=0),
        )

    events = [event async for event in driver.run_round(client, ctx, area, stream_round=stream)]
    assert events[-1][0] == "done"
    assistants = [message for message in captured["messages"] if message["role"] == "assistant"]
    assert len(assistants) == 2
    for index, message in enumerate(assistants):
        assert message["content"] == expected_blocks[f"call-{index}"] + [{
            "type": "tool_use", "id": f"call-{index}", "name": "get_tool_schema",
            "input": {"tools": ["get_project"]},
        }]
    assert "removed-call" not in ctx.history_thinking_by_tool_id
    assert area.snapshot().digest == before
    assert all(block["type"] not in {"thinking", "redacted_thinking"}
               for row in rows for block in (row.content_json or []))


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments", [
    {"max_results": 15, "query": "测试记录", "filters": {"z": None, "a": [1, {"z": 2, "a": 3}]}},
    {},
])
async def test_anthropic_tool_input_keeps_wire_order_after_persistence(arguments):
    """真实驱动解析→canonical 保存→对象键重排→回放，工具 input 序列化保持一致。"""
    driver = AnthropicDriver()
    ctx = SimpleNamespace(
        model="test-model", max_tokens=32, tools=[], system_param="",
        thinking_param={}, generation_param={}, supports_active_cache=False,
        adapter=SimpleNamespace(render_history=lambda value: value.provider_projection()),
    )

    async def response(_client, _kwargs, _adapter):
        yield "final", SimpleNamespace(
            content=[{"type": "tool_use", "id": "test-call", "name": "search", "input": arguments}],
            usage=SimpleNamespace(input_tokens=1, output_tokens=1),
        )

    events = [event async for event in driver.run_round(
        object(), ctx, MessageArea.from_canonical_messages([{"role": "user", "content": "测试"}]), stream_round=response,
    )]
    result = events[-1][1]
    dispatched = [(result.tool_calls[0], "测试结果")]
    live = driver.build_tool_round(result, dispatched)
    canonical = canonical_tool_round(result, dispatched)
    # JSONB 不承诺键序；模拟持久化层对所有对象键进行重新排列。
    persisted = json.loads(json.dumps(canonical, ensure_ascii=False, sort_keys=True))
    replay = _anthropic_history_blocks(persisted[0]["content"])

    assert json.dumps(replay[0]["input"], ensure_ascii=False) == json.dumps(
        live[0]["content"][0]["input"], ensure_ascii=False,
    )
    assert replay[0]["input"] == arguments


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
    assert messages[1]["content"] == [{
        "type": "tool_result", "tool_use_id": "call-1", "content": "ok",
    }]


def test_anthropic_error_tool_result_matches_canonical_error_state():
    """实时工具轮和 canonical 回放都应保留相同的错误标记及正文。"""
    call = NormalizedToolCall("call-1", "grep", {"path": "relative/path"})
    error_content = json.dumps({"error": "path 必须使用逻辑路径"}, ensure_ascii=False)
    result = RoundResult(
        text="",
        tool_calls=[call],
        requires_tools=True,
        raw=[{"type": "tool_use", "id": "call-1", "name": "grep", "input": call.input}],
    )

    provider_messages = AnthropicDriver().build_tool_round(result, [(call, error_content)])
    canonical_messages = canonical_tool_round(result, [(call, error_content)])
    provider_result = provider_messages[1]["content"][0]
    canonical_result = canonical_messages[1]["content"][0]

    assert provider_result == {
        "type": "tool_result", "tool_use_id": "call-1",
        "content": error_content, "is_error": True,
    }
    assert canonical_result["content"] == error_content
    assert canonical_result["is_error"] is provider_result["is_error"] is True


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


def test_anthropic_structure_probe_requires_provider_projection(monkeypatch):
    from agent.runtime.loopscope_trace.state import record_anthropic_structure_probe

    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = _ScopeRun(
        id="run-anthropic-projection-boundary", trace_id="trace-projection-boundary",
        session_key="gugu:web:projection-boundary", external_session_id="projection-boundary",
        source="web", started_at=_now(),
    )
    token = _scope_run.set(run)
    try:
        record_anthropic_structure_probe(
            provider="anthropic", model="test-model",
            response_blocks=[{"type": "text", "text": "private"}],
            provider_conversation=[{"role": "assistant", "content": []}],
        )
        assert "anthropic_structure_probe" not in run.attributes

        record_anthropic_structure_probe(
            provider="anthropic", model="test-model",
            response_blocks=[{"type": "text", "text": "private"}],
            provider_conversation=ProviderConversation([
                {"role": "assistant", "content": [{"type": "text", "text": "private"}]},
            ]),
        )
    finally:
        _scope_run.reset(token)

    summary = run.attributes["anthropic_structure_probe"]["last"]
    assert summary["assistant_roundtrip_same"] is True
    assert "private" not in repr(summary)


def test_anthropic_request_failure_trace_records_structure_without_payload(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = _ScopeRun(
        id="run-test-provider-request-failure", trace_id="trace-test",
        session_key="gugu:web:test-session", external_session_id="test-session",
        source="web", started_at=_now(),
    )
    messages = ProviderConversation([
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
    ], area_revision=3, area_digest="a" * 64, area_entry_count=3)

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
            projection=messages,
        )
    finally:
        _scope_run.reset(token)

    diagnostic = run.attributes["provider_request_failures"]["last"]
    assert diagnostic["error_status"] == 400
    assert diagnostic["error_type"] == "invalid_request_error"
    assert diagnostic["provider_code"] == "2013"
    assert diagnostic["restored_state"]["insert_index"] == 3
    assert diagnostic["provider_projection"]["area_revision"] == 3
    assert diagnostic["provider_projection"]["area_digest"] == "a" * 64
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


def test_anthropic_request_failure_trace_unwraps_retry_error_without_recording_body(monkeypatch):
    """重试耗尽后仍保留上游状态码/错误码，避免只记录外层 RetryableError。"""
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = _ScopeRun(
        id="run-test-wrapped-provider-error", trace_id="trace-test",
        session_key="gugu:web:test-session", external_session_id="test-session",
        source="web", started_at=_now(),
    )
    messages = ProviderConversation([{"role": "user", "content": "private input"}])

    class ProviderError(Exception):
        status_code = 500
        type = "api_error"
        message = "upstream failure (2001)"
        body = {"error": {"type": "api_error", "code": "2001", "message": "private response"}}

    wrapped = RetryableError(
        "llm.stream_exhausted", "provider retry exhausted",
        cause=ProviderError("private response"), attempt=5,
    )
    token = _scope_run.set(run)
    try:
        record_anthropic_request_failure(
            provider="minimax", model="MiniMax-M3", messages=messages,
            error=wrapped, projection=messages,
        )
    finally:
        _scope_run.reset(token)

    diagnostic = run.attributes["provider_request_failures"]["last"]
    assert diagnostic["error_status"] == 500
    assert diagnostic["error_type"] == "api_error"
    assert diagnostic["provider_code"] == "2001"
    assert diagnostic["wrapper_error_type"] == "RetryableError"
    assert diagnostic["retry_attempt"] == 5
    serialized = json.dumps(diagnostic, ensure_ascii=False)
    assert "private response" not in serialized
    assert "private input" not in serialized


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
            render_history=lambda value: value.provider_projection(),
        ),
    )
    messages = MessageArea.from_canonical_messages([{
        "role": "user", "content": [{"type": "text", "text": "private user prompt"}],
    }])

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
    assert diagnostic["provider_projection"]["wire_digest"]
    assert diagnostic["provider_projection"]["message_count"] == 1
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
            render_history=lambda value: value.provider_projection(),
        ),
    )
    messages = MessageArea.from_canonical_messages([
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
