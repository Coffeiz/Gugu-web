"""全量替换需要的快照与数据库切换原语。"""
from __future__ import annotations

import tempfile
import hashlib
import json
import zipfile
from uuid import UUID

from sqlalchemy import delete, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ChatAttachment, DataPortableIdentity, KnowledgeIndexEntry, MemoryReflectionCursor,
    MemoryReflectionJob, MemoryScopeTombstone, RagIndexJob, User,
)
from app.services.data_portability.archive import build_encrypted_archive
from app.services.data_portability.identity_map import SQLitePortableIdentityMap
from app.services.data_portability.producers import build_record_producers
from app.services.data_portability.projection import RECORD_SPECS, _pending_attachment_ids, select_owned_records
from app.services.data_portability.schema import PORTABLE_CATEGORIES
from app.services.storage import StorageBackend
from app.services.data_portability.schema import PortableArchiveManifest
from agent.memory.scopes import MemoryScope


ROLLBACK_TTL_SECONDS = 7 * 24 * 60 * 60


def rollback_context(user_id: UUID, job_id: UUID) -> str:
    return f"data-portability-rollback:{user_id.hex}:{job_id.hex}"


async def create_rollback_snapshot(
    *, user_id: UUID, job_id: UUID, session_factory, storage: StorageBackend,
) -> tuple[str, int, str]:
    """以完整归档格式加密当前可移植数据，持久化后才允许替换进入应用阶段。"""
    key = f"{user_id.hex}/.data-portability/rollback/{job_id.hex}.gupa"
    async with session_factory() as db:
        if db.bind is not None and db.bind.dialect.name == "postgresql":
            await db.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
        if await db.get(User, user_id) is None:
            raise ValueError("替换账号不存在")
        identity_map = SQLitePortableIdentityMap()
        try:
            origin_id, _identities, producers = await build_record_producers(
                db, user_id=user_id,
                selected_categories=PORTABLE_CATEGORIES - {"archive_docs"},
                identity_map=identity_map,
            )
            with tempfile.TemporaryFile(mode="w+b") as encrypted:
                size, digest, _manifest = await build_encrypted_archive(
                    encrypted, context=rollback_context(user_id, job_id),
                    origin_id=origin_id, export_id=job_id, producers=producers,
                    complete=True,
                    included_categories=PORTABLE_CATEGORIES - {"archive_docs"},
                )
                await storage.put_stream(key, encrypted, size, "application/vnd.gugu.portable+zip")
                await db.commit()
            return key, size, digest
        except Exception:
            await db.rollback()
            await storage.delete(key)
            raise
        finally:
            identity_map.close()


async def clear_portable_database(db: AsyncSession, *, user_id: UUID) -> dict[str, list]:
    """在调用方事务中删除当前账号的可移植关系数据，返回稍后清理的旧附件 key。

    所有选择都沿用导出侧的 owner-scoped 查询；子对象不会仅凭外键值跨账号清理。
    调用方须先创建并持久化完整回滚归档。
    """
    old_storage_keys: list[tuple[str, str]] = []
    old_active_files: list[tuple[int, int]] = []
    pending_drafts = await _pending_attachment_ids(db, user_id)
    by_type = {spec.record_type: spec for spec in RECORD_SPECS}
    import_order = (
        "preferences", "client", "project", "calendar_event", "workspace_directory", "folder", "file",
        "mind_map", "mind_node", "workspace", "conversation", "conversation_batch", "message",
        "chat_attachment", "mind_canvas_item", "mind_relation", "skill", "feedback", "scheduled_task",
        "pending_queue", "memory_entry", "memory_source", "provider_config", "smtp_config", "bot_config", "mcp_config",
    )
    for record_type in reversed(import_order):
        spec = by_type[record_type]
        model = spec.model
        primary_key = getattr(model, spec.id_field)
        while True:
            statement = select_owned_records(spec, user_id, limit=500)
            if model is ChatAttachment:
                draft_filter = ChatAttachment.attach_id.in_(pending_drafts) if pending_drafts else False
                statement = statement.where(or_(ChatAttachment.state != "draft", draft_filter))
            rows = (await db.execute(statement)).scalars().all()
            if not rows:
                break
            selected_ids = []
            for row in rows:
                if model is ChatAttachment and row.state == "draft" and row.attach_id not in pending_drafts:
                    continue
                selected_ids.append(getattr(row, spec.id_field))
                if model is ChatAttachment or record_type == "file":
                    old_storage_keys.append((row.storage_key, record_type))
                if record_type == "file" and row.deleted_at is None:
                    old_active_files.append((row.id, int(row.size_bytes or 0)))
            if not selected_ids:
                break
            await db.execute(delete(model).where(primary_key.in_(selected_ids)))
            await db.flush()
    await db.execute(delete(DataPortableIdentity).where(DataPortableIdentity.user_id == user_id))
    for model, owner_field in (
        (MemoryReflectionJob, "owner_user_id"), (MemoryReflectionCursor, "owner_user_id"),
        (MemoryScopeTombstone, "owner_user_id"), (KnowledgeIndexEntry, "owner_user_id"),
        (RagIndexJob, "user_id"),
    ):
        await db.execute(delete(model).where(getattr(model, owner_field) == user_id))
    await db.flush()
    return {"storage_keys": old_storage_keys, "active_files": old_active_files}


def memory_destinations(archive: zipfile.ZipFile, manifest: PortableArchiveManifest, user_id: UUID) -> dict[str, str]:
    """只从归档内已校验的记忆 allowlist 路径构造目标 key。"""
    entries = {entry.path: entry for entry in manifest.entries}
    scopes: dict[str, MemoryScope] = {}
    if "memory/im/scopes.jsonl" in entries:
        with archive.open("memory/im/scopes.jsonl", "r") as stream:
            for line in stream:
                if not line.strip():
                    continue
                item = json.loads(line)
                scope = MemoryScope(
                    user_id, str(item["platform"]), str(item["bot_id"]),
                    str(item["scope_type"]), str(item["scope_id"]),
                )
                key = hashlib.sha256("\0".join((
                    scope.platform, scope.bot_id, scope.scope_type, scope.scope_id,
                )).encode()).hexdigest()[:32]
                scopes[key] = scope

    result: dict[str, str] = {}
    owner_allowlist = {
        "profile.json", "pattern.json", "daily.md", "memory.md", "summary.json",
        "stance.json", "lens.json", "facts.json", "facts.md", "summary.md", "summary.ts",
    }
    for path in entries:
        if path.startswith(("memory/owner/", "memory/legacy/")):
            filename = path.rsplit("/", 1)[-1]
            if filename not in owner_allowlist:
                raise ValueError("归档包含不支持的个人记忆文件")
            result[path] = f"{user_id}/.agent/{filename}"
        elif path.startswith("memory/im/scopes/"):
            parts = path.split("/")
            if len(parts) != 5 or parts[3] not in scopes or parts[4] not in scopes[parts[3]].files:
                raise ValueError("IM 记忆路径未映射到有效作用域")
            result[path] = scopes[parts[3]].key(parts[4])
    return result


async def replace_memory_files(
    *, user_id: UUID, old_archive: zipfile.ZipFile, old_manifest: PortableArchiveManifest,
    new_archive: zipfile.ZipFile, new_manifest: PortableArchiveManifest, storage: StorageBackend,
) -> tuple[list[str], list[str]]:
    """恢复前先删除旧快照记录的可移植记忆 key，再写入新归档 allowlist 文件。"""
    old_targets = memory_destinations(old_archive, old_manifest, user_id)
    new_targets = memory_destinations(new_archive, new_manifest, user_id)
    new_entries = {entry.path: entry for entry in new_manifest.entries}
    for key in set(old_targets.values()):
        await storage.delete(key)
    for path, key in new_targets.items():
        entry = new_entries[path]
        with new_archive.open(path, "r") as source, tempfile.TemporaryFile(mode="w+b") as staged:
            while chunk := source.read(1024 * 1024):
                staged.write(chunk)
            staged.seek(0)
            await storage.put_stream(key, staged, entry.size, "application/octet-stream")
    return list(old_targets.values()), list(new_targets.values())


async def restore_memory_files(
    *, user_id: UUID, old_archive: zipfile.ZipFile, old_manifest: PortableArchiveManifest,
    new_archive: zipfile.ZipFile, new_manifest: PortableArchiveManifest, storage: StorageBackend,
) -> None:
    """替换失败时移除新目标并恢复回滚归档中的记忆文件。"""
    new_targets = memory_destinations(new_archive, new_manifest, user_id)
    old_targets = memory_destinations(old_archive, old_manifest, user_id)
    old_entries = {entry.path: entry for entry in old_manifest.entries}
    for key in set(new_targets.values()):
        await storage.delete(key)
    for path, key in old_targets.items():
        entry = old_entries[path]
        with old_archive.open(path, "r") as source, tempfile.TemporaryFile(mode="w+b") as staged:
            while chunk := source.read(1024 * 1024):
                staged.write(chunk)
            staged.seek(0)
            await storage.put_stream(key, staged, entry.size, "application/octet-stream")
