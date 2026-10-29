"""群聊自动回复的本轮回复选择状态；默认输出正文就是正常回复。"""
from dataclasses import dataclass
from enum import Enum

from agent.tools.base import Tool


GROUP_NO_REPLY_TOOL = "choose_no_reply"
GATE_SILENT_REASON = "本轮已明确选择不回复，不要再调用其它工具。"
GATE_NO_REPLY_AFTER_TEXT_REASON = "本轮已经开始回复，不能再改为静默。"


def should_enable_group_reply_gate(payload: dict) -> bool:
    """普通全量回复群消息才启用不回复选择工具；明确 @ 与仅 @ 模式保持原路径。"""
    return bool(
        isinstance(payload, dict)
        and payload.get("platform") in {"qq", "feishu", "telegram"}
        and payload.get("chat_type") == "group"
        and (
            payload.get("_attention_continuation_only") is True
            or (
                not payload.get("group_requires_at")
                and not payload.get("group_mentioned")
            )
        )
        and not payload.get("group_read_enabled")
    )


class ReplyChoice(Enum):
    PENDING = "pending"  # 尚未决定；直接正文仍可成为回复
    REPLY = "reply"
    SILENT = "silent"


@dataclass
class ReplyGate:
    """未选择静默时允许回复；不回复选择是本轮不可逆的静默决定。"""

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
            raise ValueError("本轮不回复工具不接受参数")
        gate.decline()
        return {"selected": ReplyChoice.SILENT.value}

    return Tool(
        name=GROUP_NO_REPLY_TOOL,
        description=(
            "选择本轮不回复。可以先阅读上下文并调用必要工具，再根据结果判断是否值得回复；"
            "确定不需要回应时调用本工具。调用后本轮立即静默结束；同一批次里的其它工具不会执行。"
            "如果已经输出面向群成员的正文，就不能再改为静默。"
        ),
        description_short=(
            "可先阅读上下文或调用必要工具，再决定是否回复；确定不需要回应时调用。调用后立即静默结束；"
            "已输出正文后不能再改为静默。"
        ),
        input_schema={
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        handler=decline,
        label="本轮不回复",
        category="meta",
        source="builtin",
        schema_version=4,
        parallel_safe=False,
    )


def gate_call_violation_reason(gate: ReplyGate, resolved_name: str) -> str | None:
    """静默后阻止后续工具；已经输出正文后不能再切换为静默。"""
    if gate.choice is ReplyChoice.SILENT:
        return GATE_SILENT_REASON
    if (
        gate.choice is ReplyChoice.REPLY
        and resolved_name == GROUP_NO_REPLY_TOOL
    ):
        return GATE_NO_REPLY_AFTER_TEXT_REASON
    return None


def tool_batch_allowed(gate: ReplyGate, call_names: list[str]) -> bool:
    """不回复选择与其它工具同批时整批不执行，防止静默选择旁路业务工具。"""
    if gate.choice is ReplyChoice.SILENT:
        return False
    has_no_reply_choice = GROUP_NO_REPLY_TOOL in call_names
    if has_no_reply_choice and len(call_names) != 1:
        return False
    return all(gate_call_violation_reason(gate, name) is None for name in call_names)
