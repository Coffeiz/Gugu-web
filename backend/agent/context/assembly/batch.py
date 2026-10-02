"""本轮新增 canonical 消息批次。"""
from __future__ import annotations

import copy
from typing import Any, Iterable

from ..canonical_context import digest


_CANONICAL_BLOCK_TYPES = frozenset({
    "text", "reasoning_content", "tool_call", "tool_result", "tool-schema", "skill-schema",
    "tool-discovery", "knowledge-context", "stance-context", "time-context",
    "runtime-context",
})


def _validate_canonical_messages(messages: Iterable[dict]) -> list[dict]:
    """拒绝 Provider wire，确保批次只承载 canonical history。"""
    values = copy.deepcopy(list(messages))
    for message in values:
        if not isinstance(message, dict) or not isinstance(message.get("role"), str):
            raise TypeError("Canonical batch 消息必须是带 role 的对象")
        if "tool_calls" in message or message.get("role") == "tool":
            raise TypeError("Canonical batch 不得包含 Provider tool wire 字段")
        content = message.get("content")
        if not isinstance(content, (str, list)):
            raise TypeError("Canonical batch content 必须是字符串或 block 列表")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict) or not isinstance(block.get("type"), str):
                    raise TypeError("Canonical batch block 必须是带 type 的对象")
                if block["type"] not in _CANONICAL_BLOCK_TYPES:
                    raise TypeError(f"Canonical batch 不支持 block 类型：{block['type']}")
    return values


def _canonicalize_request_messages(provider_messages: Iterable[dict]) -> list[dict]:
    """在一次性 Provider 输入边界转成 canonical；不把 wire 留在批次中。"""
    from ..history import canonicalize_tool_messages

    canonical: list[dict] = []
    for message in copy.deepcopy(list(provider_messages)):
        if not isinstance(message, dict) or not isinstance(message.get("role"), str):
            raise TypeError("请求消息必须是带 role 的对象")
        normalized = canonicalize_tool_messages([message])
        if normalized:
            canonical.extend(normalized)
            continue
        content = message.get("content")
        if content is None:
            continue
        if isinstance(content, list):
            blocks = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                kind = block.get("type")
                if kind in {"thinking", "redacted_thinking", "reasoning_content"}:
                    continue
                if kind == "input_text":
                    block = {"type": "text", "text": block.get("text", "")}
                    kind = "text"
                if kind in _CANONICAL_BLOCK_TYPES:
                    blocks.append(block)
            content = blocks
            if not content:
                continue
        canonical.append({"role": message["role"], "content": content})
    return _validate_canonical_messages(canonical)


class MessageBatch:
    """一次性 canonical entry DTO；Provider 投影由 Area 在消费时单独生成。"""

    def __init__(self, canonical_messages: Iterable[dict], *, metadata=None) -> None:
        self._area_entries: tuple[dict, ...] | list[dict] = [
            {"message": message}
            for message in _validate_canonical_messages(canonical_messages)
        ]
        self._metadata = copy.deepcopy(metadata or {})
        self._sealed = False
        self._digest = ""

    @classmethod
    def from_canonical_messages(
        cls,
        canonical_messages: Iterable[dict],
        *,
        metadata: dict[str, Any] | None = None,
    ) -> "MessageBatch":
        return cls(canonical_messages, metadata=metadata)

    @classmethod
    def from_area_entries(
        cls,
        entries: Iterable[dict],
        *,
        metadata: dict[str, Any] | None = None,
    ) -> "MessageBatch":
        batch = cls((), metadata=metadata)
        batch.set_area_entries(entries)
        return batch

    @property
    def sealed(self) -> bool:
        return self._sealed

    @property
    def metadata(self) -> dict[str, Any]:
        return copy.deepcopy(self._metadata)

    @property
    def batch_digest(self) -> str:
        return self._digest or digest({
            "entries": self._area_entries,
            "metadata": self._metadata,
        })

    @property
    def message_count(self) -> int:
        return len(self._area_entries)

    @property
    def canonical_messages(self) -> tuple[dict, ...]:
        return tuple(copy.deepcopy(item["message"]) for item in self._area_entries)

    @property
    def area_entries(self) -> tuple[dict, ...]:
        return tuple(copy.deepcopy(self._area_entries))

    def set_area_entries(self, entries: Iterable[dict]) -> None:
        self._ensure_mutable()
        values = copy.deepcopy(list(entries))
        for item in values:
            if not isinstance(item, dict) or not isinstance(item.get("message"), dict):
                raise TypeError("Area entry 必须包含 canonical message")
            _validate_canonical_messages([item["message"]])
            for field in ("source", "persistence_policy"):
                if field in item and not isinstance(item[field], str):
                    raise TypeError(f"Area entry {field} 必须是字符串")
        self._area_entries = values

    def update_area_entry(self, key: str, **changes: Any) -> None:
        self._ensure_mutable()
        entries = list(copy.deepcopy(self._area_entries))
        indices = [index for index, item in enumerate(entries) if item.get("area_key") == key]
        if len(indices) != 1:
            raise KeyError(f"Area entry key 无法唯一定位：{key}")
        entries[indices[0]].update({
            name: value.value if hasattr(value, "value") else value
            for name, value in changes.items()
        })
        self._area_entries = entries

    def append(self, canonical_message: dict) -> None:
        self._ensure_mutable()
        value = _validate_canonical_messages([canonical_message])[0]
        self._area_entries = [*self._area_entries, {"message": value}]

    def extend(self, canonical_messages: Iterable[dict]) -> None:
        self._ensure_mutable()
        values = _validate_canonical_messages(canonical_messages)
        self._area_entries = [*self._area_entries, *(
            {"message": message} for message in values
        )]

    def seal(self) -> "MessageBatch":
        """冻结 DTO 并计算基于 canonical 内容的稳定摘要。"""
        if self._sealed:
            return self
        self._area_entries = tuple(copy.deepcopy(self._area_entries))
        self._digest = digest({
            "entries": self._area_entries,
            "metadata": self._metadata,
        })
        self._sealed = True
        return self

    def _ensure_mutable(self) -> None:
        if self._sealed:
            raise RuntimeError("MessageBatch 已提交，不能再次修改")


def request_only_batch(provider_messages: Iterable[dict], *, metadata=None) -> MessageBatch:
    """把本轮临时 Provider 请求片段转换为 request-only canonical 增量。"""
    return MessageBatch.from_canonical_messages(
        _canonicalize_request_messages(provider_messages), metadata=metadata,
    )
