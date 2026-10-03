"""单次请求的不可变 Provider wire conversation。"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator

from .canonical_context import digest


@dataclass(frozen=True, init=False)
class ProviderConversation:
    """Provider 请求专属快照。

    消息正文以私有 JSON 快照保存，调用方每次读取均得到深拷贝；cache marker、
    role/event 转换和临时历史修复因此不能反向污染 MessageArea 或源消息视图。
    ``area_snapshot`` 是渲染所依据的 canonical 身份，不暴露可变正文引用。
    """

    _messages_json: tuple[str, ...] = field(repr=False)
    area_revision: int | None
    area_digest: str
    area_entry_count: int
    canonical_digest: str
    fixed_prefix_size: int
    dynamic_tail_size: int
    _diagnostics_json: str = field(repr=False)
    cache_plan: Any
    canonical_context: Any
    _area_prefix_digests: tuple[str, ...] = field(repr=False)

    def __init__(
        self,
        messages: Iterable[dict],
        *,
        source=None,
        area_snapshot=None,
        area_revision: int | None = None,
        area_digest: str = "",
        area_entry_count: int | None = None,
        canonical_digest: str = "",
        fixed_prefix_size: int | None = None,
        dynamic_tail_size: int | None = None,
        diagnostics: dict[str, Any] | None = None,
        cache_plan=None,
        canonical_context=None,
        _area_prefix_digests: tuple[str, ...] | None = None,
    ) -> None:
        values = list(messages)
        encoded = tuple(json.dumps(
            item, ensure_ascii=False, separators=(",", ":"),
        ) for item in values)
        area_snapshot = _resolve_area_snapshot(source, area_snapshot)
        entries = tuple(getattr(area_snapshot, "entries", ()) or ())
        prefix_digests = _resolve_area_prefix_digests(entries, _area_prefix_digests)
        source_fixed, source_tail = _resolve_boundaries(source)
        resolved_area_revision = _resolve_area_revision(area_snapshot, area_revision)
        resolved_area_digest = _resolve_area_digest(area_snapshot, area_digest)
        resolved_entry_count = _resolve_entry_count(entries, area_entry_count)
        object.__setattr__(self, "_messages_json", encoded)
        object.__setattr__(self, "area_revision", resolved_area_revision)
        object.__setattr__(self, "area_digest", resolved_area_digest)
        object.__setattr__(self, "area_entry_count", resolved_entry_count)
        object.__setattr__(self, "canonical_digest", canonical_digest or str(
            getattr(area_snapshot, "digest", "") or ""
        ))
        object.__setattr__(self, "fixed_prefix_size", _nonnegative(
            source_fixed if fixed_prefix_size is None else fixed_prefix_size,
        ))
        object.__setattr__(self, "dynamic_tail_size", _nonnegative(
            source_tail if dynamic_tail_size is None else dynamic_tail_size,
        ))
        object.__setattr__(self, "_diagnostics_json", json.dumps(
            diagnostics or {}, ensure_ascii=False, separators=(",", ":"), default=str,
        ))
        object.__setattr__(self, "cache_plan", cache_plan)
        object.__setattr__(self, "canonical_context", (
            canonical_context if canonical_context is not None
            else getattr(source, "canonical_context", None)
        ))
        object.__setattr__(self, "_area_prefix_digests", tuple(prefix_digests))

    @property
    def conversation_count(self) -> int:
        return max(0, len(self._messages_json) - self.dynamic_tail_size)

    @property
    def conversation(self) -> list[dict]:
        return self.to_messages()[:self.conversation_count]

    @property
    def dynamic_tail(self) -> list[dict]:
        return self.to_messages()[self.conversation_count:]

    @property
    def wire_digest(self) -> str:
        return digest(self.to_messages())

    @property
    def diagnostics(self) -> dict[str, Any]:
        return json.loads(self._diagnostics_json)

    def to_messages(self) -> list[dict]:
        return [json.loads(item) for item in self._messages_json]

    def area_prefix_digest(self, count: int) -> str:
        if count < 0 or count >= len(self._area_prefix_digests):
            return ""
        return self._area_prefix_digests[count]

    def projection_prefix_digest(self, count: int) -> str:
        if count < 0 or count > self.conversation_count:
            return ""
        return digest([
            _without_cache_control(json.loads(item))
            for item in self._messages_json[:count]
        ])

    def with_messages(
        self,
        messages: Iterable[dict],
        *,
        fixed_prefix_size: int | None = None,
        dynamic_tail_size: int | None = None,
        diagnostics: dict[str, Any] | None = None,
        cache_plan=None,
    ) -> "ProviderConversation":
        return ProviderConversation(
            messages,
            area_revision=self.area_revision,
            area_digest=self.area_digest,
            area_entry_count=self.area_entry_count,
            canonical_digest=self.canonical_digest,
            fixed_prefix_size=(self.fixed_prefix_size if fixed_prefix_size is None else fixed_prefix_size),
            dynamic_tail_size=(self.dynamic_tail_size if dynamic_tail_size is None else dynamic_tail_size),
            diagnostics=self.diagnostics | (diagnostics or {}),
            cache_plan=self.cache_plan if cache_plan is None else cache_plan,
            canonical_context=self.canonical_context,
            _area_prefix_digests=self._area_prefix_digests,
        )

    def __iter__(self) -> Iterator[dict]:
        return iter(self.to_messages())

    def __len__(self) -> int:
        return len(self._messages_json)

    def __getitem__(self, index):
        return self.to_messages()[index]

    def __eq__(self, other) -> bool:
        if isinstance(other, ProviderConversation):
            return self.to_messages() == other.to_messages()
        return NotImplemented


def _without_cache_control(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_cache_control(item)
            for key, item in value.items()
            if key != "cache_control"
        }
    if isinstance(value, list):
        return [_without_cache_control(item) for item in value]
    return value


def _resolve_area_snapshot(source, snapshot):
    if snapshot is not None or source is None:
        return snapshot
    from .assembly.area import MessageArea
    return source.snapshot() if isinstance(source, MessageArea) else None


def _resolve_area_prefix_digests(entries, existing) -> tuple[str, ...]:
    if existing:
        return tuple(existing)
    values = [digest([])]
    for entry in entries:
        values.append(digest({
            "prefix": values[-1],
            "sequence": entry.sequence,
            "message": entry.canonical_message,
        }))
    return tuple(values)


def _resolve_boundaries(source) -> tuple[int, int]:
    fixed = getattr(source, "fixed_prefix_size", 0)
    tail = len(getattr(source, "dynamic_tail", ()) or ())
    return fixed, tail


def _resolve_area_revision(snapshot, value):
    return value if value is not None else getattr(snapshot, "revision", None)


def _resolve_area_digest(snapshot, value) -> str:
    return str(value or getattr(snapshot, "digest", "") or "")


def _resolve_entry_count(entries, value) -> int:
    return len(entries) if value is None else int(value)


def _nonnegative(value) -> int:
    return max(0, int(value))
