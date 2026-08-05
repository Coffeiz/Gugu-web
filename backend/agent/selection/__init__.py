"""统一选择交互的最小协议层。

当前只承载通用选择模型，暂不负责 Keyboard 发送和选择状态机。
"""

from agent.selection.models import SelectionOption, SelectionPrompt

__all__ = [
    "SelectionOption",
    "SelectionPrompt",
]
