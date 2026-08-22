"""交互事件的稳定标识。

事件名是前后端协议的一部分。新增事件时优先在这里登记，避免在 core、网关和前端
各自散落字符串常量。
"""

ROUND_START = "round_start"
ROUND_END = "round_end"
TOOL_CALL_START = "tool_call_start"
TOOL_CALL_RESULT = "tool_call_result"
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
    "TOKEN",
    "FILE",
    "DONE",
    "ERROR",
    "CANCELLED",
]
