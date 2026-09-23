"""agent/loop 模块纯单元测试（PRD-LLM-25 §3.1 / LLM25-005/006）。"""
from __future__ import annotations

import pytest

from agent.loop import rounds
from agent.loop.events import EventSequencer, artifact_sse
from agent.loop.models import PendingInteraction, RoundOutcome, RunState


# ── rounds.usage_compaction_due / overflow ───────────────────────────────────

def test_usage_compaction_due_uses_threshold_and_no_progress_guard():
    from agent.context.compress_conv import AUTO_COMPACTION_RATIO
    tokens = 1000
    threshold = int(tokens * AUTO_COMPACTION_RATIO)
    assert rounds.usage_compaction_due(run_context_usage=threshold, context_tokens=tokens) is True
    assert rounds.usage_compaction_due(run_context_usage=threshold - 1, context_tokens=tokens) is False
    # 同一未变化 history 的失败尝试不会重复触发；新消息到来后调用方解除阻断。
    assert rounds.usage_compaction_due(run_context_usage=threshold, context_tokens=tokens, no_progress=True) is False
    assert rounds.usage_compaction_due(run_context_usage=threshold, context_tokens=tokens, no_progress=False) is True
    # context_tokens 缺失按 1 处理不会除零
    assert rounds.usage_compaction_due(run_context_usage=10**9, context_tokens=0) is True


def test_rolling_compaction_window_keeps_last_ten_completed_rounds():
    starts = [(number, number * 10) for number in range(1, 14)]

    # 第 13 轮响应后尚未入 history，最近 10 个完整轮为第 3 至第 12 轮。
    assert rounds.rolling_compaction_start_index(starts, current_round=13) == 30
    assert rounds.rolling_compaction_start_index(starts, current_round=6) == 10


def test_round_start_indices_follow_the_actually_retained_suffix():
    starts = [(number, number * 10) for number in range(1, 14)]

    assert rounds.remap_round_start_indices(starts, 5, 70) == [
        (7, 5), (8, 15), (9, 25), (10, 35), (11, 45), (12, 55), (13, 65),
    ]


def test_overflow_recovery_plan_is_single_shot():
    assert rounds.overflow_recovery_plan(hard_budget_retries=1, compaction_succeeded=True, fallback_succeeded=True).should_retry is False
    plan = rounds.overflow_recovery_plan(hard_budget_retries=0, compaction_succeeded=True, fallback_succeeded=False)
    assert plan.should_retry and plan.reason == "compaction"
    plan = rounds.overflow_recovery_plan(hard_budget_retries=0, compaction_succeeded=False, fallback_succeeded=True)
    assert plan.should_retry and plan.reason == "deterministic_fallback"
    plan = rounds.overflow_recovery_plan(hard_budget_retries=0, compaction_succeeded=False, fallback_succeeded=False)
    assert not plan.should_retry and plan.reason == "exhausted"


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


# ── loop.interactions.classify_interaction_answer（LLM25-010/011）────────────

from agent.loop.interactions import classify_interaction_answer


def test_classifier_user_cancel_is_normal_close():
    assert classify_interaction_answer({"status": "cancelled", "option_id": "cancel"}) == "user_cancelled"


def test_classifier_aborted_without_option_id():
    """IM/Web 侧关单不带 option_id：异常终止，不是用户主动取消。"""
    assert classify_interaction_answer({"status": "cancelled"}) == "aborted"


def test_classifier_expired_and_resume_and_resolved():
    assert classify_interaction_answer(None) == "expired"
    assert classify_interaction_answer({"option_id": "continue"}) == "resolved"
    assert classify_interaction_answer({"option_id": "goal"}) == "resolved"
    assert classify_interaction_answer({"option_id": "answer", "text": "x"}) == "resolved"
    assert classify_interaction_answer("文本回答") == "resolved"


def test_watchdog_round_summary_is_structured_and_does_not_log_tool_values(caplog):
    """循环诊断要能串起工具轮次，但不能把参数正文带进可见轨迹。"""
    import json
    import logging
    from types import SimpleNamespace

    from agent.loop import watchdog

    call = SimpleNamespace(name="shell", input={"command": "cat secret-token.txt", "cwd": "."})
    with caplog.at_level(logging.INFO, logger="agent.traj"):
        watchdog.record_round_result(
            run_id="run-test",
            round_number=7,
            tool_calls=[call],
            requires_tools=True,
            verify_mode=False,
            goal_mode=False,
            task_rounds=7,
            verify_rounds=0,
            tool_calls_used=6,
        )

    record = json.loads(caplog.records[-1].message)
    assert record["t"] == "loop"
    assert record["event"] == "round_result"
    assert record["run"] == "run-test"
    assert record["tools"] == ["shell"]
    assert record["tool_input_fp"]
    assert "secret-token.txt" not in caplog.records[-1].message
    assert "cat secret-token.txt" not in caplog.records[-1].message


def test_watchdog_does_not_echo_polluted_tool_name(caplog):
    import logging

    from agent.loop import watchdog

    with caplog.at_level(logging.INFO, logger="agent.traj"):
        watchdog.record_round_result(
            run_id="run-test",
            round_number=1,
            tool_calls=[type("Call", (), {"name": 'shell<正文泄漏>', "input": {}})()],
            requires_tools=True,
            verify_mode=False,
            goal_mode=False,
            task_rounds=1,
            verify_rounds=0,
            tool_calls_used=1,
        )

    assert "正文泄漏" not in caplog.records[-1].message
    assert '"tool_count":1' in caplog.records[-1].message
