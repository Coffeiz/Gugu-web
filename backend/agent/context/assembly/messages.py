"""可变消息列表与缓存边界。"""
from __future__ import annotations

from typing import Iterable

from .batch import NewMessageBatch


class PromptMessages(list):
    """带 fixed prefix 与 provider-only dynamic tail 边界的请求消息列表。"""

    def __init__(self, conversation: Iterable[dict] = (), fixed_prefix_size: int = 0):
        self._backing = conversation if isinstance(conversation, list) else None
        conversation = list(conversation)
        self._fixed_prefix_size = max(0, min(int(fixed_prefix_size), len(conversation)))
        self._tail_size = 0
        self._cache_anchor_indices: list[int] = []
        self._canonical_batches: list[tuple[dict, ...]] = []
        self._canonical_batch_digests: list[str] = []
        super().__init__(conversation)

    def _sync_backing(self) -> None:
        if self._backing is not None and self._backing is not self:
            self._backing[:] = self

    @property
    def conversation(self) -> list[dict]:
        """返回可持久化/可追加的 conversation，不包含 provider-only 尾缀。"""
        end = len(self) - self._tail_size if self._tail_size else len(self)
        return list(self[:end])

    @property
    def dynamic_tail(self) -> list[dict]:
        """返回只随当前 provider 请求发送、永不进入 history 的尾缀。"""
        if not self._tail_size:
            return []
        return list(self[len(self) - self._tail_size:])

    def set_dynamic_tail(self, messages: Iterable[dict]) -> None:
        """替换 provider-only 尾缀；后续 append/append_batch 始终插在它之前。"""
        conversation = self.conversation
        tail = list(messages)
        super().__setitem__(slice(None), conversation + tail)
        self._tail_size = len(tail)
        self._sync_backing()

    def append(self, item) -> None:
        if self._tail_size:
            super().insert(len(self) - self._tail_size, item)
        else:
            super().append(item)
        self._sync_backing()

    def append_batch(self, batch: NewMessageBatch | Iterable[dict]) -> None:
        """一次性提交本轮消息，保证本轮新增内容连续且位于 dynamic tail 之前。"""
        if isinstance(batch, NewMessageBatch):
            batch.seal()
            items = list(batch.provider_messages)
            self._canonical_batches.append(batch.canonical_messages)
            self._canonical_batch_digests.append(batch.batch_digest)
        else:
            items = list(batch)
        if not items:
            return
        for item in items:
            self.append(item)

    @property
    def canonical_batches(self) -> tuple[dict, ...]:
        """返回本次容器提交过的 canonical 批次副本；dynamic tail 永不包含在内。"""
        return tuple(item for batch in self._canonical_batches for item in batch)

    @property
    def canonical_batch_digests(self) -> tuple[str, ...]:
        """返回已提交 canonical batch 的脱敏身份指纹。"""
        return tuple(self._canonical_batch_digests)

    def extend(self, items) -> None:
        for item in items:
            self.append(item)

    def insert(self, index: int, item) -> None:
        # 外部调用不能把普通 conversation 消息插到 dynamic tail 后面。
        if self._tail_size:
            conversation_len = len(self) - self._tail_size
            index = max(0, min(int(index), conversation_len))
        super().insert(index, item)
        self._sync_backing()

    def replace_conversation(self, messages: Iterable[dict]) -> None:
        tail = self.dynamic_tail
        conversation = list(messages)
        super().__setitem__(slice(None), conversation + tail)
        self._tail_size = len(tail)
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
    """返回一次 provider 请求后新增的历史消息，不把 dynamic tail 当成历史。"""
    method = getattr(messages, "newly_appended", None)
    if callable(method):
        return method(initial_conversation_len)
    return list(messages)[initial_conversation_len:]
