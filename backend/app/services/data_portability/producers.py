"""把已审查的业务白名单装配成归档条目生产器。"""
from __future__ import annotations

import json
import hashlib
import zipfile
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ChatAttachment, File, User, UserPreferences
from app.services.data_portability.archive import ArchiveProducer
from app.services.data_portability.projection import (
    RECORD_SPECS, _pending_attachment_ids, ensure_portable_identities, ensure_origin,
    project_record, select_owned_records, write_record_stream,
)
from app.services.data_portability.schema import PortableEntityRecord
from app.services.data_portability.identity_map import SQLitePortableIdentityMap
from app.services.data_portability.memories import build_memory_producers


_PATHS = {
    "project": "records/projects.jsonl",
    "client": "records/clients.jsonl",
    "folder": "records/files/folders.jsonl",
    "file": "records/files/files.jsonl",
    "workspace_directory": "records/workspaces/directories.jsonl",
    "workspace": "records/workspaces/bindings.jsonl",
    "mind_map": "records/mind/canvases.jsonl",
    "mind_node": "records/mind/nodes.jsonl",
    "mind_canvas_item": "records/mind/canvas_items.jsonl",
    "mind_relation": "records/mind/relations.jsonl",
    "calendar_event": "records/calendar/events.jsonl",
    "conversation": "records/conversations/sessions.jsonl",
    "message": "records/conversations/messages.jsonl",
    "conversation_batch": "records/conversations/batches.jsonl",
    "chat_attachment": "records/conversations/attachments.jsonl",
    "skill": "records/skills.jsonl",
    "feedback": "records/feedback.jsonl",
    "scheduled_task": "records/scheduled_tasks.jsonl",
    "pending_queue": "records/conversations/drafts.jsonl",
    "memory_entry": "memory/im/entries.jsonl",
    "memory_source": "memory/im/sources.jsonl",
    "provider_config": "records/connections/providers.jsonl",
    "smtp_config": "records/connections/smtp.jsonl",
    "bot_config": "records/connections/bots.jsonl",
    "mcp_config": "records/connections/mcp.jsonl",
}


def portable_origin_identity(user_id: UUID, origin_id: UUID, export_id: UUID) -> str:
    """加密上下文用于绑定用户和任务；仅 origin/export UUID 会进入归档。"""
    return f"data-portability:{user_id.hex}:{export_id.hex}"


async def build_record_producers(
    db: AsyncSession,
    *,
    user_id: UUID,
    selected_categories: set[str],
    identity_map: SQLitePortableIdentityMap | None = None,
) -> tuple[UUID, dict, list[ArchiveProducer]]:
    """建立来源身份映射，再返回按主键批量读取的序列化生产器。"""
    origin_id = await ensure_origin(db, user_id)
    all_identities = await ensure_portable_identities(
        db, user_id=user_id, origin_id=origin_id, identity_map=identity_map,
        include_drafts="drafts" in selected_categories,
    )
    selected_types = {spec.record_type for spec in RECORD_SPECS if spec.category in selected_categories}
    identities = all_identities.view(selected_types) if identity_map is not None else {
        key: value for key, value in all_identities.items() if key[0] in selected_types
    }
    producers: list[ArchiveProducer] = []

    if selected_categories.intersection({"files", "conversations"}):
        from app.services.storage import get_storage
        storage = get_storage()
        file_spec = next(spec for spec in RECORD_SPECS if spec.model is File)
        attachment_spec = next(spec for spec in RECORD_SPECS if spec.model is ChatAttachment)
        draft_attach_ids = await _pending_attachment_ids(db, user_id) if "drafts" in selected_categories else set()
        asset_specs = []
        if "files" in selected_categories:
            asset_specs.append(file_spec)
        if "conversations" in selected_categories:
            asset_specs.append(attachment_spec)

        for asset_spec in asset_specs:
            after_id = None
            asset_offset = 0
            asset_path = f"assets/{'files' if asset_spec.model is File else 'chat'}/{asset_spec.record_type}.bin"
            while True:
                rows = (await db.execute(select_owned_records(
                    asset_spec, user_id, after_id=after_id, limit=250,
                ))).scalars().all()
                if not rows:
                    break
                for row in rows:
                    if asset_spec.model is ChatAttachment and row.state == "draft" and row.attach_id not in draft_attach_ids:
                        continue
                    target_id = str(getattr(row, asset_spec.identity_field or asset_spec.id_field))
                    portable_id = identities.get((asset_spec.record_type, str(getattr(row, asset_spec.id_field))))
                    if portable_id is None:
                        raise ValueError("附件缺少稳定可移植身份")
                    storage_key = row.storage_key
                    before = await storage.stat(storage_key)
                    expected_size = int(row.size_bytes if asset_spec.model is File else row.size or 0)
                    if before is None or before.size != expected_size:
                        raise ValueError("附件不存在或大小与数据库记录不一致")
                    digest = hashlib.sha256()
                    actual_size = 0
                    async for chunk in storage.iter_chunks(storage_key):
                        digest.update(chunk)
                        actual_size += len(chunk)
                    after = await storage.stat(storage_key)
                    if (
                        after is None or actual_size != expected_size or after.size != before.size
                        or (before.mtime is not None and after.mtime != before.mtime)
                        or (before.checksum and after.checksum and before.checksum != after.checksum)
                    ):
                        raise ValueError("附件在导出校验期间发生变化")
                    identity_map_value = {
                        "path": asset_path,
                        "offset": asset_offset,
                        "size": actual_size,
                        "sha256": digest.hexdigest(),
                        "mime_type": row.mime_type if asset_spec.model is File else row.mime,
                    }
                    if hasattr(identities, "set_metadata"):
                        identities.set_metadata(asset_spec.record_type, target_id, identity_map_value)
                    else:
                        identities[(f"asset:{asset_spec.record_type}", target_id)] = identity_map_value
                    asset_offset += actual_size
                after_id = getattr(rows[-1], asset_spec.id_field)
            if hasattr(identity_map, "commit"):
                identity_map.commit()

            async def write_assets(stream, selected_spec=asset_spec):
                after_id = None
                written = 0
                while True:
                    rows = (await db.execute(select_owned_records(
                        selected_spec, user_id, after_id=after_id, limit=250,
                    ))).scalars().all()
                    if not rows:
                        break
                    for row in rows:
                        if selected_spec.model is ChatAttachment and row.state == "draft" and row.attach_id not in draft_attach_ids:
                            continue
                        target_id = str(getattr(row, selected_spec.identity_field or selected_spec.id_field))
                        metadata = identities.get_metadata(selected_spec.record_type, target_id) if hasattr(identities, "get_metadata") else identities.get((f"asset:{selected_spec.record_type}", target_id))
                        if metadata is None:
                            raise ValueError("附件未通过预校验")
                        storage_key = row.storage_key
                        before = await storage.stat(storage_key)
                        if before is None or before.size != metadata["size"]:
                            raise ValueError("附件在导出期间丢失或大小发生变化")
                        digest = hashlib.sha256()
                        actual_size = 0
                        async for chunk in storage.iter_chunks(storage_key):
                            stream.write(chunk)
                            digest.update(chunk)
                            actual_size += len(chunk)
                        after = await storage.stat(storage_key)
                        if (
                            actual_size != metadata["size"] or digest.hexdigest() != metadata["sha256"]
                            or after is None or after.size != before.size
                            or (before.mtime is not None and after.mtime != before.mtime)
                        ):
                            raise ValueError("附件在导出期间发生变化")
                        written += 1
                    after_id = getattr(rows[-1], selected_spec.id_field)
                return None

            asset_category = asset_spec.category
            producers.append(ArchiveProducer(
                asset_path,
                asset_category,
                write_assets,
                compression=zipfile.ZIP_STORED,
            ))

    if "account" in selected_categories:
        async def write_account(stream):
            user = await db.get(User, user_id)
            if user is None:
                raise ValueError("导出账号不存在")
            avatar = _safe_avatar_reference(user.avatar)
            record = PortableEntityRecord(
                record_schema="gugu.account.v1",
                portable_id="account-profile-v1",
                source_type="account",
                created_at=user.created_at.isoformat() if user.created_at else None,
                fields={
                    "username": user.username,
                    "email": user.email,
                    "display_name": user.display_name,
                    "avatar_reference": avatar,
                    "timezone": user.timezone,
                },
            )
            content = json.dumps(record.model_dump(mode="json", exclude_none=True), ensure_ascii=False,
                                 sort_keys=True, separators=(",", ":")).encode("utf-8")
            stream.write(content)
            return 1
        producers.append(ArchiveProducer("records/account.json", "account", write_account))

    if "preferences" in selected_categories:
        async def write_preferences(stream):
            result = await db.execute(select(UserPreferences).where(UserPreferences.user_id == user_id))
            row = result.scalar_one_or_none()
            if row is None:
                record = PortableEntityRecord(
                    record_schema="gugu.preferences.v1", portable_id="preferences-v1",
                    source_type="preferences", fields={"data": {}},
                )
            else:
                spec = next(spec for spec in RECORD_SPECS if spec.record_type == "preferences")
                record = await project_record(db, user_id=user_id, origin_id=origin_id,
                                              spec=spec, row=row, identities=identities)
            content = json.dumps(record.model_dump(mode="json", exclude_none=True), ensure_ascii=False,
                                 sort_keys=True, separators=(",", ":")).encode("utf-8")
            stream.write(content)
            return 1
        producers.append(ArchiveProducer("records/preferences.json", "preferences", write_preferences))

    for spec in RECORD_SPECS:
        if spec.category not in selected_categories or spec.record_type in {"preferences"}:
            continue
        path = _PATHS[spec.record_type]

        async def write_records(stream, selected_spec=spec):
            return await write_record_stream(
                stream, db, user_id=user_id, origin_id=origin_id,
                identities=identities, spec=selected_spec,
                selected_categories=selected_categories,
            )

        producers.append(ArchiveProducer(path, spec.category, write_records))
    producers.extend(
        item for item in await build_memory_producers(db, user_id=user_id)
        if item.category in selected_categories
    )
    return origin_id, identities, producers


def _safe_avatar_reference(value: str | None) -> str | None:
    if not value or not value.startswith(("https://", "http://")):
        return None
    from app.services.data_portability.projection import _sanitize_endpoint
    return _sanitize_endpoint(value)
