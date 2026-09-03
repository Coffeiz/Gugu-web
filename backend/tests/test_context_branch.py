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
            baseline="base",
            scope="owner",
            dynamic_context="now",
            delta="turn",
            session_id=7,
            run_id="run-test",
        ),
        BranchPolicy(name="reflection"),
        SimpleNamespace(),
    )

    assert result.ok is True
    assert captured["system"] == "stable"
    assert captured["user"] == (
        "【baseline】\nbase\n\n【动态上下文】\nnow\n\n【本次增量】\nturn"
    )
    assert result.metadata["branch"] == "reflection"
    assert result.metadata["session_id"] == 7


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
async def test_context_branch_classifies_provider_error(monkeypatch):
    captured = []

    async def fake_complete_json(*args, **kwargs):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(provider_runner, "complete_json", fake_complete_json)
    monkeypatch.setattr("agent.context.branch.diag_log", lambda where, exc: captured.append((where, exc)))
    result = await ContextBranch().run(
        BranchInput(stable_system="stable"),
        BranchPolicy(name="reflection"),
        SimpleNamespace(),
    )

    assert result.ok is False
    assert result.output is None
    assert result.return_reason == "provider_error"
    assert captured[0][0] == "agent.context.branch.provider"
    assert isinstance(captured[0][1], RuntimeError)


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
