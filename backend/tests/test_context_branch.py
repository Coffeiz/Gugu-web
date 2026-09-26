from types import SimpleNamespace

import pytest

from agent.context.branch import ContextBranch
from agent.context.branch_types import BranchInput, BranchPolicy
from agent.context import provider_runner


@pytest.mark.asyncio
async def test_context_branch_assembles_stable_order_and_json(monkeypatch):
    captured = {}

    async def fake_complete_json(system, user, settings, **kwargs):
        captured.update(system=system, user=user, kwargs=kwargs)
        return {"summary": "ok"}

    monkeypatch.setattr(provider_runner, "complete_json", fake_complete_json)
    result = await ContextBranch().run(
        BranchInput(
            stable_system="stable",
            scope="owner",
            delta="turn",
            session_id=7,
            run_id="run-test",
        ),
        BranchPolicy(name="reflection"),
        SimpleNamespace(),
    )

    assert result.ok is True
    assert captured["system"] == "stable"
    # scope/revision 只留审计元数据，绝不进入 provider user 正文
    assert captured["user"] == "turn"
    assert result.metadata["branch"] == "reflection"
    assert result.metadata["session_id"] == 7
    assert result.metadata["branch_mode"] == "append_reuse"


@pytest.mark.asyncio
async def test_context_branch_retries_empty_output(monkeypatch):
    calls = 0

    async def fake_complete_text(*args, **kwargs):
        nonlocal calls
        calls += 1
        return "" if calls == 1 else "done"

    monkeypatch.setattr(provider_runner, "complete_text", fake_complete_text)
    result = await ContextBranch().run(
        BranchInput(stable_system="stable", delta="turn"),
        BranchPolicy(name="compaction", output_mode="text", max_retries=1),
        SimpleNamespace(),
    )

    assert calls == 2
    assert result.ok is True
    assert result.output == "done"
    assert result.attempts == 2
    assert result.return_reason == "completed"


@pytest.mark.asyncio
async def test_context_branch_logs_correlated_provider_failure_without_exception_text(monkeypatch, caplog):
    captured = []

    class FakeProviderError(RuntimeError):
        status_code = 429

    async def fake_complete_json(*args, **kwargs):
        raise FakeProviderError("private response detail")

    monkeypatch.setattr(provider_runner, "complete_json", fake_complete_json)
    monkeypatch.setattr("agent.context.branch.diag_log", lambda where, exc: captured.append((where, exc)))
    caplog.set_level("WARNING", logger="agent.context.branch")
    result = await ContextBranch().run(
        BranchInput(stable_system="stable", run_id="im-reflection-job:42\nstatus=200"),
        BranchPolicy(name="reflection"),
        SimpleNamespace(),
    )

    assert result.ok is False
    assert result.output is None
    assert result.return_reason == "provider_error"
    assert captured[0][0] == (
        "agent.context.branch.provider branch=reflection "
        "run_id=im-reflection-job:42_status_200 attempt=1 status=429"
    )
    assert isinstance(captured[0][1], FakeProviderError)
    assert "[context-branch-provider-failed]" in caplog.text
    assert "run_id=im-reflection-job:42_status_200" in caplog.text
    assert "status=200 attempts" not in caplog.text
    assert "attempts=1" in caplog.text
    assert "error_type=FakeProviderError" in caplog.text
    assert "error_status=429" in caplog.text
    assert "private response detail" not in caplog.text


@pytest.mark.asyncio
async def test_context_branch_classifies_invalid_json_shape(monkeypatch):
    async def fake_complete_json(*args, **kwargs):
        return []

    monkeypatch.setattr(provider_runner, "complete_json", fake_complete_json)
    result = await ContextBranch().run(
        BranchInput(stable_system="stable"),
        BranchPolicy(name="reflection"),
        SimpleNamespace(),
    )

    assert result.ok is False
    assert result.return_reason == "schema_invalid"


@pytest.mark.asyncio
async def test_context_branch_classifies_blank_text_as_invalid(monkeypatch):
    async def fake_complete_text(*args, **kwargs):
        return "   "

    monkeypatch.setattr(provider_runner, "complete_text", fake_complete_text)
    result = await ContextBranch().run(
        BranchInput(stable_system="stable"),
        BranchPolicy(name="compaction", output_mode="text"),
        SimpleNamespace(),
    )

    assert result.ok is False
    assert result.output is None
    assert result.return_reason == "schema_invalid"


@pytest.mark.asyncio
async def test_provider_runner_text_errors_reach_context_branch(monkeypatch):
    async def raise_provider_error(*args, **kwargs):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr("agent.llm.llm_select.use_anthropic_for", lambda _ai: False)
    monkeypatch.setattr(provider_runner, "_openai", raise_provider_error)

    with pytest.raises(RuntimeError, match="provider unavailable"):
        await provider_runner.complete_text(
            "stable", "turn", SimpleNamespace(ai=SimpleNamespace()), 800,
        )


@pytest.mark.asyncio
async def test_json_branch_inherits_configured_thinking(monkeypatch):
    captured = {}

    async def fake_openai(*args, **kwargs):
        captured.update(kwargs)
        return '{"ok": true}'

    monkeypatch.setattr("agent.llm.llm_select.use_anthropic_for", lambda _ai: False)
    monkeypatch.setattr(provider_runner, "_openai", fake_openai)
    settings = SimpleNamespace(ai=SimpleNamespace(thinking="adaptive"))

    result = await provider_runner.complete_json("stable", "turn", settings)

    assert result == {"ok": True}
    assert captured["thinking"] == "adaptive"
    assert captured["json_mode"] is True


@pytest.mark.asyncio
async def test_text_branch_inherits_configured_thinking(monkeypatch):
    captured = {}

    async def fake_openai(*args, **kwargs):
        captured.update(kwargs)
        return "summary"

    monkeypatch.setattr("agent.llm.llm_select.use_anthropic_for", lambda _ai: False)
    monkeypatch.setattr(provider_runner, "_openai", fake_openai)
    settings = SimpleNamespace(ai=SimpleNamespace(thinking="disabled"))

    result = await provider_runner.complete_text("stable", "turn", settings)

    assert result == "summary"
    assert captured["thinking"] == "disabled"


@pytest.mark.asyncio
async def test_max_tokens_none_omits_budget_on_openai_path(monkeypatch):
    captured = {}

    async def fake_openai(*args, **kwargs):
        captured.update(kwargs)
        return '{"ok": true}'

    monkeypatch.setattr("agent.llm.llm_select.use_anthropic_for", lambda _ai: False)
    monkeypatch.setattr(provider_runner, "_openai", fake_openai)
    settings = SimpleNamespace(ai=SimpleNamespace())

    result = await provider_runner.complete_json("stable", "turn", settings, max_tokens=None)

    assert result == {"ok": True}
    assert "max_tokens" not in captured


@pytest.mark.asyncio
async def test_scope_revision_is_audit_only_and_preserves_prefix(monkeypatch):
    captured = []

    async def fake_complete_text(system, user, settings, max_tokens):
        captured.append(user)
        return "summary"

    monkeypatch.setattr(provider_runner, "complete_text", fake_complete_text)
    base = BranchInput(stable_system="stable", delta="same", scope="owner")
    revised = BranchInput(stable_system="stable", delta="same", scope="group", scope_revision="r2")
    first = await ContextBranch().run(base, BranchPolicy(name="compaction", output_mode="text"), SimpleNamespace())
    second = await ContextBranch().run(revised, BranchPolicy(name="compaction", output_mode="text"), SimpleNamespace())
    assert captured == ["same", "same"]
    assert first.input_fingerprint == second.input_fingerprint
    assert second.metadata["scope_revision"] == "r2"


@pytest.mark.asyncio
async def test_reflection_provider_usage_is_added_to_active_trace_without_prompt_text(monkeypatch):
    from agent.runtime.loopscope_trace import state

    async def fake_complete_messages(*args, usage_sink=None, **kwargs):
        usage_sink.append({
            "input": 20_000,
            "fresh_input": 2_000,
            "cache_read": 17_000,
            "cache_write": 1_000,
            "cache_ratio": 0.85,
        })
        return {"ok": True}

    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    monkeypatch.setattr(provider_runner, "complete_messages", fake_complete_messages)
    monkeypatch.setattr(
        "agent.context.cache_capability.record_reuse_outcome",
        lambda *args, **kwargs: None,
    )
    settings = SimpleNamespace(ai=SimpleNamespace(
        provider="minimax", model="MiniMax-M3", api_format="anthropic",
    ))
    run = state._ScopeRun(
        id="run-reflection-test",
        trace_id="trace-reflection-test",
        session_key="gugu:web:31",
        external_session_id="31",
        source="web",
        started_at=1.0,
    )
    token = state._scope_run.set(run)
    try:
        result = await ContextBranch().run(
            BranchInput(
                stable_system="私密 system 正文",
                delta="私密反思指令",
                session_id=31,
                run_id="run-origin-31",
                history_messages=({"role": "user", "content": "私密历史正文"},),
                cache_probe_context={
                    "reflection_scope": "owner",
                    "trigger_source": "idle",
                    "origin_run_id": "run-origin-31",
                    "origin_gap_seconds": 180.0,
                },
            ),
            BranchPolicy(name="reflection"),
            settings,
        )
    finally:
        state._scope_run.reset(token)

    assert result.ok is True
    span = next(item for item in run.spans if item.name == "Reflection cache observation")
    probe = span.input["reflection_cache_probe"]
    assert probe["reflection_scope"] == "owner"
    assert probe["cache_hit_ratio"] == 0.85
    assert probe["cache_read_tokens"] == 17_000
    assert probe["trigger_source"] == "idle"
    assert probe["origin_gap_seconds"] == 180.0
    assert "私密" not in repr(span.input)
