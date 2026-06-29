"""事件总线（2b）：发布/订阅，事件用类（types.py）不用字符串。

Core 只管**发事件**、不耦合下游业务；成就 / 行为分析 / 正反馈等以后挂 listener 即可加，
不动发布方。当前内置一个 listener：把记忆变更落 `agent.events` 日志（可审计、进 Debug 面板）。
"""
from agent.events.bus import publish, subscribe
from agent.events import types

__all__ = ["publish", "subscribe", "types"]
