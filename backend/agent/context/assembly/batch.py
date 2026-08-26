"""本轮新增消息批次。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable


@dataclass
class NewMessageBatch:
    """本轮新增消息的唯一组装结果。"""

    messages: list[dict] = field(default_factory=list)

    def extend(self, messages: Iterable[dict]) -> None:
        self.messages.extend(messages)

    def append(self, message: dict) -> None:
        self.messages.append(message)
