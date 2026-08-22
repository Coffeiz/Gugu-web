"""统一的 LLM 消息装配与动态尾部约束。"""
from __future__ import annotations

from typing import Iterable


class PromptMessages(list):
    """可变的请求消息列表：普通 append 永远插入动态尾部之前。"""

    def __init__(self, conversation: Iterable[dict] = (), dynamic_tail: Iterable[dict] = (),
                 fixed_prefix_size: int = 0):
        tail = list(dynamic_tail)
        conversation = list(conversation)
        self._tail_size = len(tail)
        # snapshot/system-info 在 conversation 的最前面；压缩只能处理其后的消息区。
        self._fixed_prefix_size = max(0, min(int(fixed_prefix_size), len(conversation)))
        # 只供当前请求的 provider cache helper 使用，不进入消息内容或持久化数据。
        self._cache_anchor_indices: list[int] = []
        super().__init__(list(conversation) + tail)

    @property
    def conversation(self) -> list[dict]:
        return list(self[:len(self) - self._tail_size if self._tail_size else len(self)])

    @property
    def dynamic_tail(self) -> list[dict]:
        return list(self[len(self) - self._tail_size:]) if self._tail_size else []

    def append(self, item) -> None:
        if self._tail_size:
            super().insert(len(self) - self._tail_size, item)
        else:
            super().append(item)

    def extend(self, items) -> None:
        for item in items:
            self.append(item)

    def replace_conversation(self, messages: Iterable[dict]) -> None:
        tail = self.dynamic_tail
        conversation = list(messages)
        super().__setitem__(slice(None), conversation + tail)
        self._tail_size = len(tail)
        # 压缩/替换后原有索引已经失效，下一次请求从新的 conversation 末尾建立断点。
        self._cache_anchor_indices = []

    @property
    def fixed_prefix_size(self) -> int:
        """snapshot 固定前缀的消息数，不进入普通 message compaction。"""
        return self._fixed_prefix_size

    @property
    def cache_anchor_indices(self) -> list[int]:
        return list(self._cache_anchor_indices)

    def remember_cache_anchor(self, index: int, *, limit: int = 2) -> None:
        """保留最近的 conversation cache checkpoint，不污染实际消息。"""
        conversation_len = len(self.conversation)
        if index < 0 or index >= conversation_len:
            return
        anchors = [item for item in self._cache_anchor_indices
                   if 0 <= item < conversation_len and item != index]
        anchors.append(index)
        self._cache_anchor_indices = anchors[-limit:]

    def newly_appended(self, initial_conversation_len: int) -> list[dict]:
        """返回本轮新增的对话消息，不把动态尾部当成历史。"""
        conversation = self.conversation
        return conversation[initial_conversation_len:]


def reminder(content: str) -> dict:
    return {"role": "user", "content": f"[system-reminder]\n{content}\n[/system-reminder]"}


def build_messages(*, fixed_parts: Iterable[dict], history: Iterable[dict],
                   current_user: dict | None, dynamic_tail: Iterable[dict]) -> PromptMessages:
    """固定上下文、连续历史和当前消息先组成 conversation，动态内容最后追加。"""
    fixed = list(fixed_parts)
    conversation = fixed + list(history)
    if current_user is not None:
        conversation.append(current_user)
    return PromptMessages(conversation, dynamic_tail, fixed_prefix_size=len(fixed))


def newly_appended(messages: list, initial_conversation_len: int) -> list[dict]:
    """兼容带动态尾部的 PromptMessages 与 OpenAI 路普通消息列表。"""
    method = getattr(messages, "newly_appended", None)
    if method is not None:
        return method(initial_conversation_len)
    return list(messages[initial_conversation_len:])
