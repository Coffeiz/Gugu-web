"""Knowledge Markdown 主数据存储。"""

from __future__ import annotations

import json
import re
import uuid
from typing import Iterable

from app.services.storage import get_storage

from .models import KnowledgeEntry, KnowledgeScope, KnowledgeSource


_PREFIX = "/.agent/knowledge/entries/"
_MAX_TITLE = 80
_MAX_TOPIC = 40
_MAX_CONTENT = 1000
_MAX_SOURCE_LABEL = 120
_MAX_SOURCE_REF = 300
_MAX_HISTORY = 5
_MAX_TOTAL_BYTES = 32 * 1024 * 1024


def _prefix(user_id: object) -> str:
    return f"{user_id}{_PREFIX}"


def _path(user_id: object, entry_id: str) -> str:
    return f"{_prefix(user_id)}{entry_id}.md"


def _norm(value: str) -> str:
    return re.sub(r"\s+", "", (value or "").strip().casefold())


def _frontmatter_value(value: object) -> str:
    if isinstance(value, str):
        return value.replace("\\", "\\\\").replace("\n", "\\n")
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _unescape(value: str) -> str:
    return value.replace("\\n", "\n").replace("\\\\", "\\")


def _serialize(entry: KnowledgeEntry) -> bytes:
    metadata = {
        "id": entry.id,
        "title": entry.title,
        "topic": entry.topic,
        "scope_json": entry.scope.__dict__,
        "source_json": entry.source.to_dict(),
        "confidence": entry.confidence,
        "version": entry.version,
        "parent_id": entry.parent_id or "",
        "created_at": entry.created_at,
        "updated_at": entry.updated_at,
        "active": entry.active,
        "history_json": entry.history,
    }
    lines = ["---"]
    for key, value in metadata.items():
        lines.append(f"{key}: {_frontmatter_value(value)}")
    lines.extend(("---", "", entry.content, ""))
    return "\n".join(lines).encode("utf-8")


def _parse(raw: bytes) -> KnowledgeEntry:
    text = raw.decode("utf-8", errors="replace")
    if not text.startswith("---\n"):
        raise ValueError("知识文件缺少 frontmatter")
    marker = text.find("\n---\n", 4)
    if marker < 0:
        raise ValueError("知识文件 frontmatter 未闭合")
    fields: dict[str, str] = {}
    for line in text[4:marker].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip()] = _unescape(value.strip())

    def obj(name: str, default):
        try:
            return json.loads(fields.get(name, ""))
        except (TypeError, ValueError):
            return default

    content = text[marker + len("\n---\n"):].rstrip("\n")
    if content.startswith("\n"):
        content = content[1:]
    return KnowledgeEntry.from_dict({
        "id": fields["id"],
        "title": fields.get("title", ""),
        "topic": fields.get("topic", ""),
        "content": content,
        "scope": obj("scope_json", {}),
        "source": obj("source_json", {}),
        "confidence": fields.get("confidence", "confirmed"),
        "version": fields.get("version", "1"),
        "parent_id": fields.get("parent_id") or None,
        "created_at": fields.get("created_at"),
        "updated_at": fields.get("updated_at"),
        "active": fields.get("active", "true").lower() == "true",
        "history": obj("history_json", []),
    })


def _validate(entry: KnowledgeEntry) -> None:
    for name, value, limit in (
        ("title", entry.title, _MAX_TITLE),
        ("topic", entry.topic, _MAX_TOPIC),
        ("content", entry.content, _MAX_CONTENT),
        ("source_label", entry.source.label, _MAX_SOURCE_LABEL),
        ("source_ref", entry.source.ref, _MAX_SOURCE_REF),
    ):
        if len(value) > limit:
            raise ValueError(f"{name} 不能超过 {limit} 个字符")
    if len(entry.history) > _MAX_HISTORY:
        entry.history = entry.history[-_MAX_HISTORY:]


class KnowledgeStore:
    def __init__(self, user_id: object):
        self.user_id = user_id

    async def list(self, *, scope: KnowledgeScope | None = None, active_only: bool = True) -> list[KnowledgeEntry]:
        storage = get_storage()
        try:
            keys = await storage.list_keys()
        except Exception:
            return []
        entries: list[KnowledgeEntry] = []
        for key in keys:
            if not key.startswith(_prefix(self.user_id)) or not key.endswith(".md"):
                continue
            try:
                entry = _parse(await storage.get(key))
            except (KeyError, TypeError, ValueError, OSError):
                continue
            if active_only and not entry.active:
                continue
            if scope is not None and not self.matches_scope(entry.scope, scope):
                continue
            entries.append(entry)
        return sorted(entries, key=lambda item: (item.updated_at, item.id), reverse=True)

    async def save(self, entry: KnowledgeEntry) -> KnowledgeEntry:
        _validate(entry)
        entries = await self.list(active_only=False)
        same_scope = [item for item in entries if self.matches_scope(item.scope, entry.scope)]
        candidates = [item for item in same_scope if item.active and item.topic and entry.topic and
                      _norm(item.topic) == _norm(entry.topic)]
        current = next((item for item in candidates if item.id == entry.id), None)
        current = current or next((item for item in candidates if item.source.type == entry.source.type), None)
        current = current or (candidates[0] if candidates else None)
        if current is not None:
            if _norm(current.content) == _norm(entry.content):
                return current
            if entry.source.type != "user" and current.source.type != entry.source.type:
                entry.confidence = "conflict"
                entry.parent_id = current.id
            else:
                entry.history = [*current.history, {
                    "version": current.version,
                    "title": current.title,
                    "content": current.content,
                    "source": current.source.to_dict(),
                    "confidence": current.confidence,
                    "updated_at": current.updated_at,
                }][-_MAX_HISTORY:]
                entry.id = current.id
                entry.version = max(current.version + 1, entry.version)
                entry.created_at = current.created_at
        projected = [item for item in entries if item.id != entry.id]
        projected.append(entry)
        if sum(len(_serialize(item)) for item in projected) > _MAX_TOTAL_BYTES:
            raise ValueError("Knowledge 总量不能超过 32 MB")
        await self._write_entry(entry)
        return entry

    async def delete(self, entry_id: str) -> bool:
        entries = await self.list(active_only=True)
        entry = next((item for item in entries if item.id == entry_id), None)
        if entry is None:
            return False
        entry.active = False
        await self._write_entry(entry)
        return True

    async def _write_entry(self, entry: KnowledgeEntry) -> None:
        _validate(entry)
        storage = get_storage()
        target = _path(self.user_id, entry.id)
        temporary = f"{_prefix(self.user_id)}.tmp-{uuid.uuid4().hex}.md"
        await storage.put(temporary, _serialize(entry), "text/markdown; charset=utf-8")
        try:
            await storage.rename_file(temporary, target)
        except Exception:
            await storage.delete(temporary)
            raise

    async def _write(self, entries: Iterable[KnowledgeEntry]) -> None:
        """批量写入口仅供迁移/测试使用；正常业务使用单文件原子写入。"""
        for entry in entries:
            await self._write_entry(entry)

    @staticmethod
    def matches_scope(actual: KnowledgeScope, wanted: KnowledgeScope) -> bool:
        if actual.owner_user_id != wanted.owner_user_id or actual.type != wanted.type:
            return False
        for field in ("platform", "bot_id", "group_id", "type", "scope_id", "project_id"):
            value = getattr(wanted, field)
            if value and getattr(actual, field) != value:
                return False
        return True


def source_from_input(source_type: str, source_ref: str = "", source_label: str = "") -> KnowledgeSource:
    allowed = {"user", "file", "web", "derived", "conversation"}
    if source_type not in allowed:
        raise ValueError("source_type 只能是 user、file、web、derived 或 conversation")
    source_ref = source_ref.strip()
    source_label = source_label.strip()
    if len(source_ref) > _MAX_SOURCE_REF:
        raise ValueError(f"source_ref 不能超过 {_MAX_SOURCE_REF} 个字符")
    if len(source_label) > _MAX_SOURCE_LABEL:
        raise ValueError(f"source_label 不能超过 {_MAX_SOURCE_LABEL} 个字符")
    return KnowledgeSource(type=source_type, ref=source_ref, label=source_label)


__all__ = ["KnowledgeStore", "source_from_input"]
