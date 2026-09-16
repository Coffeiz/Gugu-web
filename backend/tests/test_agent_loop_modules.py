"""agent/loop 模块纯单元测试（PRD-LLM-25 §3.1 / LLM25-005/006）。"""
from __future__ import annotations

import pytest

from agent.loop import rounds
from agent.loop.events import EventSequencer, artifact_sse
from agent.loop.models import PendingInteraction, RoundOutcome, RunState


MAX_ABS = 100


# ── rounds.round_budget_action ────────────────────────────────────────────────

def _budget(**overrides):
    kwargs = dict(
        round_number=1, verify_mode=False, task_rounds=0, verify_rounds=0,
        unlimited_mode=False, max_rounds=3, max_verify_rounds=2,
        max_absolute_rounds=MAX_ABS,
    )
    kwargs.update(overrides)
    return rounds.round_budget_action(**kwargs)


def test_absolute_limit_cannot_be_lifted_by_unlimited_mode():
    """FR-LLM25-008：绝对安全上限不受 unlimited 影响。"""
    assert _budget(round_number=100, unlimited_mode=True) is rounds.RoundBudgetAction.ABSOLUTE_LIMIT
    assert _budget(round_number=99, unlimited_mode=True) is rounds.RoundBudgetAction.CONTINUE


def test_task_limit_only_in_normal_mode():
    assert _budget(task_rounds=3) is rounds.RoundBudgetAction.TASK_LIMIT
    assert _budget(task_rounds=3, unlimited_mode=True) is rounds.RoundBudgetAction.CONTINUE
    assert _budget(task_rounds=2) is rounds.RoundBudgetAction.CONTINUE
    assert _budget(task_rounds=5, max_rounds=None) is rounds.RoundBudgetAction.CONTINUE


def test_verify_limit_has_independent_budget():
    assert _budget(verify_mode=True, verify_rounds=2) is rounds.RoundBudgetAction.VERIFY_LIMIT
    assert _budget(verify_mode=True, verify_rounds=2, unlimited_mode=True) is rounds.RoundBudgetAction.CONTINUE
    assert _budget(verify_mode=True, verify_rounds=5, max_verify_rounds=None) is rounds.RoundBudgetAction.CONTINUE
    # verify 与 task 计数互不干扰
    assert _budget(verify_mode=True, task_rounds=99, verify_rounds=0) is rounds.RoundBudgetAction.CONTINUE


# ── rounds.usage_compaction_due / overflow ───────────────────────────────────

def test_usage_compaction_due_matches_original_semantics():
    from agent.context.compress_conv import AUTO_COMPACTION_RATIO
    tokens = 1000
    threshold = int(tokens * AUTO_COMPACTION_RATIO)
    assert rounds.usage_compaction_due(run_context_usage=threshold, context_tokens=tokens, compaction_applied=False) is True
    assert rounds.usage_compaction_due(run_context_usage=threshold - 1, context_tokens=tokens, compaction_applied=False) is False
    # 已压缩过不再触发；context_tokens 缺失按 1 处理不会除零
    assert rounds.usage_compaction_due(run_context_usage=threshold, context_tokens=tokens, compaction_applied=True) is False
    assert rounds.usage_compaction_due(run_context_usage=10**9, context_tokens=0, compaction_applied=False) is True


def test_overflow_recovery_plan_is_single_shot():
    assert rounds.overflow_recovery_plan(hard_budget_retries=1, compaction_succeeded=True, fallback_succeeded=True).should_retry is False
    plan = rounds.overflow_recovery_plan(hard_budget_retries=0, compaction_succeeded=True, fallback_succeeded=False)
    assert plan.should_retry and plan.reason == "compaction"
    plan = rounds.overflow_recovery_plan(hard_budget_retries=0, compaction_succeeded=False, fallback_succeeded=True)
    assert plan.should_retry and plan.reason == "deterministic_fallback"
    plan = rounds.overflow_recovery_plan(hard_budget_retries=0, compaction_succeeded=False, fallback_succeeded=False)
    assert not plan.should_retry and plan.reason == "exhausted"


def test_retry_rounds_delta_by_mode():
    assert rounds.retry_rounds_delta(True) == (-1, 0)
    assert rounds.retry_rounds_delta(False) == (0, -1)


# ── models ────────────────────────────────────────────────────────────────────

def test_run_state_round_counter():
    state = RunState(run_id="run-x")
    assert state.round_number == 0
    assert state.next_round() == 1
    assert state.pending is None


def test_pending_interaction_replay_field():
    pending = PendingInteraction(prompt_id=1, tool_call_id="tc1", tool_name="delete_file",
                                 replay={"arguments": {"path": "a"}})
    assert pending.replay == {"arguments": {"path": "a"}}
    assert PendingInteraction(prompt_id=1, tool_call_id="t", tool_name="x").replay is None


def test_round_outcome_defaults():
    outcome = RoundOutcome()
    assert outcome.tool_calls == [] and outcome.stopped_reason is None


# ── events ────────────────────────────────────────────────────────────────────

def test_event_sequencer_monotonic_and_shape():
    seq = EventSequencer("run-abc", start=5)
    line = seq.next_event("round_start", round_id="round-1")
    assert seq.seq == 6
    assert '"seq": 6' in line and '"run_id": "run-abc"' in line and "round_start" in line
    assert seq.next_event("token", content="x").startswith("data: ")


def test_artifact_sse_routes_link_buttons_and_files():
    lb = artifact_sse({"kind": "link_buttons", "message": "m", "buttons": []})
    assert '"type": "link_buttons"' in lb
    file_evt = artifact_sse({"attach_id": "a1", "kind": "image"})
    assert '"type": "file"' in file_evt
