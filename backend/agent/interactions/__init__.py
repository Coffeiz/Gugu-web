"""Agent 与用户之间的交互协议。

这里放跨平台共享的交互数据结构和事件序列化；平台网关、Agent 执行器和安全策略
仍然保留在各自目录，避免把传输协议和业务执行耦合在一起。
"""

from .stream_events import encode_event
from .preferences import show_tool_interactions

__all__ = ["encode_event", "show_tool_interactions"]
