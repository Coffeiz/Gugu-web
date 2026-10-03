"""显式白名单的业务记录投影，不序列化 ORM 全列。"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    CalendarEvent, ChatAttachment, Client, ConversationBatch, ConversationMessage,
    ConversationPendingQueue, ConversationSession, DataPortableIdentity, Feedback,
    File, Folder, MindCanvasItem, MindMap, MindNode, MindRelation, Project,
    MemoryEntry, MemorySource, ScheduledTask, User, UserBot, UserPreferences, UserProviderCredential,
    UserSkill, UserSmtpConfig, Workspace, WorkspaceDirectory,
)
from app.models.mcp import UserMcpServer
from app.services.data_portability.schema import PortableEntityRecord, PortableRelation


@dataclass(frozen=True)
class RecordSpec:
    record_type: str
    category: str
    model: type
    owner_field: str
    id_field: str
    fields: tuple[str, ...]
    refs: tuple[tuple[str, str, str], ...] = ()
    json_fields: tuple[str, ...] = ()
    sanitize: str | None = None
    identity_field: str | None = None


# 只列可移植业务字段。密钥、权限、物理路径、索引和运行态字段不进入此表。
RECORD_SPECS = (
    RecordSpec("preferences", "preferences", UserPreferences, "user_id", "id", ("data_json",), json_fields=("data_json",), sanitize="preferences"),
    RecordSpec("project", "projects", Project, "user_id", "id", (
        "name", "client", "status", "start_date", "deadline", "color", "progress",
        "stages_json", "current_stage", "priority", "archived", "done_at"), json_fields=("stages_json",)),
    RecordSpec("client", "clients", Client, "user_id", "id", ("name", "contact", "email", "phone", "notes")),
    RecordSpec("workspace_directory", "workspaces", WorkspaceDirectory, "user_id", "id",
        ("name", "is_default", "is_system", "deleted_at")),
    RecordSpec("folder", "files", Folder, "user_id", "id", ("name", "version", "deleted_at"), (
        ("project_id", "project", "project"), ("workspace_directory_id", "workspace_directory", "workspace_directory"),
        ("parent_id", "parent", "folder"))),
    RecordSpec("file", "files", File, "user_id", "id", (
        "display_name", "ext", "space", "stage_name", "version", "size", "size_bytes",
        "mime_type", "img_width", "img_height", "deleted_at"), (
        ("project_id", "project", "project"), ("folder_id", "folder", "folder"),
        ("mind_map_id", "mind_map", "mind_map"), ("workspace_directory_id", "workspace_directory", "workspace_directory"))),
    RecordSpec("mind_map", "mind", MindMap, "user_id", "id", ("title", "data_json", "deleted_at"),
        (("project_id", "project", "project"),), json_fields=("data_json",)),
    RecordSpec("mind_node", "mind", MindNode, "user_id", "id", (
        "kind", "title", "content_md", "content_plain", "color", "origin", "captured_at", "deleted_at"),
        json_fields=(), sanitize="mind_node"),
    RecordSpec("mind_canvas_item", "mind", MindCanvasItem, "user_id", "id", (
        "x", "y", "w", "h", "z", "collapsed", "data_json", "deleted_at"), (
        ("canvas_id", "canvas", "mind_map"), ("node_id", "node", "mind_node")), json_fields=("data_json",)),
    RecordSpec("mind_relation", "mind", MindRelation, "user_id", "id", (
        "rel_type", "edge_key", "origin", "status", "note", "deleted_at"), (
        ("canvas_id", "canvas", "mind_map"), ("src_node_id", "source", "mind_node"),
        ("dst_node_id", "target", "mind_node"))),
    RecordSpec("calendar_event", "calendar", CalendarEvent, "user_id", "id", (
        "title", "date", "time", "end_time", "type", "client", "description", "version", "deleted_at"),
        (("project_id", "project", "project"),)),
    RecordSpec("workspace", "workspaces", Workspace, "user_id", "id", (
        "name", "kind", "enabled", "is_default"), (("folder_id", "folder", "folder"),
        ("project_id", "project", "project"), ("directory_id", "directory", "workspace_directory"))),
    RecordSpec("conversation", "conversations", ConversationSession, "user_id", "id", (
        "title", "title_locked", "summary", "source", "chat_type", "created_at"),
        (("workspace_id", "workspace", "workspace"),), sanitize="conversation"),
    RecordSpec("message", "conversations", ConversationMessage, "session_id", "id", (
        "role", "content", "content_json", "display_timeline", "files", "quoted_text", "references_json", "chat_type", "sent_at", "created_at"),
        (("session_id", "session", "conversation"), ("canonical_batch_id", "batch", "conversation_batch")), sanitize="message"),
    RecordSpec("conversation_batch", "conversations", ConversationBatch, "session_id", "id",
        ("version", "round_id", "created_at"), (("session_id", "session", "conversation"),)),
    RecordSpec("skill", "skills", UserSkill, "owner_id", "id", (
        "slug", "name", "description_short", "description_long", "category", "body", "related_tools", "source", "enabled"),
        json_fields=("related_tools",)),
    RecordSpec("feedback", "feedback", Feedback, "user_id", "id", ("category", "content", "created_at")),
    RecordSpec("scheduled_task", "scheduled_tasks", ScheduledTask, "user_id", "id", (
        "name", "payload", "cron", "schedule_kind", "interval_minutes", "start_at", "end_at", "created_at"),
        (("workspace_id", "workspace", "workspace"), ("event_id", "event", "calendar_event")), sanitize="scheduled_task"),
    RecordSpec("pending_queue", "drafts", ConversationPendingQueue, "user_id", "id",
        ("items", "updated_at"), (("session_id", "session", "conversation"),), json_fields=("items",), sanitize="draft"),
    RecordSpec("memory_entry", "im_memory", MemoryEntry, "owner_user_id", "id",
        ("platform", "bot_id", "scope_type", "scope_id", "entry_key", "kind", "content_hash", "active", "created_at", "updated_at")),
    RecordSpec("memory_source", "im_memory", MemorySource, "entry_id", "id", ("created_at",),
        (("entry_id", "entry", "memory_entry"), ("message_id", "message", "message"))),
    RecordSpec("chat_attachment", "conversations", ChatAttachment, "user_id", "id", (
        "platform", "attachment_index", "name", "ext", "mime", "kind", "size",
        "duration", "img_width", "img_height", "state", "extra", "created_at", "attached_at"),
        (("message_id", "message", "message"),), json_fields=("extra",), identity_field="attach_id"),
    RecordSpec("provider_config", "connections", UserProviderCredential, "user_id", "id", (
        "provider", "api_format", "capability", "base_url", "model", "max_tokens", "context_tokens",
        "thinking", "reasoning_effort", "reasoning_persistence", "image", "video", "audio",
        "image_detail", "dimensions", "created_at", "updated_at"), sanitize="provider"),
    RecordSpec("smtp_config", "connections", UserSmtpConfig, "user_id", "id",
        ("host", "port", "user", "from_addr", "use_ssl", "updated_at"), sanitize="connection"),
    RecordSpec("bot_config", "connections", UserBot, "user_id", "id", (
        "platform", "name", "app_id", "sandbox", "group_chat_enabled", "group_requires_at",
        "group_read_enabled", "group_memory_enabled", "member_memory_enabled", "group_message_format",
        "private_message_format", "private_streaming_enabled", "created_at"), sanitize="bot"),
    RecordSpec("mcp_config", "connections", UserMcpServer, "user_id", "id", (
        "name", "transport", "endpoint", "timeout_seconds", "created_at", "updated_at"), sanitize="mcp"),
)
_CATEGORY_BY_TYPE = {spec.record_type: spec.category for spec in RECORD_SPECS}
_CATEGORY_BY_TYPE.update({"event": "calendar", "canvas": "mind", "canvas_note": "mind"})


def _json_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


def _decode_json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            raise ValueError("可移植记录中的 JSON 字段无效") from None
    return value


async def _owned_identity_map(db: AsyncSession, user_id: UUID, origin_id: UUID) -> dict[tuple[str, str], str]:
    result = await db.execute(select(DataPortableIdentity).where(
        DataPortableIdentity.user_id == user_id,
        DataPortableIdentity.origin_id == origin_id,
    ))
    return {(row.target_type, row.target_id): row.portable_id for row in result.scalars()}


async def ensure_origin(db: AsyncSession, user_id: UUID):
    """确保账号拥有稳定的随机来源身份；不把账号主键放进归档。"""
    from app.models import DataPortabilityOrigin
    origin = await db.get(DataPortabilityOrigin, user_id)
    if origin is None:
        origin = DataPortabilityOrigin(user_id=user_id)
        db.add(origin)
        await db.flush()
    return origin.origin_id


async def ensure_portable_identities(
    db: AsyncSession, *, user_id: UUID, origin_id: UUID, batch_size: int = 500,
    identity_map=None, include_drafts: bool = True,
) -> dict[tuple[str, str], str]:
    """为自有记录分批建立稳定 ID；查询仅取主键，避免载入整份用户数据。"""
    from uuid import uuid4

    identities = identity_map if identity_map is not None else {}
    draft_attach_ids = await _pending_attachment_ids(db, user_id) if include_drafts else set()
    for spec in RECORD_SPECS:
        last_id = None
        while True:
            columns = [getattr(spec.model, spec.id_field), getattr(spec.model, spec.identity_field or spec.id_field)]
            if spec.model is ChatAttachment:
                columns.append(ChatAttachment.state)
            stmt = select(*columns)
            if spec.model in {ConversationMessage, ConversationBatch}:
                stmt = stmt.join(ConversationSession, spec.model.session_id == ConversationSession.id).where(
                    ConversationSession.user_id == user_id
                )
            elif spec.model is MemorySource:
                stmt = stmt.join(MemoryEntry, MemorySource.entry_id == MemoryEntry.id).join(
                    ConversationMessage, MemorySource.message_id == ConversationMessage.id
                ).join(ConversationSession, ConversationMessage.session_id == ConversationSession.id).where(
                    MemoryEntry.owner_user_id == user_id, ConversationSession.user_id == user_id
                )
            elif spec.model is ChatAttachment:
                from sqlalchemy import and_, or_
                owned_message_ids = select(ConversationMessage.id).join(
                    ConversationSession, ConversationMessage.session_id == ConversationSession.id
                ).where(ConversationSession.user_id == user_id)
                stmt = stmt.where(
                    ChatAttachment.user_id == user_id,
                    or_(
                        and_(ChatAttachment.state == "attached", ChatAttachment.message_id.in_(owned_message_ids)),
                        # Only fetch drafts owned by this user here. The exact attachment
                        # reference is checked in Python to avoid a potentially huge SQL IN.
                        ChatAttachment.state == "draft",
                    ),
                )
            else:
                stmt = stmt.where(getattr(spec.model, spec.owner_field) == user_id)
            pk = getattr(spec.model, spec.id_field)
            if last_id is not None:
                stmt = stmt.where(pk > last_id)
            raw_rows = list((await db.execute(stmt.order_by(pk).limit(batch_size))).all())
            if not raw_rows:
                break
            raw_ids = [row[0] for row in raw_rows]
            eligible_rows = [
                row for row in raw_rows
                if spec.model is not ChatAttachment
                or row[2] != "draft"
                or str(row[1]) in draft_attach_ids
            ]
            target_keys = [str(row[1]) for row in eligible_rows]
            stored = await db.execute(select(DataPortableIdentity).where(
                DataPortableIdentity.user_id == user_id,
                DataPortableIdentity.origin_id == origin_id,
                DataPortableIdentity.target_type == spec.record_type,
                DataPortableIdentity.target_id.in_(target_keys),
            ))
            by_target = {row.target_id: row.portable_id for row in stored.scalars()}
            for row_id, identity_value, *_ in eligible_rows:
                target = str(identity_value)
                portable_id = by_target.get(target)
                if portable_id is None:
                    portable_id = str(uuid4())
                    db.add(DataPortableIdentity(
                        user_id=user_id,
                        origin_id=origin_id,
                        source_type=spec.record_type,
                        portable_id=portable_id,
                        target_type=spec.record_type,
                        target_id=target,
                    ))
                identities[(spec.record_type, str(row_id))] = portable_id
                identities[(spec.record_type, target)] = portable_id
            await db.flush()
            if hasattr(identities, "commit"):
                identities.commit()
            last_id = raw_ids[-1]
    return identities


async def project_record(
    db: AsyncSession, *, user_id: UUID, origin_id: UUID, spec: RecordSpec, row: Any,
    identities: dict[tuple[str, str], str], selected_categories: set[str] | None = None,
) -> PortableEntityRecord:
    pk = str(getattr(row, spec.id_field))
    identity_key = str(getattr(row, spec.identity_field or spec.id_field))
    portable_id = identities.get((spec.record_type, pk))
    if portable_id is None:
        raise ValueError("业务对象缺少稳定可移植身份")

    fields: dict[str, Any] = {}
    for name in spec.fields:
        value = getattr(row, name)
        field_name = name.removesuffix("_json") if name in {"stages_json", "data_json"} else name
        fields[field_name] = _json_value(
            _decode_json(value) if name in spec.json_fields else value
        )

    relations: list[PortableRelation] = []
    for source_field, relation_name, target_type in spec.refs:
        target_id = getattr(row, source_field)
        if target_id is None:
            continue
        target_portable_id = identities.get((target_type, str(target_id)))
        if target_portable_id is None:
            if selected_categories is not None and _CATEGORY_BY_TYPE.get(target_type) not in selected_categories:
                continue
            # Legacy dangling references remain as explicit snapshots only for MindNode below.
            if spec.record_type == "mind_node":
                continue
            raise ValueError("业务对象关系引用不完整")
        relations.append(PortableRelation(
            relation_type=relation_name, target_type=target_type, target_portable_id=target_portable_id
        ))

    if spec.record_type == "mind_node" and row.kind == "ref" and row.ref_type and row.ref_id is not None:
        target_type = row.ref_type
        target_portable_id = identities.get((target_type, str(row.ref_id)))
        if target_portable_id:
            relations.append(PortableRelation(
                relation_type="referenced_object", target_type=target_type,
                target_portable_id=target_portable_id,
            ))
            fields["reference_snapshot"] = _json_value(row.ref_snapshot)
        elif selected_categories is None or _CATEGORY_BY_TYPE.get(target_type) in selected_categories:
            # Deleted business records intentionally retain a snapshot-only mind ref.
            fields["reference_snapshot"] = _json_value(row.ref_snapshot)

    if spec.record_type == "conversation":
        # 不导出 platform ids、execution state、Provider/API 快照及上下文 lease。
        fields["source"] = row.source
    elif spec.record_type == "message":
        # run/batch 内部 ID 以及平台用户标识属于服务端运行态/绑定身份。
        fields["files"] = _portable_embedded_refs(fields.get("files"), identities, "file_id", "file")
        fields["references"] = _portable_embedded_refs(fields.pop("references_json", None), identities, "id")
        fields.pop("references_json", None)
        fields.pop("files", None) if fields.get("files") is None else None
        fields["content_json"] = _portable_embedded_refs(fields.get("content_json"), identities)
        fields["display_timeline"] = _portable_embedded_refs(fields.get("display_timeline"), identities)
    elif spec.record_type == "scheduled_task":
        fields["enabled"] = False
    elif spec.record_type == "pending_queue":
        fields["items"] = _sanitize_pending_items(fields.get("items"), identities)
    elif spec.record_type == "preferences":
        preferences = fields.pop("data", {})
        allowed = {
            "locale", "theme", "theme_family", "palette", "last_stages", "stage_templates",
            "reply_tone", "reply_length", "pm_stages_expanded", "calendar_week_start",
            "default_view", "show_tool_interactions", "show_intermediate_replies", "tool_injection_mode",
        }
        fields["data"] = {key: value for key, value in (preferences or {}).items() if key in allowed}
    elif spec.record_type == "provider_config":
        fields["enabled"] = False
        fields["requires_reconfigure"] = True
    elif spec.record_type == "smtp_config":
        fields["enabled"] = False
        fields["requires_reconfigure"] = True
    elif spec.record_type == "bot_config":
        fields["enabled"] = False
        fields["requires_reconfigure"] = True
    elif spec.record_type == "mcp_config":
        endpoint = _sanitize_endpoint(fields.get("endpoint"))
        fields["endpoint"] = endpoint
        fields["enabled"] = False
        fields["requires_reconfigure"] = endpoint is None

    # Chat attachment IDs are random transport references. Their portable identity is
    # keyed by attach_id, while the record ID remains private and never enters fields.
    if spec.record_type == "chat_attachment":
        portable_id = identities.get((spec.record_type, identity_key), portable_id)
    if spec.record_type in {"file", "chat_attachment"}:
        asset = identities.get_metadata(spec.record_type, identity_key) if hasattr(identities, "get_metadata") else None
        if asset is None:
            asset = identities.get((f"asset:{spec.record_type}", identity_key))
        if asset is not None:
            fields["asset"] = asset

    created = getattr(row, "created_at", None)
    updated = getattr(row, "updated_at", None)
    deleted = getattr(row, "deleted_at", None)
    return PortableEntityRecord(
        record_schema=f"gugu.{spec.record_type}.v1", portable_id=portable_id,
        source_type=spec.record_type,
        created_at=created.isoformat() if created else None,
        updated_at=updated.isoformat() if updated else None,
        deleted_at=deleted.isoformat() if deleted else None,
        fields=fields, relations=relations,
    )


def _portable_embedded_refs(value: Any, identities: dict[tuple[str, str], str], id_key: str = "id", target_type: str | None = None):
    """递归替换结构化引用中的本地 ID，剔除物理 key，保留普通用户文本。"""
    if isinstance(value, list):
        return [_portable_embedded_refs(item, identities) for item in value]
    if not isinstance(value, dict):
        return value

    type_map = {
        "event": "calendar_event", "canvas": "mind_map", "canvas_note": "mind_node",
        "project": "project", "file": "file", "folder": "folder", "client": "client",
        "conversation": "conversation", "scheduled_task": "scheduled_task", "skill": "skill",
        "mcp": "mcp_config", "message": "message", "conversation_batch": "conversation_batch",
    }
    safe = {
        key: _portable_embedded_refs(item, identities)
        for key, item in value.items()
        if key not in {"storage_key", "physical_path", "absolute_path", "workspace_path", "root_path"}
    }
    relation_type = target_type or type_map.get(str(value.get("type") or value.get("ref_type") or ""))
    lookup_key = id_key if id_key in value else None
    if lookup_key and relation_type:
        portable = identities.get((relation_type, str(value[lookup_key])))
        safe.pop(lookup_key, None)
        if portable:
            safe["portable_id"] = portable
        elif "portable_id" not in safe:
            safe.pop("id", None)
    for field_name, source_type in {
        "project_id": "project", "file_id": "file", "folder_id": "folder",
        "mind_map_id": "mind_map", "workspace_id": "workspace", "workspace_directory_id": "workspace_directory",
        "event_id": "calendar_event", "session_id": "conversation", "message_id": "message",
        "canonical_batch_id": "conversation_batch", "attach_id": "chat_attachment",
    }.items():
        if field_name not in safe or safe[field_name] is None:
            continue
        portable = identities.get((source_type, str(value[field_name])))
        safe.pop(field_name, None)
        if portable:
            safe[f"{field_name.removesuffix('_id').removesuffix('_id')}_portable_id"] = portable
    return safe


def _sanitize_pending_items(value: Any, identities: dict[tuple[str, str], str]) -> list:
    """草稿只保留 UI 正式字段，剔除 claim token/lease 等并转为 portable refs。"""
    if not isinstance(value, list):
        return []
    output = []
    for item in value:
        if not isinstance(item, dict):
            continue
        safe = {key: _json_value(val) for key, val in item.items() if key in {"key", "text"}}
        safe["attachments"] = []
        for attachment in item.get("attachments", []):
            if not isinstance(attachment, dict):
                continue
            row = {key: _json_value(val) for key, val in attachment.items() if key not in {"file_id", "attach_id"}}
            if attachment.get("file_id") is not None:
                portable = identities.get(("file", str(attachment["file_id"])))
                if portable:
                    row["file_portable_id"] = portable
            if attachment.get("attach_id"):
                portable = identities.get(("chat_attachment", str(attachment["attach_id"])))
                if portable:
                    row["attachment_portable_id"] = portable
            safe["attachments"].append(row)
        safe["references"] = []
        for reference in item.get("references", []):
            if not isinstance(reference, dict):
                continue
            kind = str(reference.get("type") or "")
            source_type = {"event": "calendar_event", "canvas_note": "mind_node", "mcp": "mcp_config"}.get(kind, kind)
            portable = identities.get((source_type, str(reference.get("id"))))
            if portable:
                safe["references"].append({"type": kind, "portable_id": portable, "label": reference.get("label", "")})
        output.append(safe)
    return output


def _sanitize_endpoint(value: str | None) -> str | None:
    """仅导出无凭据、无 query/fragment 的 HTTP(S) URL；无法确认则要求重配。"""
    if not value:
        return None
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or any(part.lower() in {"key", "token", "secret", "credential", "auth"} for part in parsed.path.split("/"))
        ):
            return None
        host = parsed.hostname.lower()
        if parsed.port:
            host = f"{host}:{parsed.port}"
        return urlunsplit((parsed.scheme, host, parsed.path, "", ""))
    except (ValueError, UnicodeError):
        return None


async def count_owned_records(db: AsyncSession, user_id: UUID) -> dict[str, int]:
    """批量/用户隔离统计；依然由各类别的 owner 列决定归属。"""
    from sqlalchemy import func
    counts: dict[str, int] = {}
    draft_attach_ids = await _pending_attachment_ids(db, user_id)
    for spec in RECORD_SPECS:
        if spec.model is ChatAttachment:
            owned_message_ids = select(ConversationMessage.id).join(
                ConversationSession, ConversationMessage.session_id == ConversationSession.id
            ).where(ConversationSession.user_id == user_id)
            attached_count = int((await db.execute(
                select(func.count()).select_from(ChatAttachment).where(
                    ChatAttachment.user_id == user_id,
                    ChatAttachment.state == "attached",
                    ChatAttachment.message_id.in_(owned_message_ids),
                )
            )).scalar_one())
            draft_rows = await db.execute(select(ChatAttachment.attach_id).where(
                ChatAttachment.user_id == user_id, ChatAttachment.state == "draft"
            ))
            counts[spec.record_type] = attached_count + sum(
                1 for attach_id in draft_rows.scalars() if str(attach_id) in draft_attach_ids
            )
            continue
        stmt = select(func.count()).select_from(spec.model)
        if spec.model in {ConversationMessage, ConversationBatch}:
            stmt = stmt.join(ConversationSession, spec.model.session_id == ConversationSession.id).where(
                ConversationSession.user_id == user_id
            )
        elif spec.model is MemorySource:
            stmt = stmt.join(MemoryEntry, MemorySource.entry_id == MemoryEntry.id).join(
                ConversationMessage, MemorySource.message_id == ConversationMessage.id
            ).join(ConversationSession, ConversationMessage.session_id == ConversationSession.id).where(
                MemoryEntry.owner_user_id == user_id, ConversationSession.user_id == user_id
            )
        else:
            stmt = stmt.where(getattr(spec.model, spec.owner_field) == user_id)
        result = await db.execute(stmt)
        counts[spec.record_type] = int(result.scalar_one())
    return counts


def select_owned_records(spec: RecordSpec, user_id: UUID, *, after_id: Any = None, limit: int = 500):
    """生成有 owner 边界的 keyset 查询，消息必须通过会话确认归属。"""
    stmt = select(spec.model)
    if spec.model in {ConversationMessage, ConversationBatch}:
        stmt = stmt.join(ConversationSession, spec.model.session_id == ConversationSession.id).where(
            ConversationSession.user_id == user_id
        )
    elif spec.model is MemorySource:
        stmt = stmt.join(MemoryEntry, MemorySource.entry_id == MemoryEntry.id).join(
            ConversationMessage, MemorySource.message_id == ConversationMessage.id
        ).join(ConversationSession, ConversationMessage.session_id == ConversationSession.id).where(
            MemoryEntry.owner_user_id == user_id, ConversationSession.user_id == user_id
        )
    elif spec.model is ChatAttachment:
        from sqlalchemy import and_, or_
        owned_message_ids = select(ConversationMessage.id).join(
            ConversationSession, ConversationMessage.session_id == ConversationSession.id
        ).where(ConversationSession.user_id == user_id)
        stmt = stmt.where(
            ChatAttachment.user_id == user_id,
            or_(
                and_(ChatAttachment.state == "attached", ChatAttachment.message_id.in_(owned_message_ids)),
                ChatAttachment.state == "draft",
            ),
        )
    else:
        stmt = stmt.where(getattr(spec.model, spec.owner_field) == user_id)
    pk = getattr(spec.model, spec.id_field)
    if after_id is not None:
        stmt = stmt.where(pk > after_id)
    return stmt.order_by(pk).limit(limit)


async def _pending_attachment_ids(db: AsyncSession, user_id: UUID) -> set[str]:
    result = await db.execute(select(ConversationPendingQueue.items).where(ConversationPendingQueue.user_id == user_id))
    attach_ids: set[str] = set()
    for items in result.scalars():
        for item in items or []:
            if not isinstance(item, dict):
                continue
            for attachment in item.get("attachments", []) or []:
                if isinstance(attachment, dict) and attachment.get("attach_id"):
                    attach_ids.add(str(attachment["attach_id"]))
    return attach_ids


async def write_record_stream(
    stream,
    db: AsyncSession,
    *,
    user_id: UUID,
    origin_id: UUID,
    identities: dict[tuple[str, str], str],
    spec: RecordSpec,
    selected_categories: set[str] | None = None,
    batch_size: int = 500,
) -> int:
    """按主键游标投影 JSONL；内存上限由单批 ORM 行和单条记录大小决定。"""
    from pydantic import TypeAdapter
    adapter = TypeAdapter(PortableEntityRecord)
    draft_attach_ids = (
        await _pending_attachment_ids(db, user_id)
        if spec.model is ChatAttachment and selected_categories and "drafts" in selected_categories
        else set()
    )
    after_id = None
    written_records = 0
    while True:
        rows = (await db.execute(select_owned_records(
            spec, user_id, after_id=after_id, limit=batch_size,
        ))).scalars().all()
        if not rows:
            break
        for row in rows:
            if spec.model is ChatAttachment and row.state == "draft" and row.attach_id not in draft_attach_ids:
                continue
            record = await project_record(
                db,
                user_id=user_id,
                origin_id=origin_id,
                spec=spec,
                row=row,
                identities=identities,
                selected_categories=selected_categories,
            )
            stream.write(adapter.dump_json(record, exclude_none=True) + b"\n")
            written_records += 1
        after_id = getattr(rows[-1], spec.id_field)
    return written_records
