"""保护当前群聊回复契约：直接回复可用，选择静默后不可逆。"""
import asyncio

import pytest

from agent.im.auto_reply.decision import (
    GROUP_NO_REPLY_TOOL,
    ReplyChoice,
    ReplyGate,
    build_group_reply_decision_tool,
    gate_call_violation_reason,
    should_enable_group_reply_gate,
    tool_batch_allowed,
)


def test_pending_gate_allows_normal_reply_and_business_tools():
    gate = ReplyGate()
    assert gate.may_reply
    assert tool_batch_allowed(gate, ["read_file"])
    assert tool_batch_allowed(gate, ["read_file", "web_search"])


def test_explicit_silence_is_irreversible_and_blocks_later_tools():
    gate = ReplyGate()
    gate.decline()
    assert gate.choice is ReplyChoice.SILENT
    assert not gate.may_reply
    assert not tool_batch_allowed(gate, ["read_file"])
    assert gate_call_violation_reason(gate, "read_file")


def test_no_reply_tool_accepts_only_empty_arguments():
    gate = ReplyGate()
    tool = build_group_reply_decision_tool(gate)
    result = asyncio.run(tool.handler(None, None, {}))
    assert result["selected"] == "silent"
    assert gate.choice is ReplyChoice.SILENT

    gate = ReplyGate()
    tool = build_group_reply_decision_tool(gate)
    with pytest.raises(ValueError):
        asyncio.run(tool.handler(None, None, {"should_reply": True}))
    assert gate.choice is ReplyChoice.PENDING


@pytest.mark.parametrize(
    ("choice", "calls", "allowed"),
    [
        (ReplyChoice.PENDING, [GROUP_NO_REPLY_TOOL], True),
        (ReplyChoice.PENDING, ["read_file"], True),
        (ReplyChoice.PENDING, [GROUP_NO_REPLY_TOOL, "read_file"], False),
        (ReplyChoice.REPLY, ["read_file"], True),
        (ReplyChoice.REPLY, [GROUP_NO_REPLY_TOOL], False),
        (ReplyChoice.SILENT, [], False),
    ],
)
def test_tool_batch_is_checked_against_server_reply_gate(choice, calls, allowed):
    gate = ReplyGate(choice)
    assert tool_batch_allowed(gate, calls) is allowed


@pytest.mark.parametrize(
    ("choice", "name", "violates"),
    [
        # 普通能力照常工作；静默工具仅可单独调用。
        (ReplyChoice.PENDING, GROUP_NO_REPLY_TOOL, False),
        (ReplyChoice.PENDING, "read_file", False),
        (ReplyChoice.PENDING, "call_tool", False),
        (ReplyChoice.REPLY, "read_file", False),
        (ReplyChoice.REPLY, GROUP_NO_REPLY_TOOL, True),
        (ReplyChoice.SILENT, "read_file", True),
        (ReplyChoice.SILENT, GROUP_NO_REPLY_TOOL, True),
    ],
)
def test_gate_call_violation_is_decided_per_call(choice, name, violates):
    gate = ReplyGate(choice)
    reason = gate_call_violation_reason(gate, name)
    assert (reason is not None) is violates
    if violates:
        # 回灌给模型的文案必须写清下一步动作，只说「不允许」模型会换个花样再绕。
            assert "group_reply_decision" in reason or "不要" in reason or "不能" in reason


@pytest.mark.parametrize(
    ("payload", "enabled"),
    [
        ({"platform": "qq", "chat_type": "group", "group_requires_at": False}, True),
        ({"platform": "feishu", "chat_type": "group", "group_requires_at": False, "group_mentioned": True}, False),
        ({"platform": "telegram", "chat_type": "group", "group_requires_at": True, "group_mentioned": False}, False),
        ({"platform": "qq", "chat_type": "c2c", "group_requires_at": False}, False),
        ({"platform": "wechat", "chat_type": "group", "group_requires_at": False}, False),
    ],
)
def test_only_unmentioned_full_reply_group_messages_use_the_gate(payload, enabled):
    assert should_enable_group_reply_gate(payload) is enabled


@pytest.mark.parametrize(
    ("im_context", "allowed"),
    [
        ({"chat_type": "group", "group_auto_reply": True}, True),
        ({"chat_type": "group", "group_auto_reply": False}, False),
        ({"chat_type": "c2c", "group_auto_reply": True}, False),
        (None, False),
    ],
)
def test_internal_choice_tool_permission_is_limited_to_automatic_group_runs(
    monkeypatch, im_context, allowed,
):
    from agent.im import imctx
    from agent.im.permissions import can_use_tool

    monkeypatch.setattr(imctx, "get_im", lambda: im_context)
    assert can_use_tool(GROUP_NO_REPLY_TOOL, None) is allowed
