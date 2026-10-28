"""自动回复的本轮选择状态；调用方负责协议和输出门禁。"""
from dataclasses import dataclass
from enum import Enum
from typing import Any

from agent.tools.base import Tool


GROUP_REPLY_DECISION_TOOL = "group_reply_decision"

# 已经做出选择之后，模型又调用了一次选择工具时允许的幂等次数。
# 门开后选择工具会从下一轮的 provider schema 里移除，但工具名仍留在对话
# 历史里、提示词里也还写着「必须调用一次」——模型据此复读该工具名是常见
# 行为。把它判成协议失败会让整条消息连同已经算好的 token 一起报废，
# 所以按幂等放行；次数仍有上限，避免模型卡在复读里无限烧 token。
MAX_DUPLICATE_CHOICES = 2

# 门协议违规（没调门就调别的工具、选了静默还调工具）后仍允许模型自我纠正
# 的次数。超限才把整轮判死——单次违规只是把这次调用隔离成工具级错误回灌
# 给模型，让它在同一 run 内补调门后继续，不该让整条群消息连同已经算好的
# token 一起报废（实测线上就是这么丢的回复）。
MAX_TOOL_VIOLATIONS = 2

# 门还没开就想调别的工具：回灌给模型的说明。要直接给出下一步动作，
# 只说「不允许」模型会换个花样再绕一次。
GATE_NOT_OPENED_REASON = (
    "本轮还没有做出回复选择，不能使用其它工具。"
    "必须先调用 `group_reply_decision`（只传 should_reply=true/false）"
    "决定这一轮是否回复；选择之后才能继续使用其它工具。"
)

# 已经选择静默：这一轮不回复，任何工具都不该再调。
GATE_SILENT_REASON = "本轮已经选择不回复，不要再调用任何工具；保持沉默即可。"

# 重复调门且超过幂等上限：不再接受这次选择。
GATE_DUPLICATE_LIMIT_REASON = (
    "本轮的回复选择已经确定，不要再调用 `group_reply_decision`；直接回答或保持沉默。"
)

# 模型直接输出正文（没调用选择工具）时允许的纠错轮数。纠错一轮仍不选就落静默，
# 避免在协议持续冲突时反复烧 token。
MAX_PROTOCOL_RETRIES = 1

# 协议违反时回给模型的内部纠错指令。这是协议控制信令，不是用户消息，也不是
# 运行时权限说明——模型必须先做出本轮选择，正文才有可能发进群。
GROUP_REPLY_PROTOCOL_PROMPT = (
    "【内部协议错误 · 需要选择】你上一条直接输出了正文，但没有调用 "
    "`group_reply_decision`，因此本轮内容不会发进群。"
    "现在必须先调用 `group_reply_decision`，只传一个参数 `should_reply`："
    "该回则传 true，并**重新完整回答**上面的问题（不要假设自己已经答过）；"
    "不该回则传 false，丢弃刚才写的正文，本轮保持沉默。"
)


def should_enable_group_reply_gate(payload: dict) -> bool:
    """普通全量回复群消息才启用选择门；明确 @ 与仅 @ 模式保持原路径。"""
    return bool(
        isinstance(payload, dict)
        and payload.get("platform") in {"qq", "feishu", "telegram"}
        and payload.get("chat_type") == "group"
        and not payload.get("group_requires_at")
        and not payload.get("group_mentioned")
    )


def _coerce_choice(value: Any) -> bool | None:
    """把模型给的 should_reply 归一成布尔；认不出返回 None。

    只用于「已经做过选择」之后的重复调用：模型此时常把布尔写成字符串
    （实测出现过 ``"true"``），第一次调用的严格校验由 ``ReplyGate.choose``
    保持不变。
    """
    if type(value) is bool:
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"true", "1", "yes"}:
            return True
        if text in {"false", "0", "no"}:
            return False
        return None
    if type(value) is int and value in (0, 1):
        return bool(value)
    return None


class ReplyChoice(Enum):
    PENDING = "pending"
    REPLY = "reply"
    SILENT = "silent"


@dataclass
class ReplyGate:
    """只接受一次明确选择；未选择时不允许对外回复。"""

    choice: ReplyChoice = ReplyChoice.PENDING
    # 协议违反（模型直接输出正文、没调用选择工具）已消耗的纠错次数。
    protocol_retries: int = 0
    # 已经做出选择后，模型又调用了一次选择工具的次数：按幂等处理，不改写选择。
    duplicate_choices: int = 0
    # 重复调用里与既有选择冲突的次数：同样不改写选择，单独计数便于诊断。
    conflicting_choices: int = 0
    # 门协议违规（没调门就调别的工具 / 选了静默还调工具）的累计次数。
    tool_violations: int = 0
    # provider 是否接受强制 tool_choice。实测有的 provider 在思考模式下直接
    # 400，被拒后本 run 退回普通 tool_choice，不再强求。
    tool_choice_supported: bool = True

    @property
    def may_reply(self) -> bool:
        return self.choice is ReplyChoice.REPLY

    def choose(self, should_reply: bool) -> None:
        if self.choice is ReplyChoice.PENDING:
            if type(should_reply) is not bool:
                raise ValueError("回复选择必须是布尔值")
            self.choice = ReplyChoice.REPLY if should_reply else ReplyChoice.SILENT
            return
        # 已经做过选择，模型又调了一次：既有选择权威，重复调用不改写它。
        # 与既有选择一致的重复是幂等的（模型只是确认一下），静默放过；
        # 冲突的重复仍然报错，但只让这一次工具调用失败，不牵连整轮。
        self.duplicate_choices += 1
        requested = _coerce_choice(should_reply)
        if requested is not None and requested != (self.choice is ReplyChoice.REPLY):
            self.conflicting_choices += 1
            raise ValueError("本轮已作出回复选择")

    def can_retry_protocol(self) -> bool:
        """还能否就「没调用选择工具」这件事再纠错一轮。"""
        return self.protocol_retries < MAX_PROTOCOL_RETRIES

    def note_protocol_violation(self) -> None:
        self.protocol_retries += 1

    def note_tool_violation(self) -> bool:
        """记录一次门协议违规；返回 True 表示已经超限，本轮必须收尾。

        单次违规只是把这次调用隔离成工具级错误回灌给模型，让它自己纠正；
        连续超限才把整轮判死，避免模型卡在复读里无限烧 token。
        """
        self.tool_violations += 1
        return self.tool_violations > MAX_TOOL_VIOLATIONS

    def mark_tool_choice_unsupported(self) -> None:
        """provider 拒绝了强制 tool_choice：本 run 退回普通 tool_choice。"""
        self.tool_choice_supported = False


def check_protocol_violation(gate: ReplyGate, *, has_text: bool) -> str:
    """判定本轮是否违反了「必须先做出回复选择」协议。

    返回 "retry"（可以纠错一轮）、"exhausted"（纠错次数已用尽）、""（无违反）。

    判据是「本轮有没有产出正文」：

    - 没有正文：模型选择不说话，属于正常静默，不算违反。
    - 有正文却没做选择：模型自顾自答了，本轮内容不会发进群，必须纠错。

    纠错不是终止错误——把协议错误回给模型，让它在同一 run 内重新选择
    静默还是发言（PRD-IM-16 §4）。
    """
    if gate.choice is not ReplyChoice.PENDING:
        return ""
    if not has_text:
        return ""
    if gate.can_retry_protocol():
        gate.note_protocol_violation()
        return "retry"
    return "exhausted"


def build_group_reply_decision_tool(gate: ReplyGate) -> Tool:
    """为单个群聊 run 创建选择工具；工具本身不执行任何业务动作。"""

    async def choose(_db, _user_id, arguments):
        if not isinstance(arguments, dict) or set(arguments) != {"should_reply"}:
            raise ValueError("回复选择参数无效")
        gate.choose(arguments["should_reply"])
        return {"selected": gate.choice.value}

    return Tool(
        name=GROUP_REPLY_DECISION_TOOL,
        description=(
            "决定本轮群聊是否需要咕咕回复；必须在任何正文或业务工具之前调用一次。"
            "做出选择后就不要再调用它——拿到结果后直接回答或保持沉默。"
        ),
        # provider 看到的工具描述来自 description_short（没设就回落成 label），
        # 这句「不要重复调用」只有写在这里才真正进得了 provider 的 schema。
        description_short=(
            "决定本轮群聊是否需要咕咕回复。必须在任何正文或业务工具之前调用一次；"
            "拿到结果后不要再调用它，直接回答或保持沉默。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "should_reply": {"type": "boolean", "description": "需要回复时为 true，否则为 false"},
            },
            "required": ["should_reply"],
            "additionalProperties": False,
        },
        handler=choose,
        label="群聊回复选择",
        category="meta",
        source="builtin",
        schema_version=1,
        parallel_safe=False,
    )


def gate_call_violation_reason(gate: ReplyGate, resolved_name: str) -> str | None:
    """判定单个工具调用是否违反门协议；返回 None 表示可以执行。

    判定用「最终业务工具名」：`call_tool` 这层包装要先解开，否则模型用
    元工具绕开门的选择就检测不出来（实测线上就是这么丢的群消息）。
    """
    if gate.choice is ReplyChoice.PENDING:
        if resolved_name == GROUP_REPLY_DECISION_TOOL:
            return None
        return GATE_NOT_OPENED_REASON
    if gate.choice is ReplyChoice.REPLY:
        if resolved_name != GROUP_REPLY_DECISION_TOOL:
            return None
        if gate.duplicate_choices < MAX_DUPLICATE_CHOICES:
            # 已经做出选择后模型又调了一次：既有选择权威，按幂等放行。
            return None
        return GATE_DUPLICATE_LIMIT_REASON
    return GATE_SILENT_REASON


def tool_batch_allowed(gate: ReplyGate, call_names: list[str]) -> bool:
    """整批是否全部允许执行（按最终业务工具名判定）。

    门已开（REPLY）之后业务工具照常执行，重复调门按幂等放行；静默轮一律
    不允许执行任何工具。逐个调用的判定用 gate_call_violation_reason，
    本函数只回答「这批能不能整体放行」。
    """
    if gate.choice is ReplyChoice.SILENT:
        return False
    return all(
        gate_call_violation_reason(gate, name) is None for name in call_names
    )
