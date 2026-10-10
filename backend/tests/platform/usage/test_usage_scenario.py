"""用量场景打标回归：ContextBranch 分支调用按场景落库，主链路保持 chat。"""
import asyncio
from types import SimpleNamespace

import pytest

from agent.context.branch import ContextBranch
from agent.context.branch_types import BranchInput, BranchPolicy
from agent.context import provider_runner
from agent.llm import modelctx
from agent import usage as usage_mod


@pytest.mark.asyncio
async def test_branch_tags_scenario_and_restores(monkeypatch):
    seen = {}

    async def fake_complete_json(system, user, settings, **kwargs):
        seen["during"] = modelctx.get_usage_context().scenario
        return {"summary": "ok"}

    monkeypatch.setattr(provider_runner, "complete_json", fake_complete_json)
    modelctx.set_usage_context("user-1", 7, scenario="chat")
    result = await ContextBranch().run(
        BranchInput(stable_system="stable", delta="turn", session_id=7),
        BranchPolicy(name="reflection"),
        SimpleNamespace(),
    )
    assert result.ok is True
    assert seen["during"] == "reflection"
    assert modelctx.get_usage_context().scenario == "chat"


@pytest.mark.asyncio
async def test_branch_keeps_none_context_when_unbound(monkeypatch):
    async def fake_complete_json(*args, **kwargs):
        return {"summary": "ok"}

    monkeypatch.setattr(provider_runner, "complete_json", fake_complete_json)
    assert modelctx.get_usage_context() is None
    result = await ContextBranch().run(
        BranchInput(stable_system="stable", delta="turn"),
        BranchPolicy(name="compaction"),
        SimpleNamespace(),
    )
    assert result.ok is True
    assert modelctx.get_usage_context() is None


@pytest.mark.asyncio
async def test_record_current_usage_passes_context_scenario(monkeypatch):
    captured = {}

    async def fake_record(user_id, settings, model_cfg, **kwargs):
        captured.update(user_id=user_id, **kwargs)

    monkeypatch.setattr(usage_mod, "record_usage", fake_record)
    modelctx.set_usage_context("user-1", None, scenario="reflection")
    await usage_mod.record_current_usage(
        SimpleNamespace(), SimpleNamespace(model="m", provider="p", is_byok=False),
        {"input": 10, "output": 5, "cache_read": 4, "cache_write": 0},
    )
    assert captured["user_id"] == "user-1"
    assert captured["scenario"] == "reflection"
    assert captured["session_id"] is None


def test_usage_context_defaults_to_chat():
    ctx = modelctx.UsageContext(user_id="user-1")
    assert ctx.scenario == "chat"
    assert modelctx.set_usage_context and callable(modelctx.set_usage_context)


def test_record_usage_writes_scenario_column():
    from app.models import AgentUsage

    col = AgentUsage.__table__.c.scenario
    assert col.nullable is False
    assert col.default.arg == "chat"
    assert col.server_default.arg == "chat"
