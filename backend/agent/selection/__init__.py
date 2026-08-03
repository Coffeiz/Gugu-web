"""统一选择交互的最小协议层。

当前只承载平台用户身份注册，暂不负责 Keyboard 发送和选择状态机。
"""

from agent.selection.identity import (
    build_platform_user_registration,
    register_platform_user_id,
)
from agent.selection.models import SelectionOption, SelectionPrompt

__all__ = [
    "SelectionOption",
    "SelectionPrompt",
    "build_platform_user_registration",
    "register_platform_user_id",
]
