"""交互事件的稳定标识。

事件名是前后端协议的一部分。新增事件时优先在这里登记，避免在 core、网关和前端
各自散落字符串常量。
"""

ROUND_START = "round_start"
ROUND_END = "round_end"
TOOL_CALL_START = "tool_call_start"
TOOL_CALL_RESULT = "tool_call_result"
INTERACTION_REQUIRED = "interaction_required"
# 兼容现有 Web/IM 网关：这些事件仍沿用旧名称，但 payload 已带统一身份字段。
LEGACY_NEW_ROUND = "_new_round"
LEGACY_TOOL_CALL = "tool_call"
LEGACY_TOOL_DONE = "tool_done"
TOKEN = "token"
FILE = "file"
DONE = "done"
ERROR = "error"
CANCELLED = "_cancelled"

__all__ = [
    "ROUND_START",
    "ROUND_END",
    "TOOL_CALL_START",
    "TOOL_CALL_RESULT",
    "INTERACTION_REQUIRED",
    "LEGACY_NEW_ROUND",
    "LEGACY_TOOL_CALL",
    "LEGACY_TOOL_DONE",
    "TOKEN",
    "FILE",
    "DONE",
    "ERROR",
    "CANCELLED",
]
