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
    "tool_call", "tool_result", "tool-schema", "skill-schema", "tool-discovery", "knowledge-context",
})


def _tool_result_is_error(block: dict[str, Any]) -> bool:
    """从 provider-neutral 结果中判断失败，不读取或记录结果正文。"""
    if "is_error" in block:
        return bool(block["is_error"])
    content = block.get("content", "")
    values = content if isinstance(content, list) else [content]
    for value in values:
        if isinstance(value, dict) and value.get("error"):
            return True
        if isinstance(value, str):
            try:
                payload = json.loads(value)
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict) and payload.get("error"):
                return True
    return False


@dataclass
class ToolCall:
    """Provider-neutral 的工具调用。

    ``input`` 统一采用 Anthropic 侧更直观的命名；写入 canonical history 时
    转成稳定的 ``arguments`` 字段，provider adapter 再负责渲染成各自格式。
    """

    id: str
    name: str
    input: Any

    @property
    def arguments(self) -> Any:
        """兼容 OpenAI 语义的只读别名，避免调用方重复转换字段。"""
        return self.input

    @classmethod
    def from_block(cls, block: dict[str, Any]) -> "ToolCall":
        value = block.get("arguments", block.get("input", {}))
        return cls(
            id=str(block.get("id") or block.get("tool_call_id") or block.get("tool_use_id") or "tool-call"),
            name=str(block.get("name") or "unknown_tool"),
            input=value if isinstance(value, (dict, list, str)) else {},
        )

    def to_block(self) -> dict[str, Any]:
        return {
            "type": "tool_call",
            "id": self.id,
            "name": self.name,
            "arguments": self.input,
        }


@dataclass
class ToolResult:
    """Provider-neutral 的工具结果，保留错误状态供 adapter 和 UI 判断。"""

    tool_call_id: str
    content: Any
    is_error: bool = False
    tool_name: str | None = None

    @classmethod
    def from_block(cls, block: dict[str, Any]) -> "ToolResult":
        return cls(
            tool_call_id=str(block.get("tool_call_id") or block.get("tool_use_id") or ""),
            content=block.get("content", ""),
            is_error=_tool_result_is_error(block),
            tool_name=str(block["tool_name"]) if block.get("tool_name") else None,
        )

    def to_block(self) -> dict[str, Any]:
        block: dict[str, Any] = {
            "type": "tool_result",
            "tool_call_id": self.tool_call_id,
            "content": self.content,
        }
        if self.is_error:
            block["is_error"] = True
        if self.tool_name:
            block["tool_name"] = self.tool_name
        return block


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
    if kind == "knowledge-context":
        return str(block.get("text") or "")
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
                    "tool-schema", "skill-schema", "tool-discovery", "knowledge-context",
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
