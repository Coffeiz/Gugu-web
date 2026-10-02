"""将已完整校验的可移植业务记录以单事务增量写入目标账号。"""
from __future__ import annotations

import json
import hashlib
import tempfile
import uuid
import zipfile
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ChatAttachment, DataPortableIdentity, MemoryScopeTombstone, User, UserPreferences
from app.services.data_portability.projection import RECORD_SPECS
from app.services.data_portability.schema import PortableArchiveManifest, PortableEntityRecord
from app.services.storage import get_storage
from agent.memory.scopes import MemoryScope


_SPEC_BY_TYPE = {spec.record_type: spec for spec in RECORD_SPECS}
_IMPORT_ORDER = (
    "account", "preferences", "client", "project", "calendar_event", "workspace_directory", "folder", "file",
    "mind_map", "mind_node", "workspace", "conversation",
    "conversation_batch", "message", "chat_attachment", "mind_canvas_item", "mind_relation", "skill",
    "feedback", "scheduled_task", "pending_queue", "memory_entry", "memory_source",
    "provider_config", "smtp_config", "bot_config", "mcp_config",
)


async def apply_incremental_archive(
    db: AsyncSession,
    *,
    user: User,
    archive: zipfile.ZipFile,
    manifest: PortableArchiveManifest,
    job_id: UUID,
    written_storage_keys: list[str],
    replace: bool = False,
) -> dict[str, int]:
    """只新增来源 ledger 中不存在的对象；业务对象和 ledger 共用数据库事务。

    调用方必须先完成整个归档的格式、checksum、路径和引用闭合验证，并在失败时
    rollback 当前事务；对象存储写入通过 written_storage_keys 由调用方补偿。
    """
    existing_rows = (await db.execute(select(DataPortableIdentity).where(
        DataPortableIdentity.user_id == user.id,
        DataPortableIdentity.origin_id == manifest.origin_id,
    ))).scalars().all()
    existing = {(row.source_type, row.portable_id): (row.target_type, row.target_id) for row in existing_rows}

    records_by_type: dict[str, list[PortableEntityRecord]] = {}
    for entry in manifest.entries:
        if not entry.path.startswith("records/") or not entry.path.endswith((".jsonl", ".json")):
            continue
        with archive.open(entry.path, "r") as stream:
            for line in stream:
                if not line.strip():
                    continue
                record = PortableEntityRecord.model_validate_json(line)
                if record.source_type in {"account", "preferences"}:
                    records_by_type.setdefault(record.source_type, []).append(record)
                elif record.source_type in _SPEC_BY_TYPE:
                    records_by_type.setdefault(record.source_type, []).append(record)

    target_ids: dict[tuple[str, str], str] = {
        key: value[1] for key, value in existing.items()
    }
    counts = {"created": 0, "skipped": 0}
    pending_relations: list[tuple[Any, str, str, str]] = []
    pending_embedded: list[tuple[Any, str, Any]] = []
    embedded_targets = dict(target_ids)
    for (source_type, portable_id), (target_type, target_id) in existing.items():
        if source_type != "chat_attachment" or target_type != "chat_attachment":
            continue
        attachment = await db.get(ChatAttachment, int(target_id))
        if attachment is not None and attachment.user_id == user.id:
            embedded_targets[(source_type, portable_id)] = attachment.attach_id

    for record_type in _IMPORT_ORDER:
        for record in records_by_type.get(record_type, []):
            source_key = (record.source_type, record.portable_id)
            if source_key in existing:
                counts["skipped"] += 1
                continue
            if record_type == "account":
                if replace:
                    # 只还原展示资料；用户名、邮箱和认证身份始终由目标账号保留。
                    user.display_name = record.fields.get("display_name")
                    user.avatar = record.fields.get("avatar_reference")
                    user.timezone = record.fields.get("timezone") or user.timezone
                    await db.flush()
                continue  # 登录身份由目标账号保留。
            if record_type == "preferences":
                data = record.fields.get("data") or {}
                row = (await db.execute(select(UserPreferences).where(
                    UserPreferences.user_id == user.id,
                ))).scalar_one_or_none()
                if row is None:
                    row = UserPreferences(user_id=user.id, data_json=data)
                    db.add(row)
                    await db.flush()
                elif replace:
                    row.data_json = data
                    await db.flush()
                else:
                    # 增量语义不覆盖目标端已存在的偏好。
                    counts["skipped"] += 1
                    continue
                target_id = str(row.id)
                target_type = record_type
            else:
                spec = _SPEC_BY_TYPE[record_type]
                fields = _model_fields(spec, record)
                values: dict[str, Any] = {spec.owner_field: user.id, **fields}
                if record_type == "mind_node" and "reference_snapshot" in record.fields:
                    values["ref_snapshot"] = record.fields["reference_snapshot"]
                _apply_safety_defaults(record_type, values, user)
                if record_type in {"file", "chat_attachment"}:
                    values["storage_key"] = await _store_asset(
                        archive, record.fields.get("asset"), user_id=user.id, job_id=job_id,
                        written_storage_keys=written_storage_keys,
                    )
                    if record_type == "chat_attachment":
                        values["attach_id"] = uuid.uuid4().hex
                deferred: list[tuple[str, str, str]] = []
                for relation in record.relations:
                    target_id = target_ids.get((relation.target_type, relation.target_portable_id))
                    ref_spec = next((item for item in spec.refs if item[1] == relation.relation_type), None)
                    if ref_spec is None and record_type == "mind_node" and relation.relation_type == "referenced_object":
                        if target_id is None:
                            deferred.append((relation.relation_type, relation.target_type, relation.target_portable_id))
                        else:
                            target_model = _SPEC_BY_TYPE[relation.target_type].model
                            target_pk = _SPEC_BY_TYPE[relation.target_type].id_field
                            values["ref_type"] = relation.target_type
                            values["ref_id"] = target_model.__table__.columns[target_pk].type.python_type(target_id)
                        continue
                    if ref_spec is None:
                        raise ValueError("归档含有不支持的对象关系")
                    if target_id is None:
                        # 文件夹父子关系和 Mind 引用可能前向指向同类型对象，稍后回填。
                        deferred.append((relation.relation_type, relation.target_type, relation.target_portable_id))
                        continue
                    target_spec = _SPEC_BY_TYPE[relation.target_type]
                    target_python_type = target_spec.model.__table__.columns[target_spec.id_field].type.python_type
                    values[ref_spec[0]] = target_python_type(target_id)
                if record.deleted_at:
                    values["deleted_at"] = _datetime(record.deleted_at)
                if record.created_at and "created_at" in spec.model.__table__.columns:
                    values["created_at"] = _datetime(record.created_at)
                if record.updated_at and "updated_at" in spec.model.__table__.columns:
                    values["updated_at"] = _datetime(record.updated_at)
                row = spec.model(**values)
                db.add(row)
                await db.flush()
                if record_type == "workspace_directory":
                    row.directory_name = f"workspace-{row.id}"
                    await db.flush()
                target_id = str(getattr(row, spec.id_field))
                target_type = record_type
                if record_type == "chat_attachment":
                    embedded_targets[source_key] = values["attach_id"]
                pending_relations.extend(
                    (row, record_type, relation_name, target_type_name + ":" + portable_id)
                    for relation_name, target_type_name, portable_id in deferred
                )

            db.add(DataPortableIdentity(
                user_id=user.id,
                origin_id=manifest.origin_id,
                source_type=record.source_type,
                portable_id=record.portable_id,
                target_type=target_type,
                target_id=target_id,
            ))
            target_ids[source_key] = target_id
            counts["created"] += 1
            await db.flush()
            if record_type == "message":
                for field_name in ("files", "content_json", "display_timeline", "references"):
                    if field_name in record.fields:
                        pending_embedded.append((row, "references_json" if field_name == "references" else field_name, record.fields[field_name]))
            elif record_type == "pending_queue" and "items" in record.fields:
                pending_embedded.append((row, "items", record.fields["items"]))

    # 同一层级的自引用（文件夹树、Mind 节点引用）在主记录创建后回填。
    for row, record_type, relation_name, encoded_target in pending_relations:
        target_type, portable_id = encoded_target.split(":", 1)
        target_id = target_ids.get((target_type, portable_id))
        if target_id is None:
            raise ValueError("导入对象关系缺少目标映射")
        spec = _SPEC_BY_TYPE[record_type]
        relation = next((item for item in spec.refs if item[1] == relation_name), None)
        if relation is None:
            if record_type == "mind_node" and relation_name == "referenced_object":
                row.ref_type = target_type
                row.ref_id = int(target_id) if target_id.isdigit() else target_id
                continue
            raise ValueError("归档含有不支持的对象关系")
        field_name = relation[0]
        target_model = _SPEC_BY_TYPE[target_type].model
        target_pk = _SPEC_BY_TYPE[target_type].id_field
        pk_type = target_model.__table__.columns[target_pk].type.python_type
        setattr(row, field_name, pk_type(target_id))
    for row, field_name, value in pending_embedded:
        setattr(row, field_name, _restore_embedded_refs(value, embedded_targets))
    memory_counts = await _import_memory_files(
        db, user=user, manifest=manifest, archive=archive, job_id=job_id,
        written_storage_keys=written_storage_keys, replace=replace,
    )
    counts.update(memory_counts)
    await db.flush()
    return counts


def _model_fields(spec, record: PortableEntityRecord) -> dict[str, Any]:
    allowed = {column.key for column in spec.model.__table__.columns}
    values: dict[str, Any] = {}
    for name, value in record.fields.items():
        column_name = name + "_json" if name in {"data", "stages", "references"} else name
        if column_name in allowed and column_name not in {"id", spec.owner_field}:
            if column_name in spec.json_fields and spec.model.__table__.columns[column_name].type.python_type is str and value is not None:
                value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            values[column_name] = value
    return values


def _apply_safety_defaults(record_type: str, values: dict[str, Any], user: User) -> None:
    if record_type == "workspace_directory":
        # 物理目录名是本机存储实现细节，必须在目标端重新生成。
        values["directory_name"] = f"import-pending-{uuid.uuid4().hex}"
    elif record_type == "feedback":
        values["username"] = user.username
    elif record_type == "scheduled_task":
        values["enabled"] = False
    elif record_type == "provider_config":
        from app.byok.service import encrypt_value
        encrypted, nonce, data_key = encrypt_value("", allow_empty=True)
        values["enabled"] = False
        values["encrypted_value"], values["nonce"], values["encrypted_data_key"] = encrypted, nonce, data_key
        values["last_verified_at"] = None
    elif record_type == "smtp_config":
        values["enabled"] = False
        values["password"] = ""
    elif record_type == "bot_config":
        values["enabled"] = False
        for name in ("secret", "token", "client_secret", "app_secret"):
            values.pop(name, None)
    elif record_type == "mcp_config":
        values["enabled"] = False
    elif record_type == "conversation":
        # 外部平台会话身份不跨服务器迁移。
        for name in ("platform_user_id", "platform_group_id", "channel_id", "bot_id"):
            values.pop(name, None)
    elif record_type == "conversation_batch":
        values.setdefault("digest", hashlib.sha256(
            f"{values.get('version', 'v1')}:{values.get('round_id') or ''}:{uuid.uuid4().hex}".encode()
        ).hexdigest())
    elif record_type == "pending_queue":
        from app.services.conversation_pending_queue import session_pending_queue_id
        session_id = values.get("session_id")
        if session_id is not None:
            values["queue_id"] = session_pending_queue_id(session_id)
    elif record_type == "skill":
        values["content_digest"] = hashlib.sha256(str(values.get("body") or "").encode()).hexdigest()


def _datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed


_EMBEDDED_TYPES = {
    "event": "calendar_event", "canvas": "mind_map", "canvas_note": "mind_node",
    "project": "project", "file": "file", "folder": "folder", "client": "client",
    "conversation": "conversation", "scheduled_task": "scheduled_task", "skill": "skill",
    "mcp": "mcp_config", "message": "message", "conversation_batch": "conversation_batch",
    "workspace": "workspace", "workspace_directory": "workspace_directory",
    "chat_attachment": "chat_attachment",
}
_EMBEDDED_FIELDS = {
    "project_portable_id": ("project", "project_id"), "file_portable_id": ("file", "file_id"),
    "folder_portable_id": ("folder", "folder_id"), "mind_map_portable_id": ("mind_map", "mind_map_id"),
    "workspace_portable_id": ("workspace", "workspace_id"),
    "workspace_directory_portable_id": ("workspace_directory", "workspace_directory_id"),
    "event_portable_id": ("calendar_event", "event_id"), "session_portable_id": ("conversation", "session_id"),
    "canonical_batch_portable_id": ("conversation_batch", "canonical_batch_id"),
    "attachment_portable_id": ("chat_attachment", "attach_id"),
    "chat_attachment_portable_id": ("chat_attachment", "attach_id"),
}


def _restore_embedded_refs(value: Any, targets: dict[tuple[str, str], str]) -> Any:
    if isinstance(value, list):
        return [_restore_embedded_refs(item, targets) for item in value]
    if not isinstance(value, dict):
        return value
    restored = {key: _restore_embedded_refs(item, targets) for key, item in value.items()}
    for portable_field, (target_type, target_field) in _EMBEDDED_FIELDS.items():
        portable_id = restored.pop(portable_field, None)
        if portable_id is not None:
            target_id = targets.get((target_type, str(portable_id)))
            if target_id is None:
                raise ValueError("导入内容引用缺少目标对象映射")
            if target_type != "chat_attachment":
                target_spec = _SPEC_BY_TYPE[target_type]
                target_id = target_spec.model.__table__.columns[target_spec.id_field].type.python_type(target_id)
            restored[target_field] = target_id
    portable_id = restored.get("portable_id")
    kind = str(restored.get("type") or restored.get("ref_type") or "")
    target_type = _EMBEDDED_TYPES.get(kind)
    if portable_id and target_type:
        target_id = targets.get((target_type, str(portable_id)))
        if target_id is None:
            raise ValueError("导入内容引用缺少目标对象映射")
        spec = _SPEC_BY_TYPE.get(target_type)
        if spec is not None:
            target_id = spec.model.__table__.columns[spec.id_field].type.python_type(target_id)
        restored.pop("portable_id", None)
        restored["id"] = target_id
    return restored


async def _store_asset(archive: zipfile.ZipFile, descriptor: Any, *, user_id: UUID,
                       job_id: UUID, written_storage_keys: list[str]) -> str:
    """从归档拼接资产流中逐段校验复制，不接受归档提供的物理存储键。"""
    if not isinstance(descriptor, dict):
        raise ValueError("归档中的文件缺少附件数据")
    path, offset, size = descriptor.get("path"), descriptor.get("offset"), descriptor.get("size")
    digest = descriptor.get("sha256")
    if (not isinstance(path, str) or not path.startswith("assets/")
            or not isinstance(offset, int) or offset < 0
            or not isinstance(size, int) or size < 0
            or not isinstance(digest, str) or len(digest) != 64):
        raise ValueError("归档附件描述无效")
    key = f"{user_id.hex}/.data-portability/imported/{job_id.hex}/{uuid.uuid4().hex}"
    with archive.open(path, "r") as source, tempfile.TemporaryFile(mode="w+b") as staged:
        skipped = 0
        while skipped < offset:
            chunk = source.read(min(1024 * 1024, offset - skipped))
            if not chunk:
                raise ValueError("归档附件偏移超过数据长度")
            skipped += len(chunk)
        hasher = hashlib.sha256()
        copied = 0
        while copied < size:
            chunk = source.read(min(1024 * 1024, size - copied))
            if not chunk:
                raise ValueError("归档附件数据长度不匹配")
            staged.write(chunk)
            hasher.update(chunk)
            copied += len(chunk)
        if hasher.hexdigest() != digest:
            raise ValueError("归档附件摘要校验失败")
        staged.seek(0)
        await get_storage().put_stream(
            key, staged, size, str(descriptor.get("mime_type") or "application/octet-stream")
        )
    written_storage_keys.append(key)
    return key


async def _import_memory_files(
    db: AsyncSession, *, user: User, manifest: PortableArchiveManifest,
    archive: zipfile.ZipFile, job_id: UUID, written_storage_keys: list[str],
    replace: bool,
) -> dict[str, int]:
    memory_entries = [entry for entry in manifest.entries if entry.category in {"owner_memory", "im_memory"}]
    if not memory_entries:
        return {"memory_created": 0, "memory_skipped": 0}
    user_id = user.id
    scopes: dict[str, MemoryScope] = {}
    deleted_scopes: set[tuple[str, str, str, str]] = set()
    for entry in memory_entries:
        if entry.path not in {"memory/im/scopes.jsonl", "memory/im/deletion_markers.jsonl"}:
            continue
        with archive.open(entry.path, "r") as stream:
            for line in stream:
                if not line.strip():
                    continue
                item = json.loads(line)
                scope = MemoryScope(
                    user_id, str(item["platform"]), str(item["bot_id"]),
                    str(item["scope_type"]), str(item["scope_id"]),
                )
                identity = (scope.platform, scope.bot_id, scope.scope_type, scope.scope_id)
                scope_hash = hashlib.sha256("\0".join(identity).encode("utf-8")).hexdigest()[:32]
                scopes[scope_hash] = scope
                if item.get("deleted") is True:
                    deleted_scopes.add(identity)

    ledger_rows = (await db.execute(select(DataPortableIdentity).where(
        DataPortableIdentity.user_id == user_id,
        DataPortableIdentity.origin_id == manifest.origin_id,
        DataPortableIdentity.source_type.in_(("owner_memory_file", "im_memory_file")),
    ))).scalars().all()
    imported = {(row.source_type, row.portable_id) for row in ledger_rows}
    storage = get_storage()
    created = skipped = 0
    owner_allowlist = {
        "profile.json", "pattern.json", "daily.md", "memory.md", "summary.json",
        "stance.json", "lens.json", "facts.json", "facts.md", "summary.md", "summary.ts",
    }
    for entry in memory_entries:
        if entry.path in {"memory/im/scopes.jsonl", "memory/im/deletion_markers.jsonl"}:
            continue
        if entry.path.startswith(("memory/owner/", "memory/legacy/")):
            source_type = "owner_memory_file"
            filename = entry.path.rsplit("/", 1)[-1]
            if filename not in owner_allowlist:
                raise ValueError("归档包含不支持的个人记忆文件")
            destination = f"{user_id}/.agent/{filename}"
        elif entry.path.startswith("memory/im/scopes/"):
            source_type = "im_memory_file"
            parts = entry.path.split("/")
            if len(parts) != 5:
                raise ValueError("IM 记忆归档路径无效")
            scope = scopes.get(parts[3])
            if scope is None or parts[4] not in scope.files:
                raise ValueError("IM 记忆文件未映射到有效作用域")
            if (scope.platform, scope.bot_id, scope.scope_type, scope.scope_id) in deleted_scopes:
                raise ValueError("已删除记忆作用域不能包含记忆正文")
            destination = scope.key(parts[4])
        else:
            raise ValueError("归档包含未知记忆文件路径")

        source_identity = (source_type, entry.path)
        if not replace and source_identity in imported:
            skipped += 1
            continue
        if replace and await storage.stat(destination) is not None:
            db.add(DataPortableIdentity(
                user_id=user_id, origin_id=manifest.origin_id, source_type=source_type,
                portable_id=entry.path, target_type="memory_storage_key", target_id=destination,
            ))
            imported.add(source_identity)
            created += 1
            continue
        if not replace and await storage.stat(destination) is not None:
            skipped += 1
            db.add(DataPortableIdentity(
                user_id=user_id, origin_id=manifest.origin_id, source_type=source_type,
                portable_id=entry.path, target_type="memory_storage_key", target_id=destination,
            ))
            imported.add(source_identity)
            continue
        key = f"{user_id.hex}/.data-portability/imported/{job_id.hex}/{uuid.uuid4().hex}"
        with archive.open(entry.path, "r") as source, tempfile.TemporaryFile(mode="w+b") as staged:
            while chunk := source.read(1024 * 1024):
                staged.write(chunk)
            staged.seek(0)
            await storage.put_stream(key, staged, entry.size, "application/octet-stream")
        written_storage_keys.append(key)
        if await storage.stat(destination) is None:
            await storage.rename_file(key, destination)
            written_storage_keys[-1] = destination
        else:
            await storage.delete(key)
            written_storage_keys.pop()
            skipped += 1
            continue
        db.add(DataPortableIdentity(
            user_id=user_id, origin_id=manifest.origin_id, source_type=source_type,
            portable_id=entry.path, target_type="memory_storage_key", target_id=destination,
        ))
        imported.add(source_identity)
        created += 1

    if replace:
        for platform, bot_id, scope_type, scope_id in sorted(deleted_scopes):
            tombstone = (await db.execute(select(MemoryScopeTombstone).where(
                MemoryScopeTombstone.owner_user_id == user_id,
                MemoryScopeTombstone.platform == platform,
                MemoryScopeTombstone.bot_id == bot_id,
                MemoryScopeTombstone.scope_type == scope_type,
                MemoryScopeTombstone.scope_id == scope_id,
            ))).scalar_one_or_none()
            if tombstone is None:
                tombstone = MemoryScopeTombstone(
                    owner_user_id=user_id, platform=platform, bot_id=bot_id,
                    scope_type=scope_type, scope_id=scope_id, status="pending",
                )
                db.add(tombstone)
                await db.flush()
                created += 1
            db.add(DataPortableIdentity(
                user_id=user_id, origin_id=manifest.origin_id,
                source_type="im_memory_tombstone",
                portable_id="\0".join((platform, bot_id, scope_type, scope_id)),
                target_type="im_memory_tombstone", target_id=str(tombstone.id),
            ))
    else:
        # 增量导入不得把来源端删除指令变成目标端删除任务。
        skipped += len(deleted_scopes)
    return {"memory_created": created, "memory_skipped": skipped}
