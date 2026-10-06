import hashlib
import io
import json
import zipfile
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.models import (
    ConversationMessage, ConversationPendingQueue, ConversationSession, DataPortableIdentity, MindNode, Project,
    UserMcpServer, Workspace, WorkspaceDirectory,
)
from app.services.data_portability.import_apply import apply_incremental_archive
from app.services.data_portability.projection import RECORD_SPECS, project_record
from app.services.data_portability.schema import PortableArchiveManifest, PortableArchiveEntry, PortableCategory
from app.services.conversation_pending_queue import (
    get_pending_queue_for_session,
    list_imported_draft_queues,
    session_pending_queue_id,
)
from app.services.storage import LocalStorageBackend
from agent.memory.scopes import MemoryScope


def _archive_from_records(record_files: dict[str, tuple[str, list[dict]]]):
    packed_data = io.BytesIO()
    entries = []
    categories: dict[str, dict[str, int]] = {}
    with zipfile.ZipFile(packed_data, "w") as archive:
        for path, (category, records) in record_files.items():
            data = ("\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n").encode()
            archive.writestr(path, data)
            totals = categories.setdefault(category, {"records": 0, "bytes": 0})
            totals["records"] += len(records)
            totals["bytes"] += len(data)
            entries.append(PortableArchiveEntry(
                path=path, category=category, size=len(data),
                sha256=hashlib.sha256(data).hexdigest(), records=len(records),
            ))
    manifest = PortableArchiveManifest(
        origin_id=uuid4(), export_id=uuid4(), created_at="2026-10-02T00:00:00+00:00",
        complete=False,
        categories={name: PortableCategory(included=True, **values) for name, values in categories.items()},
        entries=entries,
    )
    return packed_data.getvalue(), manifest


@pytest.mark.asyncio
async def test_incremental_import_adds_once_and_never_overwrites_target_project(db, user_a):
    """同一来源对象重放只跳过；目标已有对象不因导入被改写。"""
    existing = Project(user_id=user_a.id, name="目标端项目")
    db.add(existing)
    await db.flush()

    origin_id = uuid4()
    payload = {
        "record_schema": "gugu.project.v1",
        "portable_id": "source-project-1",
        "source_type": "project",
        "fields": {"name": "来源项目", "status": "active", "stages": []},
        "relations": [],
    }
    line = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("records/projects.jsonl", line)
    archive_data = output.getvalue()
    manifest = PortableArchiveManifest(
        origin_id=origin_id,
        export_id=uuid4(),
        created_at="2026-10-02T00:00:00+00:00",
        complete=False,
        categories={
            "projects": PortableCategory(included=True, records=1, bytes=len(line)),
        },
        entries=[PortableArchiveEntry(
            path="records/projects.jsonl", category="projects", size=len(line),
            sha256="0" * 64, records=1,
        )],
    )

    with zipfile.ZipFile(io.BytesIO(archive_data), "r") as packed:
        first = await apply_incremental_archive(
            db, user=user_a, archive=packed, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )
    await db.commit()
    with zipfile.ZipFile(io.BytesIO(archive_data), "r") as packed:
        repeated = await apply_incremental_archive(
            db, user=user_a, archive=packed, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )

    projects = (await db.execute(select(Project).where(Project.user_id == user_a.id))).scalars().all()
    identity = (await db.execute(select(DataPortableIdentity).where(
        DataPortableIdentity.user_id == user_a.id,
        DataPortableIdentity.origin_id == origin_id,
    ))).scalar_one()
    assert first == {"created": 1, "skipped": 0, "memory_created": 0, "memory_skipped": 0}
    assert repeated == {"created": 0, "skipped": 1, "memory_created": 0, "memory_skipped": 0}
    assert {project.name for project in projects} == {"目标端项目", "来源项目"}
    assert identity.target_id != str(existing.id)


@pytest.mark.asyncio
async def test_incremental_import_reuses_default_and_adds_missing_workspace(db, user_a):
    """增量导入复用目标系统默认目录/绑定，同时新增来源中缺失的工作区。"""
    default_directory = WorkspaceDirectory(
        user_id=user_a.id, name="默认工作区", directory_name="default",
        is_default=True, is_system=True,
    )
    db.add(default_directory)
    await db.flush()
    default_binding = Workspace(
        user_id=user_a.id, name="默认工作区", kind="directory",
        directory_id=default_directory.id, enabled=True,
    )
    db.add(default_binding)
    await db.flush()

    records = [
        {
            "record_schema": "gugu.workspace_directory.v1", "portable_id": "source-default-directory",
            "source_type": "workspace_directory",
            "fields": {"name": "默认工作区", "is_default": True, "is_system": True, "deleted_at": None},
            "relations": [],
        },
        {
            "record_schema": "gugu.workspace_directory.v1", "portable_id": "source-qq-directory",
            "source_type": "workspace_directory",
            "fields": {"name": "QQ", "is_default": False, "is_system": False, "deleted_at": None},
            "relations": [],
        },
        {
            "record_schema": "gugu.workspace.v1", "portable_id": "source-default-binding",
            "source_type": "workspace",
            "fields": {"name": "默认工作区", "kind": "directory", "enabled": True, "is_default": True},
            "relations": [{"relation_type": "directory", "target_type": "workspace_directory", "target_portable_id": "source-default-directory"}],
        },
        {
            "record_schema": "gugu.workspace.v1", "portable_id": "source-qq-binding",
            "source_type": "workspace",
            "fields": {"name": "QQ", "kind": "directory", "enabled": True, "is_default": False},
            "relations": [{"relation_type": "directory", "target_type": "workspace_directory", "target_portable_id": "source-qq-directory"}],
        },
    ]
    packed_data = io.BytesIO()
    with zipfile.ZipFile(packed_data, "w") as archive:
        archive.writestr("records/workspaces/directories.jsonl", "\n".join(
            json.dumps(record, ensure_ascii=False) for record in records[:2]
        ) + "\n")
        archive.writestr("records/workspaces/bindings.jsonl", "\n".join(
            json.dumps(record, ensure_ascii=False) for record in records[2:]
        ) + "\n")
    directory_data = ("\n".join(json.dumps(record, ensure_ascii=False) for record in records[:2]) + "\n").encode()
    binding_data = ("\n".join(json.dumps(record, ensure_ascii=False) for record in records[2:]) + "\n").encode()
    manifest = PortableArchiveManifest(
        origin_id=uuid4(), export_id=uuid4(), created_at="2026-10-02T00:00:00+00:00",
        complete=False,
        categories={"workspaces": PortableCategory(included=True, records=4, bytes=len(directory_data) + len(binding_data))},
        entries=[
            PortableArchiveEntry(
                path="records/workspaces/directories.jsonl", category="workspaces",
                size=len(directory_data), sha256="0" * 64, records=2,
            ),
            PortableArchiveEntry(
                path="records/workspaces/bindings.jsonl", category="workspaces",
                size=len(binding_data), sha256="0" * 64, records=2,
            ),
        ],
    )

    with zipfile.ZipFile(io.BytesIO(packed_data.getvalue()), "r") as packed:
        result = await apply_incremental_archive(
            db, user=user_a, archive=packed, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )
    await db.flush()

    directories = (await db.execute(select(WorkspaceDirectory).where(
        WorkspaceDirectory.user_id == user_a.id,
        WorkspaceDirectory.deleted_at.is_(None),
    ))).scalars().all()
    bindings = (await db.execute(select(Workspace).where(Workspace.user_id == user_a.id))).scalars().all()
    identities = (await db.execute(select(DataPortableIdentity).where(
        DataPortableIdentity.user_id == user_a.id,
        DataPortableIdentity.origin_id == manifest.origin_id,
    ))).scalars().all()
    mapped = {(row.source_type, row.portable_id): row.target_id for row in identities}

    assert result == {"created": 2, "skipped": 2, "memory_created": 0, "memory_skipped": 0}
    assert {row.name for row in directories} == {"默认工作区", "QQ"}
    assert len([row for row in directories if row.is_default]) == 1
    assert len([row for row in bindings if row.directory_id == default_directory.id]) == 1
    assert not default_binding.is_default
    assert mapped[("workspace_directory", "source-default-directory")] == str(default_directory.id)
    assert mapped[("workspace", "source-default-binding")] == str(default_binding.id)
    qq_directory = next(row for row in directories if row.name == "QQ")
    qq_binding = next(row for row in bindings if row.name == "QQ")
    assert qq_binding.directory_id == qq_directory.id


@pytest.mark.asyncio
async def test_incremental_import_preserves_legacy_reference_without_target_as_note(db, user_a):
    """旧归档中缺少目标关系的 ref 应降级为可读笔记，不触发数据库约束失败。"""
    payload = {
        "record_schema": "gugu.mind_node.v1",
        "portable_id": "legacy-ref-node",
        "source_type": "mind_node",
        "fields": {
            "kind": "ref", "title": "来源项目", "content_md": "项目快照内容",
            "content_plain": "项目快照内容", "reference_snapshot": {"status": "active"},
        },
        "relations": [],
    }
    line = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    packed_data = io.BytesIO()
    with zipfile.ZipFile(packed_data, "w") as archive:
        archive.writestr("records/mind/nodes.jsonl", line)
    manifest = PortableArchiveManifest(
        origin_id=uuid4(), export_id=uuid4(), created_at="2026-10-02T00:00:00+00:00",
        complete=False,
        categories={"mind": PortableCategory(included=True, records=1, bytes=len(line))},
        entries=[PortableArchiveEntry(
            path="records/mind/nodes.jsonl", category="mind", size=len(line),
            sha256="0" * 64, records=1,
        )],
    )

    with zipfile.ZipFile(io.BytesIO(packed_data.getvalue()), "r") as archive:
        result = await apply_incremental_archive(
            db, user=user_a, archive=archive, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )
    node = (await db.execute(select(MindNode).where(MindNode.user_id == user_a.id))).scalar_one()

    assert result["created"] == 1
    assert node.kind == "note"
    assert node.title == "来源项目"
    assert node.content_md == "项目快照内容"
    assert node.ref_type is None and node.ref_id is None
    assert node.ref_snapshot == {"status": "active"}


@pytest.mark.asyncio
async def test_incremental_import_keeps_deleted_note_as_tombstone(db, user_a):
    """导入软删除笔记时保留删除状态，列表不能把墓碑当成活动笔记。"""
    payload = {
        "record_schema": "gugu.mind_node.v1",
        "portable_id": "deleted-note-tombstone",
        "source_type": "mind_node",
        "created_at": "2026-09-07T08:30:00+00:00",
        "deleted_at": "2026-09-08T08:30:00+00:00",
        "fields": {"kind": "note", "title": None, "content_md": "", "content_plain": ""},
        "relations": [],
    }
    archive_bytes, manifest = _archive_from_records({
        "records/mind/nodes.jsonl": ("mind", [payload]),
    })

    with zipfile.ZipFile(io.BytesIO(archive_bytes), "r") as archive:
        result = await apply_incremental_archive(
            db, user=user_a, archive=archive, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )
    node = (await db.execute(select(MindNode).where(MindNode.user_id == user_a.id))).scalar_one()

    assert result["created"] == 1
    assert node.deleted_at is not None
    assert node.title is None and node.content_md == ""


@pytest.mark.asyncio
async def test_incremental_import_recovers_sessionless_draft_queue(db, user_a, user_b):
    """新对话草稿缺少可移植标签 ID 时仍可导入，并且只向所属用户恢复。"""
    payload = {
        "record_schema": "gugu.pending_queue.v1",
        "portable_id": "source-draft-queue",
        "source_type": "pending_queue",
        "fields": {
            "items": [{"key": 27, "text": "尚未发送的草稿", "attachments": [], "references": []}],
            "updated_at": "2026-10-02T00:00:00+00:00",
        },
        "relations": [],
    }
    line = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    packed_data = io.BytesIO()
    with zipfile.ZipFile(packed_data, "w") as archive:
        archive.writestr("records/conversations/drafts.jsonl", line)
    manifest = PortableArchiveManifest(
        origin_id=uuid4(), export_id=uuid4(), created_at="2026-10-02T00:00:00+00:00",
        complete=False,
        categories={"drafts": PortableCategory(included=True, records=1, bytes=len(line))},
        entries=[PortableArchiveEntry(
            path="records/conversations/drafts.jsonl", category="drafts", size=len(line),
            sha256="0" * 64, records=1,
        )],
    )

    with zipfile.ZipFile(io.BytesIO(packed_data.getvalue()), "r") as archive:
        result = await apply_incremental_archive(
            db, user=user_a, archive=archive, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )
    queue = (await db.execute(select(ConversationPendingQueue).where(
        ConversationPendingQueue.user_id == user_a.id,
    ))).scalar_one()
    await db.flush()

    assert result["created"] == 1
    assert queue.session_id is None
    assert queue.queue_id.startswith("import-")
    assert await list_imported_draft_queues(db, user_id=user_a.id) == [{
        "queue_id": queue.queue_id,
        "items": [{
            "key": 27, "text": "尚未发送的草稿", "attachments": [], "references": [],
            "queue_id": queue.queue_id, "session_id": None, "claimed": False,
        }],
    }]

    other_user_queue = ConversationPendingQueue(
        user_id=user_b.id, queue_id="import-not-owned", session_id=None,
        items=[{"key": 28, "text": "不应跨用户出现", "attachments": [], "references": []}],
    )
    db.add(other_user_queue)
    await db.flush()
    assert len(await list_imported_draft_queues(db, user_id=user_a.id)) == 1


@pytest.mark.asyncio
async def test_incremental_import_maps_session_queue_to_canonical_queue_id(db, user_a):
    """完整归档导入后，会话待发队列使用新会话的规范队列 ID 并可正常读取。"""
    records = [
        {
            "record_schema": "gugu.conversation.v1", "portable_id": "source-session",
            "source_type": "conversation", "fields": {"title": "有待发内容的会话", "source": "web"},
            "relations": [],
        },
        {
            "record_schema": "gugu.pending_queue.v1", "portable_id": "source-session-queue",
            "source_type": "pending_queue",
            "fields": {
                "items": [{"key": 31, "text": "待继续发送", "attachments": [], "references": []}],
                "updated_at": "2026-10-02T00:00:00+00:00",
            },
            "relations": [{
                "relation_type": "session", "target_type": "conversation",
                "target_portable_id": "source-session",
            }],
        },
    ]
    archive_data, manifest = _archive_from_records({
        "records/conversations/sessions.jsonl": ("conversations", [records[0]]),
        "records/conversations/drafts.jsonl": ("drafts", [records[1]]),
    })

    with zipfile.ZipFile(io.BytesIO(archive_data), "r") as archive:
        result = await apply_incremental_archive(
            db, user=user_a, archive=archive, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )
    session = (await db.execute(select(ConversationSession).where(
        ConversationSession.user_id == user_a.id,
        ConversationSession.title == "有待发内容的会话",
    ))).scalar_one()
    queue = (await db.execute(select(ConversationPendingQueue).where(
        ConversationPendingQueue.user_id == user_a.id,
    ))).scalar_one()

    assert result["created"] == 2
    assert queue.session_id == session.id
    assert queue.queue_id == session_pending_queue_id(session.id)
    assert await get_pending_queue_for_session(db, user_id=user_a.id, session_id=session.id) == [{
        "key": 31, "text": "待继续发送", "attachments": [], "references": [],
        "queue_id": session_pending_queue_id(session.id), "session_id": session.id, "claimed": False,
    }]


@pytest.mark.asyncio
async def test_draft_only_projection_drops_session_relation_and_imports_recoverable_draft(db, user_a):
    """只导出 drafts 时投影移除会话关系，导入后成为可被草稿恢复接口发现的队列。"""
    source_session = ConversationSession(user_id=user_a.id, title="不随草稿导出的会话", source="web")
    db.add(source_session)
    await db.flush()
    source_queue = ConversationPendingQueue(
        user_id=user_a.id, queue_id=session_pending_queue_id(source_session.id),
        session_id=source_session.id,
        items=[{"key": 32, "text": "只导出草稿", "attachments": [], "references": []}],
    )
    db.add(source_queue)
    await db.flush()
    queue_spec = next(spec for spec in RECORD_SPECS if spec.record_type == "pending_queue")
    portable_queue = await project_record(
        db, user_id=user_a.id, origin_id=uuid4(), spec=queue_spec, row=source_queue,
        identities={("pending_queue", str(source_queue.id)): "source-draft-only"},
        selected_categories={"drafts"},
    )

    assert portable_queue.relations == []
    archive_data, manifest = _archive_from_records({
        "records/conversations/drafts.jsonl": ("drafts", [portable_queue.model_dump(mode="json")]),
    })
    with zipfile.ZipFile(io.BytesIO(archive_data), "r") as archive:
        result = await apply_incremental_archive(
            db, user=user_a, archive=archive, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )
    imported = (await db.execute(select(ConversationPendingQueue).where(
        ConversationPendingQueue.user_id == user_a.id,
        ConversationPendingQueue.id != source_queue.id,
    ))).scalar_one()

    assert result["created"] == 1
    assert imported.session_id is None
    assert imported.queue_id.startswith("import-")
    assert len(await list_imported_draft_queues(db, user_id=user_a.id)) == 1


@pytest.mark.asyncio
async def test_incremental_import_disables_mcp_with_sanitized_missing_endpoint(db, user_a):
    """安全脱敏掉端点的 MCP 配置可导入为禁用占位，供目标环境重新配置。"""
    payload = {
        "record_schema": "gugu.mcp_config.v1",
        "portable_id": "source-mcp-server",
        "source_type": "mcp_config",
        "fields": {
            "name": "weather-server", "transport": "http", "endpoint": None,
            "timeout_seconds": 30, "created_at": "2026-10-02T00:00:00+00:00",
            "updated_at": "2026-10-02T00:00:00+00:00",
        },
        "relations": [],
    }
    line = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    packed_data = io.BytesIO()
    with zipfile.ZipFile(packed_data, "w") as archive:
        archive.writestr("records/connections/mcp.jsonl", line)
    manifest = PortableArchiveManifest(
        origin_id=uuid4(), export_id=uuid4(), created_at="2026-10-02T00:00:00+00:00",
        complete=False,
        categories={"connections": PortableCategory(included=True, records=1, bytes=len(line))},
        entries=[PortableArchiveEntry(
            path="records/connections/mcp.jsonl", category="connections", size=len(line),
            sha256="0" * 64, records=1,
        )],
    )

    with zipfile.ZipFile(io.BytesIO(packed_data.getvalue()), "r") as archive:
        result = await apply_incremental_archive(
            db, user=user_a, archive=archive, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )
    row = (await db.execute(select(UserMcpServer).where(
        UserMcpServer.user_id == user_a.id,
    ))).scalar_one()

    assert result["created"] == 1
    assert row.endpoint == ""
    assert row.enabled is False


@pytest.mark.asyncio
async def test_incremental_import_restores_embedded_reference_to_new_project(db, user_a):
    """同一归档中新建的项目也必须能解析消息里的可移植引用。"""
    records = [
        {
            "record_schema": "gugu.project.v1", "portable_id": "source-project",
            "source_type": "project",
            "fields": {"name": "引用目标项目", "status": "active", "stages": []},
            "relations": [],
        },
        {
            "record_schema": "gugu.conversation.v1", "portable_id": "source-conversation",
            "source_type": "conversation", "fields": {"title": "引用恢复测试", "source": "web"},
            "relations": [],
        },
        {
            "record_schema": "gugu.message.v1", "portable_id": "source-message",
            "source_type": "message",
            "fields": {
                "role": "user", "content": "查看项目",
                "content_json": [{"type": "project", "project_portable_id": "source-project"}],
            },
            "relations": [{
                "relation_type": "session", "target_type": "conversation",
                "target_portable_id": "source-conversation",
            }],
        },
    ]
    packed_data = io.BytesIO()
    with zipfile.ZipFile(packed_data, "w") as archive:
        archive.writestr("records/projects.jsonl", json.dumps(records[0]) + "\n")
        archive.writestr("records/conversations/sessions.jsonl", json.dumps(records[1]) + "\n")
        archive.writestr("records/conversations/messages.jsonl", json.dumps(records[2]) + "\n")
    entry_data = [
        ("records/projects.jsonl", "projects", records[0]),
        ("records/conversations/sessions.jsonl", "conversations", records[1]),
        ("records/conversations/messages.jsonl", "conversations", records[2]),
    ]
    entries = []
    category_counts = {"projects": 1, "conversations": 2}
    category_bytes = {name: 0 for name in category_counts}
    for path, category, record in entry_data:
        data = (json.dumps(record) + "\n").encode()
        category_bytes[category] += len(data)
        entries.append(PortableArchiveEntry(
            path=path, category=category, size=len(data), sha256="0" * 64, records=1,
        ))
    manifest = PortableArchiveManifest(
        origin_id=uuid4(), export_id=uuid4(), created_at="2026-10-02T00:00:00+00:00",
        complete=False,
        categories={
            category: PortableCategory(included=True, records=count, bytes=category_bytes[category])
            for category, count in category_counts.items()
        },
        entries=entries,
    )

    with zipfile.ZipFile(io.BytesIO(packed_data.getvalue()), "r") as archive:
        result = await apply_incremental_archive(
            db, user=user_a, archive=archive, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )
    project = (await db.execute(select(Project).where(
        Project.user_id == user_a.id,
        Project.name == "引用目标项目",
    ))).scalar_one()
    message = (await db.execute(select(ConversationMessage).where(
        ConversationMessage.content == "查看项目",
    ))).scalar_one()

    assert result["created"] == 3
    assert message.content_json == [{"type": "project", "project_id": project.id}]


@pytest.mark.asyncio
async def test_incremental_import_maps_im_memory_files_from_scope_index(db, user_a, tmp_path, monkeypatch):
    """作用域索引必须参与正文映射，避免合法 IM 记忆归档在导入时误判为未映射。"""
    from app.services.data_portability import import_apply

    storage = LocalStorageBackend(tmp_path / "storage")
    monkeypatch.setattr(import_apply, "get_storage", lambda: storage)
    scope = MemoryScope(user_a.id, "qq", "bot-1", "group", "group-1")
    identity = (scope.platform, scope.bot_id, scope.scope_type, scope.scope_id)
    scope_hash = hashlib.sha256("\0".join(identity).encode("utf-8")).hexdigest()[:32]
    index_path = "memory/im/scopes.jsonl"
    memory_path = f"memory/im/scopes/{scope_hash}/profile.json"
    index_data = (json.dumps({
        "platform": scope.platform, "bot_id": scope.bot_id,
        "scope_type": scope.scope_type, "scope_id": scope.scope_id, "deleted": False,
    }) + "\n").encode()
    memory_data = b'{"summary":"imported"}'
    packed_data = io.BytesIO()
    with zipfile.ZipFile(packed_data, "w") as archive:
        archive.writestr(index_path, index_data)
        archive.writestr(memory_path, memory_data)
    manifest = PortableArchiveManifest(
        origin_id=uuid4(), export_id=uuid4(), created_at="2026-10-02T00:00:00+00:00",
        complete=False,
        categories={"im_memory": PortableCategory(included=True, records=1, bytes=len(index_data) + len(memory_data))},
        entries=[
            PortableArchiveEntry(path=index_path, category="im_memory", size=len(index_data), sha256=hashlib.sha256(index_data).hexdigest(), records=1),
            PortableArchiveEntry(path=memory_path, category="im_memory", size=len(memory_data), sha256=hashlib.sha256(memory_data).hexdigest(), records=0),
        ],
    )

    with zipfile.ZipFile(io.BytesIO(packed_data.getvalue()), "r") as archive:
        result = await apply_incremental_archive(
            db, user=user_a, archive=archive, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )

    assert result["memory_created"] == 1
    assert await storage.get(scope.key("profile.json")) == memory_data
    identity_row = (await db.execute(select(DataPortableIdentity).where(
        DataPortableIdentity.user_id == user_a.id,
        DataPortableIdentity.origin_id == manifest.origin_id,
        DataPortableIdentity.source_type == "im_memory_file",
    ))).scalar_one()
    assert identity_row.portable_id == memory_path
