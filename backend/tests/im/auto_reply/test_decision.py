"""保护未选择时默认静默及选择不能在本轮内反复改变。"""
import pytest

from agent.im.auto_reply.decision import (
    GROUP_REPLY_DECISION_TOOL,
    MAX_DUPLICATE_CHOICES,
    MAX_TOOL_VIOLATIONS,
    ReplyChoice,
    ReplyGate,
    build_group_reply_decision_tool,
    gate_call_violation_reason,
    should_enable_group_reply_gate,
    tool_batch_allowed,
)


def test_unselected_gate_disallows_reply():
    assert not ReplyGate().may_reply


@pytest.mark.parametrize("selection", [True, False])
def test_choice_is_explicit_and_cannot_be_changed(selection):
    gate = ReplyGate()
    gate.choose(selection)
    assert gate.may_reply is selection
    assert gate.choice is (ReplyChoice.REPLY if selection else ReplyChoice.SILENT)
    with pytest.raises(ValueError):
        gate.choose(not selection)


@pytest.mark.parametrize("invalid", [None, 0, 1, "true", {}])
def test_invalid_selection_does_not_open_gate(invalid):
    gate = ReplyGate()
    with pytest.raises(ValueError):
        gate.choose(invalid)
    assert gate.choice is ReplyChoice.PENDING
    assert not gate.may_reply


@pytest.mark.parametrize(
    ("choice", "calls", "allowed"),
    [
        (ReplyChoice.PENDING, [GROUP_REPLY_DECISION_TOOL], True),
        (ReplyChoice.PENDING, ["read_file"], False),
        (ReplyChoice.PENDING, [GROUP_REPLY_DECISION_TOOL, "read_file"], False),
        (ReplyChoice.REPLY, ["read_file"], True),
        # 已经做出选择后模型又调了一次选择工具：按幂等放行（既有选择不改写）。
        # 判成协议失败会让整条消息连同已经算好的 token 一起报废——实测线上就是
        # 这么丢的回复。
        (ReplyChoice.REPLY, [GROUP_REPLY_DECISION_TOOL], True),
        # 门已经开了，业务工具照常执行：重复调门是模型复读工具名留下的噪音，
        # 不该把已经开门的这一轮连同业务调用一起报废。
        (ReplyChoice.REPLY, [GROUP_REPLY_DECISION_TOOL, "read_file"], True),
        (ReplyChoice.SILENT, [], False),
    ],
)
def test_tool_batch_is_checked_against_server_reply_gate(choice, calls, allowed):
    gate = ReplyGate(choice)
    assert tool_batch_allowed(gate, calls) is allowed


@pytest.mark.parametrize(
    ("choice", "name", "violates"),
    [
        # 门还没开：只有选择工具能用，其它工具一个都不许执行。
        (ReplyChoice.PENDING, GROUP_REPLY_DECISION_TOOL, False),
        (ReplyChoice.PENDING, "read_file", True),
        (ReplyChoice.PENDING, "call_tool", True),
        # 门已开：业务工具放行；重复调门在幂等上限内也放行。
        (ReplyChoice.REPLY, "read_file", False),
        (ReplyChoice.REPLY, GROUP_REPLY_DECISION_TOOL, False),
        # 选了静默：任何工具都不该再调。
        (ReplyChoice.SILENT, "read_file", True),
        (ReplyChoice.SILENT, GROUP_REPLY_DECISION_TOOL, True),
    ],
)
def test_gate_call_violation_is_decided_per_call(choice, name, violates):
    gate = ReplyGate(choice)
    reason = gate_call_violation_reason(gate, name)
    assert (reason is not None) is violates
    if violates:
        # 回灌给模型的文案必须写清下一步动作，只说「不允许」模型会换个花样再绕。
        assert "group_reply_decision" in reason or "不要" in reason


def test_duplicate_gate_call_beyond_limit_is_a_violation():
    gate = ReplyGate(ReplyChoice.REPLY)
    assert gate_call_violation_reason(gate, GROUP_REPLY_DECISION_TOOL) is None
    gate.duplicate_choices = MAX_DUPLICATE_CHOICES
    assert gate_call_violation_reason(gate, GROUP_REPLY_DECISION_TOOL) is not None


def test_tool_violations_are_recoverable_until_the_limit():
    """单次违规只是把这次调用隔离成工具级错误；连续超限才把整轮判死。"""
    gate = ReplyGate()

    assert gate.note_tool_violation() is False
    assert gate.note_tool_violation() is False
    assert gate.note_tool_violation() is True
    assert gate.tool_violations == MAX_TOOL_VIOLATIONS + 1


@pytest.mark.parametrize("should_reply", [True, False])
def test_meta_tool_changes_only_the_run_gate(should_reply):
    import asyncio

    gate = ReplyGate()
    tool = build_group_reply_decision_tool(gate)
    result = asyncio.run(tool.handler(None, None, {"should_reply": should_reply}))
    assert result["selected"] == ("reply" if should_reply else "silent")
    assert gate.may_reply is should_reply


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
    assert can_use_tool(GROUP_REPLY_DECISION_TOOL, None) is allowed
