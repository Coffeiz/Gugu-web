"""工具声明与调用的 provider-neutral 历史格式。

Canonical event 只存在于内部历史；发送给 Provider 前由 adapter 渲染成普通文本，
不会伪装成 ``tool_result``，也不会把某一家 Provider 的 wire format 持久化为长期契约。
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def schema_digest(schema: dict) -> str:
    return hashlib.sha256(_canonical_json(schema).encode("utf-8")).hexdigest()[:16]


_CANONICAL_EVENT_TYPES = frozenset({
    "tool_call", "tool_result", "tool-schema", "skill-schema", "tool-discovery",
})


def canonical_event_stats(messages: list[dict]) -> dict[str, Any]:
    """汇总 canonical history 的脱敏统计，不返回工具参数或正文。"""
    by_type: dict[str, int] = {}
    digests: set[str] = set()
    count = 0
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        blocks = content if isinstance(content, list) else []
        for block in blocks:
            if not isinstance(block, dict):
                continue
            event_type = str(block.get("type") or "")
            if event_type not in _CANONICAL_EVENT_TYPES:
                continue
            count += 1
            by_type[event_type] = by_type.get(event_type, 0) + 1
            digest = str(block.get("schema_digest") or "")
            if digest:
                digests.add(digest)
    return {
        "count": count,
        "by_type": dict(sorted(by_type.items())),
        "schema_digests": sorted(digests),
    }


@dataclass(frozen=True)
class ToolSchemaEvent:
    tool_name: str
    schema_version: int
    schema_digest: str
    schema: dict
    event_type: str = "tool-schema"

    def to_block(self) -> dict:
        return {"type": self.event_type, **asdict(self)}


@dataclass(frozen=True)
class SkillSchemaEvent:
    skill_name: str
    tool_names: tuple[str, ...]
    event_type: str = "skill-schema"

    def to_block(self) -> dict:
        return {"type": self.event_type, **asdict(self)}


@dataclass(frozen=True)
class ToolDiscoveryEvent:
    tool_names: tuple[str, ...]
    event_type: str = "tool-discovery"

    def to_block(self) -> dict:
        return {"type": self.event_type, **asdict(self)}


def tool_schema_event(tool) -> ToolSchemaEvent:
    schema = {
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.input_schema,
    }
    return ToolSchemaEvent(
        tool_name=tool.name,
        schema_version=int(getattr(tool, "schema_version", 1) or 1),
        schema_digest=schema_digest(schema),
        schema=schema,
    )


def append_event(messages: list[dict], event) -> None:
    """追加一个可重放的 canonical event；相同版本/digest 不重复追加。"""
    block = event.to_block()
    key = (block.get("type"), block.get("tool_name"), block.get("schema_digest"), block.get("skill_name"))
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        blocks = content if isinstance(content, list) else []
        for existing in blocks:
            if not isinstance(existing, dict):
                continue
            existing_key = (
                existing.get("type"), existing.get("tool_name"),
                existing.get("schema_digest"), existing.get("skill_name"),
            )
            if existing_key == key:
                return
    messages.append({"role": "user", "content": [block]})


def event_text(block: dict) -> str:
    """把 canonical event 渲染成模型可读、但不依赖 Provider schema 的文本。"""
    kind = block.get("type")
    if kind == "tool-schema":
        schema = block.get("schema") or {}
        return (
            "[canonical tool-schema]\n"
            f"工具名：{block.get('tool_name', '')}\n"
            f"版本：{block.get('schema_version', 1)}\n"
            f"Schema：{_canonical_json(schema)}"
        )
    if kind == "skill-schema":
        names = ", ".join(str(item) for item in block.get("tool_names") or ())
        return f"[canonical skill-schema]\n技能：{block.get('skill_name', '')}\n关联工具：{names}"
    if kind == "tool-discovery":
        names = ", ".join(str(item) for item in block.get("tool_names") or ())
        return f"[canonical tool-discovery]\n可用工具：{names}"
    return ""


def render_events_for_provider(messages: list[dict]) -> list[dict]:
    """复制并渲染 canonical blocks，原始历史保持可持久化和可重放。"""
    rendered: list[dict] = []
    for message in messages:
        clone = dict(message)
        content = clone.get("content")
        if isinstance(content, list):
            ordinary: list[Any] = []
            event_lines: list[str] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") in {
                    "tool-schema", "skill-schema", "tool-discovery",
                }:
                    text = event_text(block)
                    if text:
                        event_lines.append(text)
                else:
                    ordinary.append(block)
            if event_lines:
                if ordinary:
                    ordinary.append({"type": "text", "text": "\n\n".join(event_lines)})
                    clone["content"] = ordinary
                else:
                    clone["content"] = "\n\n".join(event_lines)
        rendered.append(clone)
    return rendered
