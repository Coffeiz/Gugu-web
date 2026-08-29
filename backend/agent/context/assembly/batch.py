"""本轮新增消息批次。"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Iterable

from ..canonical_context import digest


class _FrozenMessages(list):
    """提交后阻止通过公开 messages 列表修改批次外层结构。"""

    def _raise(self, *args, **kwargs):
        raise RuntimeError("NewMessageBatch 已提交，不能再次修改")

    __setitem__ = __delitem__ = append = clear = extend = insert = pop = remove = reverse = sort = _raise


_CANONICAL_BLOCK_TYPES = frozenset({
    "text", "tool_call", "tool_result", "tool-schema", "skill-schema",
    "tool-discovery", "knowledge-context", "stance-context", "time-context",
    "runtime-context",
})


def _validate_canonical_messages(messages: Iterable[dict]) -> list[dict]:
    """校验 canonical batch 的外形，避免把 provider wire 泄漏进历史契约。"""
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


@dataclass
class NewMessageBatch:
    """本轮新增消息的唯一组装结果。"""

    messages: list[dict] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    canonical_exclude_indexes: tuple[int, ...] = ()
    _sealed: bool = field(default=False, init=False, repr=False)
    _digest: str = field(default="", init=False, repr=False)
    _provider_digest: str = field(default="", init=False, repr=False)
    _canonical_messages: tuple[dict, ...] = field(default=(), init=False, repr=False)
    _provider_messages: tuple[dict, ...] = field(default=(), init=False, repr=False)
    _canonical_initialized: bool = field(default=False, init=False, repr=False)
    _provider_initialized: bool = field(default=False, init=False, repr=False)

    def __post_init__(self) -> None:
        self.messages = list(self.messages)
        self.canonical_exclude_indexes = tuple(sorted({
            int(index) for index in self.canonical_exclude_indexes
            if 0 <= int(index) < len(self.messages)
        }))

    @property
    def sealed(self) -> bool:
        return self._sealed

    @property
    def batch_digest(self) -> str:
        return self._digest or digest({"messages": self.messages, "metadata": self.metadata})

    @property
    def provider_digest(self) -> str:
        """provider 投影指纹，仅用于诊断，不作为历史身份。"""
        return self._provider_digest or digest(self.messages)

    @property
    def canonical_messages(self) -> tuple[dict, ...]:
        return tuple(copy.deepcopy(self._canonical_messages))

    @property
    def provider_messages(self) -> tuple[dict, ...]:
        """返回 provider 投影副本，防止提交后反向修改 batch。"""
        source = self._provider_messages if self._provider_initialized else self.messages
        return tuple(copy.deepcopy(source))

    @classmethod
    def from_provider_messages(
        cls, messages: Iterable[dict], *, metadata: dict[str, Any] | None = None
    ) -> "NewMessageBatch":
        """兼容旧创建点，但在创建边界立即固定 canonical 快照。"""
        provider_messages = list(messages)
        instance = cls(provider_messages, metadata=metadata or {})
        from ..history import canonicalize_tool_messages
        instance._canonical_messages = tuple(
            _validate_canonical_messages(canonicalize_tool_messages(provider_messages))
        )
        instance._provider_messages = tuple(copy.deepcopy(provider_messages))
        instance._canonical_initialized = True
        instance._provider_initialized = True
        return instance

    @classmethod
    def from_canonical_messages(
        cls,
        canonical_messages: Iterable[dict],
        *,
        provider_messages: Iterable[dict] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "NewMessageBatch":
        """以 canonical batch 为事实源，附带一次性的 provider 请求投影。"""
        canonical = _validate_canonical_messages(canonical_messages)
        provider = copy.deepcopy(list(provider_messages)) if provider_messages is not None else copy.deepcopy(canonical)
        instance = cls(provider, metadata=metadata or {})
        instance._canonical_messages = tuple(canonical)
        instance._provider_messages = tuple(provider)
        instance._canonical_initialized = True
        instance._provider_initialized = True
        return instance

    def seal(self) -> "NewMessageBatch":
        """冻结批次并生成唯一 canonical 投影；重复调用保持同一 digest。"""
        if self._sealed:
            return self
        self.messages = copy.deepcopy(self.messages)
        if not self._canonical_initialized:
            from ..history import canonicalize_tool_messages
            excluded = set(self.canonical_exclude_indexes)
            canonical_source = [
                message for index, message in enumerate(self.messages)
                if index not in excluded
            ]
            self._canonical_messages = tuple(
                _validate_canonical_messages(canonicalize_tool_messages(canonical_source))
            )
            self._canonical_initialized = True
        if not self._provider_initialized:
            self._provider_messages = tuple(copy.deepcopy(self.messages))
            self._provider_initialized = True
        self._provider_digest = digest(self.messages)
        self._digest = digest({"messages": self._canonical_messages, "metadata": self.metadata})
        self.messages = _FrozenMessages(self.messages)
        self._sealed = True
        return self

    def _ensure_mutable(self) -> None:
        if self._sealed:
            raise RuntimeError("NewMessageBatch 已提交，不能再次修改")

    def extend(self, messages: Iterable[dict]) -> None:
        self._ensure_mutable()
        values = list(messages)
        self.messages.extend(copy.deepcopy(values))
        if self._canonical_initialized:
            from ..history import canonicalize_tool_messages
            self._canonical_messages = self._canonical_messages + tuple(
                _validate_canonical_messages(canonicalize_tool_messages(values))
            )
        if self._provider_initialized:
            self._provider_messages = self._provider_messages + tuple(copy.deepcopy(values))

    def append(self, message: dict) -> None:
        self._ensure_mutable()
        value = copy.deepcopy(message)
        self.messages.append(value)
        if self._canonical_initialized:
            from ..history import canonicalize_tool_messages
            self._canonical_messages = self._canonical_messages + tuple(
                _validate_canonical_messages(canonicalize_tool_messages([value]))
            )
        if self._provider_initialized:
            self._provider_messages = self._provider_messages + (copy.deepcopy(value),)
