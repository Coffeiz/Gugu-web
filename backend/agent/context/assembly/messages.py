"""可变消息列表与缓存边界。"""
from __future__ import annotations

from typing import Iterable

from .batch import NewMessageBatch


class PromptMessages(list):
    """带 fixed prefix 边界的请求消息列表。"""

    def __init__(self, conversation: Iterable[dict] = (), fixed_prefix_size: int = 0):
        self._backing = conversation if isinstance(conversation, list) else None
        conversation = list(conversation)
        self._fixed_prefix_size = max(0, min(int(fixed_prefix_size), len(conversation)))
        self._cache_anchor_indices: list[int] = []
        super().__init__(conversation)

    def _sync_backing(self) -> None:
        if self._backing is not None and self._backing is not self:
            self._backing[:] = self

    @property
    def conversation(self) -> list[dict]:
        return list(self)

    def append(self, item) -> None:
        super().append(item)
        self._sync_backing()

    def append_batch(self, batch: NewMessageBatch | Iterable[dict]) -> None:
        """一次性提交本轮消息，保证本轮新增内容保持连续。"""
        items = batch.messages if isinstance(batch, NewMessageBatch) else list(batch)
        if not items:
            return
        super().extend(items)
        self._sync_backing()

    def extend(self, items) -> None:
        for item in items:
            self.append(item)

    def insert(self, index: int, item) -> None:
        super().insert(index, item)
        self._sync_backing()

    def replace_conversation(self, messages: Iterable[dict]) -> None:
        conversation = list(messages)
        super().__setitem__(slice(None), conversation)
        self._cache_anchor_indices = []
        self._sync_backing()

    @property
    def fixed_prefix_size(self) -> int:
        return self._fixed_prefix_size

    @property
    def cache_anchor_indices(self) -> list[int]:
        return list(self._cache_anchor_indices)

    def remember_cache_anchor(self, index: int, *, limit: int = 2) -> None:
        conversation_len = len(self.conversation)
        if index < 0 or index >= conversation_len:
            return
        anchors = sorted({item for item in self._cache_anchor_indices
                          if 0 <= item < conversation_len})
        if index not in anchors:
            anchors.append(index)
        if len(anchors) <= limit:
            self._cache_anchor_indices = anchors
            return
        # 第一个锚点是本轮 baseline，必须跨工具续轮保留；只替换最新尾部锚点。
        self._cache_anchor_indices = [anchors[0], anchors[-1]][:limit]

    def newly_appended(self, initial_conversation_len: int) -> list[dict]:
        return self.conversation[initial_conversation_len:]


def newly_appended(messages: list[dict], initial_conversation_len: int) -> list[dict]:
    """返回一次 provider 请求后新增的历史消息。"""
    return list(messages)[initial_conversation_len:]
