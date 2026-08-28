"""Provider 无关的 Canonical Context 数据模型。

Canonical Context 只描述上下文的稳定分区，不负责把内容转换成某个供应商的
wire format。正文保留在内存对象中，诊断层只使用 digest 和结构统计。
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable


def stable_json(value: Any) -> str:
    """生成跨进程稳定的 JSON 表示，供 digest 和回归测试使用。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def digest(value: Any, *, length: int = 16) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()[:length]


@dataclass(frozen=True)
class CanonicalHistoryUnit:
    """不可拆分的历史单元。

    工具调用和对应结果必须属于同一个 unit，压缩、provider 转换和断点诊断
    都不应在二者之间切开。
    """

    messages: tuple[dict[str, Any], ...]
    kind: str = "message"

    @property
    def message_count(self) -> int:
        return len(self.messages)

    @property
    def digest(self) -> str:
        return digest(self.messages)


@dataclass(frozen=True)
class HistoryEnvelope:
    """持久化消息进入 Canonical Context 前的 provider-neutral envelope。"""

    schema_version: int
    role: str
    content_blocks: tuple[dict[str, Any], ...]
    quote: dict[str, Any] | None = None
    attachments: tuple[dict[str, Any], ...] = ()
    sender: dict[str, Any] | None = None
    sent_at: str | None = None
    source: str | None = None
    unknown_block_count: int = 0

    @property
    def digest(self) -> str:
        return digest({
            "schema_version": self.schema_version,
            "role": self.role,
            "content_blocks": self.content_blocks,
            "quote": self.quote,
            "attachments": self.attachments,
            "sender": self.sender,
            "sent_at": self.sent_at,
            "source": self.source,
        })

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "role": self.role,
            "content_blocks": list(self.content_blocks),
            "quote": self.quote,
            "attachments": list(self.attachments),
            "sender": self.sender,
            "sent_at": self.sent_at,
            "source": self.source,
        }


@dataclass(frozen=True)
class CanonicalTurn:
    """一轮可追加的历史；工具和交互往返不能跨 turn 拆分。"""

    messages: tuple[HistoryEnvelope, ...]
    kind: str = "conversation"

    @property
    def digest(self) -> str:
        return digest([message.to_dict() for message in self.messages])


_KNOWN_BLOCKS = frozenset({
    "text", "quote", "attachment_ref", "transcript", "attachment_text",
    "tool_call", "tool_use", "tool_result", "tool-schema", "skill-schema",
    "tool-discovery", "knowledge-context", "stance-context", "time-context", "runtime-context",
    "interaction_request", "interaction_result", "thinking", "reasoning_content",
})


def _value(message: Any, key: str, default: Any = None) -> Any:
    if isinstance(message, dict):
        return message.get(key, default)
    return getattr(message, key, default)


def _iso_time(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    value = str(value).strip()
    return value or None


def _attachment_ref(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    attach_id = value.get("attach_id") or value.get("id") or value.get("file_id")
    if not attach_id:
        return None
    # 只保存可重建的稳定字段，禁止把 url/base64/token 带入 canonical history。
    result = {"type": "attachment_ref", "attach_id": str(attach_id)}
    for key in ("kind", "mime", "ext", "title", "name", "size_bytes"):
        if value.get(key) is not None:
            result[key] = value[key]
    return result


def normalize_history_message(message: Any, *, source: str | None = None) -> HistoryEnvelope:
    """把 ORM 消息或平台字典归一化为 envelope，不改写输入对象。"""
    raw_blocks = _value(message, "content_json")
    if raw_blocks is None and _value(message, "role", "user") == "tool":
        raw_blocks = [{
            "type": "tool_result",
            "tool_call_id": _value(message, "tool_call_id") or _value(message, "tool_use_id"),
            "content": _value(message, "content", ""),
        }]
    elif raw_blocks is None:
        content = _value(message, "content", "")
        raw_blocks = [{"type": "text", "text": str(content or "")}] if content else []
    elif isinstance(raw_blocks, dict):
        raw_blocks = [raw_blocks]
    elif not isinstance(raw_blocks, list):
        raw_blocks = [{"type": "text", "text": str(raw_blocks)}]

    blocks: list[dict[str, Any]] = []
    unknown_count = 0
    for raw in raw_blocks:
        if not isinstance(raw, dict):
            blocks.append({"type": "text", "text": str(raw)})
            unknown_count += 1
            continue
        block_type = str(raw.get("type") or "text")
        if block_type in _KNOWN_BLOCKS:
            blocks.append(dict(raw))
        else:
            blocks.append({"type": "text", "text": stable_json(raw), "source_type": block_type})
            unknown_count += 1

    quote_text = _value(message, "quoted_text")
    quote = {"type": "quote", "text": str(quote_text)} if quote_text else None
    attachments: list[dict[str, Any]] = []
    raw_files = _value(message, "files") or _value(message, "attachments") or []
    if isinstance(raw_files, dict):
        raw_files = [raw_files]
    for item in raw_files if isinstance(raw_files, list) else []:
        ref = _attachment_ref(item)
        if ref is not None:
            attachments.append(ref)

    sender_id = _value(message, "platform_user_id")
    sender_name = _value(message, "platform_user_name")
    sender = None
    if sender_id or sender_name:
        sender = {"id": str(sender_id) if sender_id else None,
                  "name": str(sender_name) if sender_name else None}

    return HistoryEnvelope(
        schema_version=1,
        role=str(_value(message, "role", "user") or "user"),
        content_blocks=tuple(blocks),
        quote=quote,
        attachments=tuple(attachments),
        sender=sender,
        sent_at=_iso_time(_value(message, "sent_at")),
        source=source or _value(message, "source"),
        unknown_block_count=unknown_count,
    )


def tool_call_ids(message: dict[str, Any]) -> frozenset[str]:
    """返回一条消息声明的工具调用 id，不暴露参数正文。"""
    ids: set[str] = set()
    calls = message.get("tool_calls")
    if isinstance(calls, list):
        for call in calls:
            if isinstance(call, dict) and call.get("id"):
                ids.add(str(call["id"]))
    content = message.get("content")
    blocks = content if isinstance(content, list) else [content]
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") not in {"tool_call", "tool_use"}:
            continue
        value = block.get("id") or block.get("tool_call_id") or block.get("tool_use_id")
        if value:
            ids.add(str(value))
    return frozenset(ids)


def tool_result_ids(message: dict[str, Any]) -> frozenset[str]:
    """返回一条消息携带的工具结果 id。"""
    ids: set[str] = set()
    if message.get("role") == "tool" and message.get("tool_call_id"):
        ids.add(str(message["tool_call_id"]))
    content = message.get("content")
    blocks = content if isinstance(content, list) else [content]
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "tool_result":
            continue
        value = block.get("tool_call_id") or block.get("tool_use_id")
        if value:
            ids.add(str(value))
    return frozenset(ids)


def group_history_units(messages: Iterable[dict[str, Any]]) -> tuple[CanonicalHistoryUnit, ...]:
    """按工具回合归组历史，普通消息保持单消息 unit。"""
    values = [dict(message) for message in messages]
    units: list[CanonicalHistoryUnit] = []
    index = 0
    while index < len(values):
        current = values[index]
        call_ids = tool_call_ids(current)
        if call_ids and index + 1 < len(values):
            result_ids = tool_result_ids(values[index + 1])
            if result_ids and call_ids & result_ids:
                units.append(CanonicalHistoryUnit((current, values[index + 1]), kind="tool_turn"))
                index += 2
                continue
        units.append(CanonicalHistoryUnit((current,), kind="message"))
        index += 1
    return tuple(units)


@dataclass(frozen=True)
class CanonicalContext:
    """一次模型请求的五个稳定语义分区。"""

    static_system: tuple[dict[str, Any], ...] = ()
    session_snapshot: tuple[dict[str, Any], ...] = ()
    canonical_history: tuple[dict[str, Any], ...] = ()
    current_turn: tuple[dict[str, Any], ...] = ()
    history_units: tuple[CanonicalHistoryUnit, ...] = field(default_factory=tuple)

    @property
    def section_digests(self) -> dict[str, str]:
        return {
            "static_system": digest(self.static_system),
            "session_snapshot": digest(self.session_snapshot),
            "canonical_history": digest(self.canonical_history),
            "current_turn": digest(self.current_turn),
        }

    @property
    def canonical_digest(self) -> str:
        return digest(self.section_digests)

    def diagnostics(self) -> dict[str, Any]:
        """只返回可安全写入 trace 的结构信息。"""
        return {
            "canonical_digest": self.canonical_digest,
            "section_digests": self.section_digests,
            "section_counts": {
                "static_system": len(self.static_system),
                "session_snapshot": len(self.session_snapshot),
                "canonical_history": len(self.canonical_history),
                "current_turn": len(self.current_turn),
            },
            "history_unit_count": len(self.history_units),
            "tool_turn_count": sum(unit.kind == "tool_turn" for unit in self.history_units),
        }
