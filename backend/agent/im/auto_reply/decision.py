"""群聊自动回复的拒绝状态；默认输出正文就是正常回复。"""
from dataclasses import dataclass
from enum import Enum

from agent.tools.base import Tool


GROUP_REPLY_DECISION_TOOL = "decline_group_reply"
GATE_SILENT_REASON = "本轮已明确选择不回复，不要再调用其它工具。"
GATE_DECLINE_AFTER_REPLY_REASON = "本轮已经开始回复，不能再改为静默。"


def should_enable_group_reply_gate(payload: dict) -> bool:
    """普通全量回复群消息才启用拒绝工具；明确 @ 与仅 @ 模式保持原路径。"""
    return bool(
        isinstance(payload, dict)
        and payload.get("platform") in {"qq", "feishu", "telegram"}
        and payload.get("chat_type") == "group"
        and not payload.get("group_requires_at")
        and not payload.get("group_mentioned")
    )


class ReplyChoice(Enum):
    PENDING = "pending"  # 尚未决定；直接正文仍可成为回复
    REPLY = "reply"
    SILENT = "silent"


@dataclass
class ReplyGate:
    """不调用拒绝工具时允许回复；拒绝工具是不可逆的本轮静默决定。"""

    choice: ReplyChoice = ReplyChoice.PENDING

    @property
    def may_reply(self) -> bool:
        return self.choice is not ReplyChoice.SILENT

    def decline(self) -> None:
        self.choice = ReplyChoice.SILENT


def build_group_reply_decision_tool(gate: ReplyGate) -> Tool:
    """创建只表达「本轮不要回复」的零参数 meta 工具。"""

    async def decline(_db, _user_id, arguments):
        if arguments not in ({}, None):
            raise ValueError("拒绝回复工具不接受参数")
        gate.decline()
        return {"selected": ReplyChoice.SILENT.value}

    return Tool(
        name=GROUP_REPLY_DECISION_TOOL,
        description=(
            "明确拒绝本轮群聊回复。仅在尚未输出正文、尚未调用业务工具，且确定不应回应时调用；"
            "调用后本轮立即静默结束，正文和其它业务工具都不会执行。"
            "如果你要回答，直接输出正文或正常调用所需业务工具，不要调用本工具。"
        ),
        description_short=(
            "仅在输出正文或调用业务工具前决定不回复时调用；调用后本轮静默结束。要回答就直接输出正文，"
            "或正常调用业务工具，不要调用本工具。"
        ),
        input_schema={
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        handler=decline,
        label="拒绝群聊回复",
        category="meta",
        source="builtin",
        schema_version=3,
        parallel_safe=False,
    )


def gate_call_violation_reason(gate: ReplyGate, resolved_name: str) -> str | None:
    """拒绝后阻止整批其它工具；开始正常回答后拒绝工具不再可用。"""
    if gate.choice is ReplyChoice.SILENT:
        return GATE_SILENT_REASON
    if (
        gate.choice is ReplyChoice.REPLY
        and resolved_name == GROUP_REPLY_DECISION_TOOL
    ):
        return GATE_DECLINE_AFTER_REPLY_REASON
    return None


def tool_batch_allowed(gate: ReplyGate, call_names: list[str]) -> bool:
    """拒绝调用与其它工具同批时整批不执行，防止拒绝请求旁路业务工具。"""
    if gate.choice is ReplyChoice.SILENT:
        return False
    has_decline = GROUP_REPLY_DECISION_TOOL in call_names
    if has_decline and len(call_names) != 1:
        return False
    return all(gate_call_violation_reason(gate, name) is None for name in call_names)
