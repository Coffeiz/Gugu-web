"""Knowledge 时间戳 ISO 8601 迁移。"""

from __future__ import annotations

import json
import asyncio
from datetime import datetime, timezone

from app.core.redaction import diag_log
from app.services.storage import get_storage


_ENTRY_MARKER = "/.agent/knowledge/entries/"
_FORMAT_MARKER = "/.agent/knowledge/.timestamps-iso-v1"
_TIMESTAMP_KEYS = {"created_at", "updated_at", "checked_at"}
_MIGRATION_MARKER_CONTENT = b"knowledge-timestamps=iso8601-utc-v1\n"
_LIST_PAGE_SIZE = 500


class KnowledgeTimestampMigrationError(RuntimeError):
    """Knowledge 时间格式迁移失败。"""


async def _list_user_entry_keys(storage, user_id: object) -> list[str]:
    """分页读取单用户知识目录，避免遍历其他用户或工作区文件。"""
    prefix = f"{user_id}{_ENTRY_MARKER}"
    keys: list[str] = []
    cursor = None
    while True:
        page, cursor = await storage.list_keys_prefix(
            prefix, cursor=cursor, limit=_LIST_PAGE_SIZE,
        )
        keys.extend(key for key in page if key.startswith(prefix) and key.endswith(".md"))
        if cursor is None:
            return keys


def _iso_timestamp(value: object) -> str:
    if isinstance(value, bool):
        raise ValueError("布尔值不是时间戳")
    if isinstance(value, (int, float)):
        instant = datetime.fromtimestamp(float(value), timezone.utc)
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            raise ValueError("时间戳为空")
        instant = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
        if instant.tzinfo is None:
            raise ValueError("ISO 时间戳必须包含时区")
        instant = instant.astimezone(timezone.utc)
    else:
        raise ValueError("时间戳类型无效")
    return instant.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _epoch_timestamp(value: object) -> float:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Knowledge 时间戳必须是 ISO 8601 字符串")
    text = value.strip()
    instant = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    if instant.tzinfo is None:
        raise ValueError("ISO 时间戳必须包含时区")
    return instant.timestamp()


def _map_timestamps(value: object, convert) -> object:
    if isinstance(value, dict):
        return {
            key: (convert(item) if key in _TIMESTAMP_KEYS and item is not None
                  else _map_timestamps(item, convert))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_map_timestamps(item, convert) for item in value]
    return value


def _parse_frontmatter(raw: bytes) -> tuple[list[str], str, str]:
    text = raw.decode("utf-8")
    if not text.startswith("---\n"):
        raise ValueError("知识文件缺少 frontmatter")
    marker = text.find("\n---\n", 4)
    if marker < 0:
        raise ValueError("知识文件 frontmatter 未闭合")
    return text[4:marker].splitlines(), text[marker + len("\n---\n"):], "---\n"


def _rewrite_frontmatter_line(line: str) -> tuple[str, bool, str | None]:
    if ":" not in line:
        return line, False, None
    key, raw_value = line.split(":", 1)
    key = key.strip()
    value = raw_value.strip()
    if key in {"created_at", "updated_at"}:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            parsed = value
        normalized = _iso_timestamp(parsed)
        return f"{key}: {normalized}", normalized != value, key
    if key in {"source_json", "history_json"}:
        try:
            parsed_json = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError("Knowledge 时间戳元数据格式无效") from exc
        normalized_json = _map_timestamps(parsed_json, _iso_timestamp)
        serialized = json.dumps(normalized_json, ensure_ascii=False, separators=(",", ":"))
        return f"{key}: {serialized}", serialized != value, key
    return line, False, key


def _rewrite_document(raw: bytes) -> tuple[bytes, bool]:
    lines, body, opening = _parse_frontmatter(raw)
    rewritten: list[str] = []
    changed = False
    found = set()
    for line in lines:
        new_line, line_changed, key = _rewrite_frontmatter_line(line)
        rewritten.append(new_line)
        changed = changed or line_changed
        if key in {"created_at", "updated_at"}:
            found.add(key)
    if found != {"created_at", "updated_at"}:
        raise ValueError("Knowledge 文件缺少创建或更新时间")
    if not changed:
        return raw, False
    return (opening + "\n".join(rewritten) + "\n---\n" + body).encode("utf-8"), True


def _storage_identity(storage) -> tuple[str, str]:
    root = getattr(storage, "root", None)
    if root is not None:
        return (type(storage).__qualname__, str(root))
    bucket = getattr(storage, "bucket", None)
    location = ":".join((
        str(getattr(bucket, "endpoint", "")),
        str(getattr(bucket, "bucket_name", "")),
        str(getattr(storage, "pfx", "")),
    ))
    return type(storage).__qualname__, location


_checked_users: set[tuple[tuple[str, str], str]] = set()
_locks: dict[tuple[tuple[str, str], str], asyncio.Lock] = {}


async def migrate_user_knowledge_timestamps(
    user_id: object, *, storage=None, _known_keys: list[str] | None = None
) -> int:
    """迁移单用户知识文件；重复执行安全，成功后写入用户级完成标记。"""
    storage = storage or get_storage()
    user = str(user_id)
    identity = (_storage_identity(storage), user)
    if identity in _checked_users:
        return 0
    lock = _locks.setdefault(identity, asyncio.Lock())
    async with lock:
        if identity in _checked_users:
            return 0
        marker = f"{user}{_FORMAT_MARKER}"
        try:
            marker_exists = await storage.exists(marker)
        except Exception:
            raise KnowledgeTimestampMigrationError(
                "无法确认 Knowledge 时间迁移状态；读取已暂停，可重试迁移"
            ) from None
        if marker_exists:
            _checked_users.add(identity)
            return 0

        prefix = f"{user}{_ENTRY_MARKER}"
        converted = 0
        try:
            keys = (
                _known_keys if _known_keys is not None
                else await _list_user_entry_keys(storage, user_id)
            )
            for key in keys:
                if not key.startswith(prefix) or not key.endswith(".md"):
                    continue
                raw = await storage.get(key)
                rewritten, changed = _rewrite_document(raw)
                if changed:
                    await storage.put(key, rewritten, "text/markdown; charset=utf-8")
                    converted += 1
            await storage.put(marker, _MIGRATION_MARKER_CONTENT, "text/plain; charset=utf-8")
        except Exception as exc:
            diag_log("knowledge.timestamp_migration", exc)
            raise KnowledgeTimestampMigrationError(
                "Knowledge 时间戳迁移未完成；读取已暂停，可重试迁移"
            ) from None
        _checked_users.add(identity)
        return converted


async def migrate_all_knowledge_timestamps(*, storage=None) -> tuple[int, int]:
    """扫描所有用户并迁移 Knowledge 文件，返回（用户数、转换文件数）。"""
    storage = storage or get_storage()
    keys = await storage.list_keys()
    users = sorted({key.split(_ENTRY_MARKER, 1)[0] for key in keys if _ENTRY_MARKER in key})
    converted = 0
    for user_id in users:
        converted += await migrate_user_knowledge_timestamps(
            user_id, storage=storage, _known_keys=keys
        )
    return len(users), converted
