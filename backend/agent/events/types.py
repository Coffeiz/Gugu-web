"""事件类型（类而非字符串：可类型检查、可带结构化字段、IDE 可跳转）。"""
from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class Event:
    ts: float = field(default_factory=time.time)


@dataclass
class MemoryUpdated(Event):
    """用户长期记忆（profile/pattern）发生增删。source: reflection / remember / forget。"""
    user_id: object = None
    added: int = 0
    removed: int = 0
    source: str = ""


@dataclass
class RagIndexUpdated(Event):
    """RAG 索引更新信号；SSE 通知与索引生命周期分开。"""
    user_id: object = None
    source_type: str = "memory"
    source_id: str = ""
    version: str = ""
    operation: str = "upsert"
