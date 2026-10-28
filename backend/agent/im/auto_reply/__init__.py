"""群聊自动回复的本轮选择门。"""
"""群聊自动回复专用运行时能力。"""

from .decision import (
    GATE_DUPLICATE_LIMIT_REASON,
    GATE_NOT_OPENED_REASON,
    GATE_SILENT_REASON,
    GROUP_REPLY_DECISION_TOOL,
    GROUP_REPLY_PROTOCOL_PROMPT,
    MAX_DUPLICATE_CHOICES,
    MAX_PROTOCOL_RETRIES,
    MAX_TOOL_VIOLATIONS,
    ReplyChoice,
    ReplyGate,
    build_group_reply_decision_tool,
    check_protocol_violation,
    gate_call_violation_reason,
    should_enable_group_reply_gate,
    tool_batch_allowed,
)


def group_reply_system_prompt() -> str:
    """读取自动回复专用的固定 system 规则。"""
    from pathlib import Path

    return (Path(__file__).parent / "prompts" / "group_reply_decision.md").read_text(encoding="utf-8").strip()

__all__ = [
    "GATE_DUPLICATE_LIMIT_REASON",
    "GATE_NOT_OPENED_REASON",
    "GATE_SILENT_REASON",
    "GROUP_REPLY_DECISION_TOOL",
    "GROUP_REPLY_PROTOCOL_PROMPT",
    "MAX_DUPLICATE_CHOICES",
    "MAX_PROTOCOL_RETRIES",
    "MAX_TOOL_VIOLATIONS",
    "ReplyChoice",
    "ReplyGate",
    "build_group_reply_decision_tool",
    "check_protocol_violation",
    "gate_call_violation_reason",
    "group_reply_system_prompt",
    "should_enable_group_reply_gate",
    "tool_batch_allowed",
]
