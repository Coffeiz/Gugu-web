"""按 owner 与 MemoryScope allowlist 导出记忆源文件和 IM 来源索引。"""
from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent.memory.scopes import MemoryScope
from app.models import (
    MemoryEntry, MemoryReflectionCursor, MemoryReflectionJob, MemoryScopeTombstone,
)
from app.services.data_portability.archive import ArchiveProducer
from app.services.storage import get_storage


_OWNER_CURRENT = (
    "profile.json", "pattern.json", "daily.md", "memory.md", "summary.json",
    "stance.json", "lens.json",
)
_OWNER_LEGACY = ("facts.json", "facts.md", "summary.md", "summary.ts")


async def _source_file_producer(path: str, category: str, storage, key: str) -> ArchiveProducer | None:
    before = await storage.stat(key)
    if before is None:
        return None

    async def write(stream):
        current = await storage.stat(key)
        if current is None or current.size != before.size or current.mtime != before.mtime:
            raise ValueError("记忆源文件在导出前发生变化")
        size = 0
        async for chunk in storage.iter_chunks(key):
            stream.write(chunk)
            size += len(chunk)
        after = await storage.stat(key)
        if after is None or size != before.size or after.size != before.size or (
            before.mtime is not None and after.mtime != before.mtime
        ):
            raise ValueError("记忆源文件在导出期间发生变化")
        return None

    return ArchiveProducer(path, category, write)


async def build_memory_producers(db: AsyncSession, *, user_id: UUID) -> list[ArchiveProducer]:
    """owner 源文件静态逐个登记；IM scope 清单按 owner DB 行和用户前缀取并集。"""
    storage = get_storage()
    producers: list[ArchiveProducer] = []
    current_present: set[str] = set()
    for filename in _OWNER_CURRENT:
        producer = await _source_file_producer(
            f"memory/owner/{filename}", "owner_memory", storage,
            f"{user_id}/.agent/{filename}",
        )
        if producer is not None:
            producers.append(producer)
            current_present.add(filename)
    legacy_names = []
    if "pattern.json" not in current_present:
        legacy_names.extend(("facts.json", "facts.md"))
    if "summary.json" not in current_present:
        legacy_names.extend(("summary.md", "summary.ts"))
    for filename in legacy_names:
        producer = await _source_file_producer(
            f"memory/legacy/{filename}", "owner_memory", storage,
            f"{user_id}/.agent/{filename}",
        )
        if producer is not None:
            producers.append(producer)

    scopes: dict[tuple[str, str, str, str], MemoryScope] = {}
    tombstones: set[tuple[str, str, str, str]] = set()
    for model in (MemoryReflectionCursor, MemoryEntry, MemoryReflectionJob, MemoryScopeTombstone):
        result = await db.execute(select(
            model.platform, model.bot_id, model.scope_type, model.scope_id,
        ).where(model.owner_user_id == user_id))
        for platform, bot_id, scope_type, scope_id in result.all():
            identity = (str(platform), str(bot_id), str(scope_type), str(scope_id))
            scope = MemoryScope(user_id, *identity)
            scopes[identity] = scope
            if model is MemoryScopeTombstone:
                tombstones.add(identity)

    prefix = f"{user_id}/.agent/im/"
    cursor = None
    while True:
        page, cursor = await storage.list_keys_prefix(prefix, cursor=cursor, limit=500)
        for key in page:
            _merge_scoped_key(scopes, user_id, key)
        if cursor is None:
            break

    async def write_scope_index(stream):
        count = 0
        for identity, scope in sorted(scopes.items()):
            document = {
                "platform": scope.platform, "bot_id": scope.bot_id,
                "scope_type": scope.scope_type, "scope_id": scope.scope_id,
                "deleted": identity in tombstones,
            }
            stream.write((json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode())
            count += 1
        return count

    async def write_deletion_markers(stream):
        count = 0
        for identity in sorted(tombstones):
            document = {
                "platform": identity[0], "bot_id": identity[1],
                "scope_type": identity[2], "scope_id": identity[3],
                "deleted": True,
            }
            stream.write((json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode())
            count += 1
        return count

    producers.append(ArchiveProducer("memory/im/scopes.jsonl", "im_memory", write_scope_index))
    producers.append(ArchiveProducer(
        "memory/im/deletion_markers.jsonl", "im_memory", write_deletion_markers,
    ))

    async def expand_scope_files() -> AsyncIterator[ArchiveProducer]:
        for identity, scope in sorted(scopes.items()):
            if identity in tombstones:
                continue
            scope_hash = hashlib.sha256("\0".join(identity).encode("utf-8")).hexdigest()[:32]
            for filename in scope.files:
                key = scope.key(filename)
                producer = await _source_file_producer(
                    f"memory/im/scopes/{scope_hash}/{filename}", "im_memory", storage, key,
                )
                if producer is not None:
                    yield producer

    producers.append(ArchiveProducer(category="im_memory", expand=expand_scope_files))
    return producers


def _merge_scoped_key(scopes: dict, user_id: UUID, key: str) -> None:
    """只接受 MemoryScope.files 白名单中且可严格往返的 canonical key。"""
    from urllib.parse import unquote

    parts = key.split("/")
    if len(parts) != 8 or parts[0] != str(user_id) or parts[1:3] != [".agent", "im"]:
        return
    branch = {"groups": "group", "platform-users": "platform-user"}.get(parts[5])
    if branch is None:
        return
    try:
        scope = MemoryScope(
            user_id, unquote(parts[3]), unquote(parts[4]), branch, unquote(parts[6]),
        )
    except ValueError:
        return
    if scope.key(parts[7]) != key:
        return
    identity = (scope.platform, scope.bot_id, scope.scope_type, scope.scope_id)
    scopes[identity] = scope
