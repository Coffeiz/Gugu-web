"""兼容旧导入路径；实现位于 `agent.gateway.wechat.typing`。"""

from .wechat.typing import DEFAULT_KEEPALIVE_S, SendTypingFn, TypingIndicator

__all__ = ["DEFAULT_KEEPALIVE_S", "SendTypingFn", "TypingIndicator"]
