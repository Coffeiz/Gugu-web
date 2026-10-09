"""LoopScope 跨进程 trace 恢复回归测试。"""

from types import SimpleNamespace

from agent.context import builder, session_system
from agent.runtime.loopscope_trace import state
from agent.runtime.loopscope_trace.context import install_context_hooks, record_shell_prompt_sources
from agent.runtime.loopscope_trace.hooks import _argument_shape


def test_restore_trace_recreates_pending_run(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    token = state._scope_run.set(None)
    try:
        trace_id = state.restore_trace("qq-trace")
        run = state._scope_run.get()
        assert trace_id == "qq-trace"
        assert run is not None
        assert run.trace_id == "qq-trace"
        assert run.session_key == "pending:qq-trace"
        assert run.source == "unknown"
    finally:
        state._scope_run.reset(token)


def test_tool_schema_error_span_keeps_schema_and_redacts_argument_values(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = state._ScopeRun(
        id="run-schema-error", trace_id="trace-schema-error",
        session_key="gugu:web:test", external_session_id="test",
        source="web", started_at=state._now(),
    )
    token = state._scope_run.set(run)
    try:
        state.record_tool_schema_error(
            run,
            tool_name="create_skill",
            schema={
                "type": "object",
                "required": ["name"],
                "properties": {"name": {"type": "string"}},
            },
            error={"issues": [{"path": "name", "rule": "required"}]},
            error_kind="validation_error",
            arguments_shape=_argument_shape({"name": "用户正文"}),
        )
    finally:
        state._scope_run.reset(token)

    assert len(run.spans) == 1
    span = run.spans[0]
    assert span.attributes["context_source"] == "tool_schema_error"
    assert span.input["schema"]["required"] == ["name"]
    assert span.input["arguments_shape"] == {"name": "string"}
    assert "用户正文" not in repr(span.input)
    assert span.status == "error"


def test_shell_prompt_sources_record_stable_and_dynamic_parts(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = state._ScopeRun(
        id="run-shell-prompt", trace_id="trace-shell-prompt",
        session_key="gugu:web:test", external_session_id="test",
        source="web", started_at=state._now(),
    )
    token = state._scope_run.set(run)
    try:
        record_shell_prompt_sources("## 本轮 Shell 权限状态（动态）", code_target=record_shell_prompt_sources)
    finally:
        state._scope_run.reset(token)

    assert [span.name for span in run.pending_context_spans] == ["shell.md", "Shell permission prompt"]
    stable, dynamic = run.pending_context_spans
    assert stable.kind == "file"
    assert stable.attributes["context_source"] == "shell_policy"
    assert stable.attributes["role"] == "stable_protocol"
    assert "# Shell 安全协议" in stable.output["content"]
    assert dynamic.kind == "context"
    assert dynamic.attributes["role"] == "dynamic_permissions"
    assert dynamic.output["content"] == "## 本轮 Shell 权限状态（动态）"


def test_context_builder_span_measures_only_prompt_assembly(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    context_builder = SimpleNamespace(
        build_split=builder.build_split,
        _PROMPTS_DIR=session_system._PROMPTS_DIR,
        _STATUS_ZH=builder._STATUS_ZH,
        _files_block=lambda files, _names: builder._files_block(files),
        _memory_block=builder._memory_block,
        _style_block=session_system._style_block,
        _skills_index_block=session_system._skills_index_block,
    )
    install_context_hooks(SimpleNamespace(), context_builder)
    run = state._ScopeRun(
        id="run-context-builder", trace_id="trace-context-builder",
        session_key="gugu:web:test", external_session_id="test",
        source="web", started_at=state._now(),
    )
    token = state._scope_run.set(run)
    try:
        context_builder.build_split("default", "合成用户", [], [])
    finally:
        state._scope_run.reset(token)

    spans = [span for span in run.pending_context_spans if span.name == "Context assembly & prompt"]
    assert len(spans) == 1
    span = spans[0]
    assert span.attributes["phase"] == "build_split"
    assert span.input == {
        "prompt_name": "default",
        "project_count": 0,
        "event_count": 0,
        "skill_count": 0,
        "knowledge_count": 0,
    }
    assert span.duration_ms is not None and span.duration_ms >= 0
