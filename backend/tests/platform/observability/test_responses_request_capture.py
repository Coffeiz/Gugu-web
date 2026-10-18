"""失败轮捕获必须保存发送边界的 reasoning，且不能泄露凭据或触发工具重跑。"""
import copy
import json
import sqlite3
import sys
from types import SimpleNamespace

import pytest

from agent.context.assembly import MessageArea
from agent.providers.errors import ResponsesStreamError
from agent.providers.openai_responses import OpenAIResponsesDriver, _ResponsesCtx
from agent.providers.base import ResponsesInputCapabilities
from agent.runtime.loopscope_trace import state
from agent.runtime.loopscope_trace.provider_request import record_failed_responses_request


@pytest.fixture
def traced_round(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    monkeypatch.setattr(state, "_queue_snapshot", lambda *_args: None)
    monkeypatch.setattr("app.core.redaction.diag_log_raw", lambda *_args: None)
    run = state._ScopeRun("run-synthetic", "trace-synthetic", "synthetic", "synthetic", "web", state._now())
    parent = run.span("llm", "LLM round 2", {"messages": []})
    token = state.activate_llm_span(parent)
    try:
        yield run, parent
    finally:
        state.deactivate_llm_span(token)


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["success", "failed", "stream_error", "create_error"])
async def test_driver_failure_captures_exact_reasoning_request_and_success_does_not(traced_round, case):
    run, parent = traced_round
    requests = []

    class Stream:
        closed = False

        def __aiter__(self):
            return self.events()

        async def events(self):
            if case == "stream_error":
                raise ConnectionError("合成断流")
            failed = case == "failed"
            data = {"id": "response-synthetic", "status": "failed" if failed else "completed",
                    "output": [], "error": {"code": "internal_error", "message": "合成错误"} if failed else None}
            yield SimpleNamespace(type="response.failed" if failed else "response.completed", response=data)

        async def close(self):
            self.closed = True

    stream = Stream()

    async def create(**request):
        requests.append(copy.deepcopy(request))
        if case == "create_error":
            raise ValueError("合成请求拒绝")
        return stream

    adapter = SimpleNamespace(
        render_history=lambda area: area.provider_projection(),
        responses_input_capabilities=lambda _ai: ResponsesInputCapabilities(),
        build_responses_reasoning_params=lambda _ai: {},
    )
    ai = SimpleNamespace(model="synthetic-model", api_key="synthetic-private-provider-key")
    ctx = _ResponsesCtx([], 100, ai.model, "合成指令", adapter, ai, reasoning_replay_enabled=True,
                        reasoning_items=[{"id": "reason-synthetic", "type": "reasoning", "status": "completed",
                                          "summary": [], "content": [{"type": "reasoning_text", "text": "合成分析"}]}])
    area = MessageArea.from_canonical_messages([
        {"role": "user", "content": "合成任务"},
        {"role": "assistant", "content": [{"type": "tool_call", "id": "call-synthetic", "name": "shell", "arguments": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_call_id": "call-synthetic", "content": "合成成功结果"}]},
    ])

    async def consume():
        return [event async for event in OpenAIResponsesDriver().run_round(
            SimpleNamespace(responses=SimpleNamespace(create=create)), ctx, area,
        )]

    if case != "success":
        with pytest.raises({"failed": ResponsesStreamError, "stream_error": ConnectionError, "create_error": ValueError}[case]):
            await consume()
        captured = run.snapshot()["spans"][1]
        assert captured["parent_span_id"] == parent.id
        capture = captured["input"]["provider_request_capture"]
        assert capture["replayable"] is True
        assert json.loads(capture["request_json"]) == requests[0]
        assert capture["reasoning_item_count"] == 1
        assert "synthetic-private-provider-key" not in json.dumps(captured)
        ctx.reasoning_items.clear()
        requests[0]["input"].clear()
        assert json.loads(capture["request_json"])["input"]
    else:
        result = await consume()
        assert result[-1][0] == "done"
        assert len(run.spans) == 1
    assert len(requests) == 1
    assert stream.closed is (case != "create_error")


@pytest.mark.parametrize("sensitive_input", [
    [{"role": "user", "content": "synthetic-private-provider-key"}],
    [{"type": "function_call", "arguments": '{"headers":{"Authorization":"synthetic-tool-credential"}}'}],
    [{"type": "function_call", "arguments": '{"password":"synthetic-password"}'}],
])
def test_sensitive_request_is_explicitly_unavailable_instead_of_redacted_replay(traced_round, sensitive_input):
    run, _ = traced_round
    record_failed_responses_request(
        {"model": "synthetic-model", "input": sensitive_input}, failure_kind="response_failed",
        ai=SimpleNamespace(api_key="synthetic-private-provider-key"),
    )
    capture = run.spans[-1].input["provider_request_capture"]
    assert capture == {"protocol": "responses", "failure_kind": "response_failed",
                       "replayable": False, "unavailable_reason": "credential_detected"}


def test_create_failure_capture_keeps_error_classification_without_exception_text(traced_round):
    run, _ = traced_round

    class SyntheticProviderError(RuntimeError):
        status_code = 503
        code = "internal_error"
        request_id = "req-synthetic-503"

    try:
        try:
            raise TimeoutError("synthetic-private-response-body")
        except TimeoutError as cause:
            raise SyntheticProviderError("synthetic-private-error-message") from cause
    except SyntheticProviderError as error:
        record_failed_responses_request(
            {"model": "synthetic-model", "input": []}, failure_kind="create_exhausted",
            ai=SimpleNamespace(api_key=""), error=error,
        )

    capture = run.spans[-1].input["provider_request_capture"]
    assert capture["exception_chain"] == [
        {"type": "SyntheticProviderError", "status_code": 503,
         "code": "internal_error", "request_id": "req-synthetic-503"},
        {"type": "TimeoutError"},
    ]
    serialized = json.dumps(capture)
    assert "synthetic-private-error-message" not in serialized
    assert "synthetic-private-response-body" not in serialized


@pytest.mark.parametrize("damage", [None, "tampered", "missing"])
def test_capture_can_roundtrip_through_trace_database_without_provider_call(traced_round, tmp_path, monkeypatch, capsys, damage):
    from scripts.diagnostics.probe_saved_provider_request import main

    run, _ = traced_round
    request = {"model": "synthetic-model", "stream": True, "input": [
        {"role": "user", "content": "合成任务"},
        {"type": "function_call", "name": "ask_user", "arguments": '{"authorization":"user_sandbox"}'},
    ],
               "tools": [{"type": "function", "name": "configure", "parameters": {
                   "properties": {"api_key": {"type": "string"}}, "type": "object"}}]}
    record_failed_responses_request(request, failure_kind="response_failed", ai=SimpleNamespace(api_key=""))
    expected = run.spans[-1].input["provider_request_capture"]
    assert expected["replayable"]
    assert json.loads(expected["request_json"]) == request
    path = tmp_path / "trace.db"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE spans(id TEXT, run_id TEXT, parent_span_id TEXT, kind TEXT, name TEXT, input_json TEXT)")
        for span in run.snapshot()["spans"]:
            if span["kind"] == "context":
                if damage == "missing":
                    continue
                if damage == "tampered":
                    saved = span["input"]["provider_request_capture"]
                    saved["request_json"] = saved["request_json"].replace("合成任务", "篡改任务")
            db.execute("INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?)",
                       (span["id"], run.id, span["parent_span_id"], span["kind"], span["name"], json.dumps(span["input"])))
    monkeypatch.setattr(sys, "argv", ["probe", "--allow-real-data", "--dry-run", "--trace-db", str(path),
                                    "--run-id", run.id, "--round", "2", "--protocol", "responses"])
    monkeypatch.setattr("app.core.config.get_settings", lambda: pytest.fail("dry-run 不得读取运行配置或调用 provider"))
    if damage:
        with pytest.raises(SystemExit) as error:
            main()
        assert error.value.code == 2
        diagnostic = capsys.readouterr().err
        assert ("摘要不匹配" if damage == "tampered" else "拒绝退回历史重建") in diagnostic
        return
    main()
    result = json.loads(capsys.readouterr().out)
    assert result["dry_run"] and result["request_digest"] == expected["request_digest"]


@pytest.mark.parametrize("disabled", [True, False])
def test_capture_does_not_add_spans_when_disabled_or_round_has_ended(traced_round, monkeypatch, disabled):
    run, parent = traced_round
    if disabled:
        monkeypatch.setenv("LOOPSCOPE_ENABLED", "0")
    else:
        parent.finish({})
    record_failed_responses_request({"model": "synthetic-model", "input": []},
                                    failure_kind="response_failed", ai=SimpleNamespace(api_key=""))
    assert len(run.spans) == 1


def test_client_configuration_is_never_saved_in_trace(traced_round):
    run, _ = traced_round
    record_failed_responses_request(
        {"model": "synthetic-model", "input": [], "extra_headers": {"X-Custom": "synthetic-secret"}},
        failure_kind="create_rejected", ai=SimpleNamespace(api_key=""),
    )
    capture = run.spans[-1].input["provider_request_capture"]
    assert capture["replayable"] is False
    assert "synthetic-secret" not in json.dumps(run.snapshot())
