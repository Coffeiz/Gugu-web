from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.core.tz import now_utc
from app.models import File, FileSyncBinding, FileSyncJournal, Project
from app.services.filesync.protocol import (
    FileSyncOperation,
    FileSyncSource,
    FileSyncStatus,
    build_idempotency_key,
    create_binding,
    record_change,
)
from app.services.storage import LocalStorageBackend
from app.services.storage.file_service import FileService
from app.services.storage.trash import restore_file_storage


@pytest.mark.asyncio
async def test_external_projection_advances_dirty_watermark_but_job_projection_does_not(
    db, user_a, monkeypatch,
):
    """扫描任务能识别外部变更，同时不把自己的批次写入误判成新脏事件。"""
    import app.services.filesync.protocol as protocol

    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    binding = await create_binding(
        db,
        user_id=user_a.id,
        source=FileSyncSource.LOCAL_DIRECTORY,
        root_fingerprint="a" * 64,
    )
    await db.commit()

    await record_change(
        db,
        binding=binding,
        user_id=user_a.id,
        source=FileSyncSource.FILE_API,
        operation=FileSyncOperation.UPDATE,
        relative_path="note.txt",
        idempotency_key=build_idempotency_key(
            source=FileSyncSource.FILE_API, operation=FileSyncOperation.UPDATE,
            relative_path="note.txt", fingerprint="b" * 64,
        ),
        observed_fingerprint="b" * 64,
        status=FileSyncStatus.SYNCED,
    )
    assert binding.revision == 1
    assert binding.dirty_revision == 1

    await record_change(
        db,
        binding=binding,
        user_id=user_a.id,
        source=FileSyncSource.LOCAL_DIRECTORY,
        operation=FileSyncOperation.UPDATE,
        relative_path="note.txt",
        idempotency_key=build_idempotency_key(
            source=FileSyncSource.LOCAL_DIRECTORY, operation=FileSyncOperation.UPDATE,
            relative_path="note.txt", fingerprint="c" * 64,
        ),
        observed_fingerprint="c" * 64,
        status=FileSyncStatus.SYNCED,
        mark_dirty=False,
    )
    assert binding.revision == 2
    assert binding.dirty_revision == 1


@pytest.mark.asyncio
async def test_folder_subtree_delete_and_restore_advance_file_and_directory_watermarks(
    db, user_a, monkeypatch, tmp_path,
):
    """删除并恢复含文件的文件夹子树时，文件路径和目录路径都必须触发对账。"""
    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol

    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(bindings, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)

    storage = LocalStorageBackend(Path(tmp_path))
    service = FileService(db, storage=storage)
    folder = await service.create_folder(
        user_a.id, name="资料", parent_id=None, project_id=None,
    )
    nested = await service.create_folder(
        user_a.id, name="笔记", parent_id=folder.id, project_id=None,
    )
    await service.create_folder(
        user_a.id, name="空目录", parent_id=folder.id, project_id=None,
    )
    storage_key = f"{user_a.id}/个人文件/资料/笔记/说明.txt"
    await storage.put(storage_key, b"content", "text/plain")
    file_row = File(
        user_id=user_a.id, display_name="说明", ext="TXT", space="personal",
        folder_id=nested.id, storage_key=storage_key, size_bytes=7,
    )
    db.add(file_row)
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        status="active", root_path=".", root_fingerprint="d" * 64,
    )
    db.add(binding)
    await db.flush()

    await service.delete_folder(user_a.id, folder.id)
    await db.flush()
    await db.refresh(binding)
    deleted = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
    ).order_by(FileSyncJournal.id))).all()
    assert {(row.relative_path, row.operation, row.object_type) for row in deleted} == {
        ("个人文件/资料/笔记/说明.txt", "delete", "file"),
        ("个人文件/资料", "delete", "folder"),
        ("个人文件/资料/笔记", "delete", "folder"),
        ("个人文件/资料/空目录", "delete", "folder"),
    }
    assert binding.dirty_revision == 4

    await service.restore_folder(user_a.id, folder.id)
    await db.flush()
    await db.refresh(binding)
    changes = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
    ).order_by(FileSyncJournal.id))).all()
    assert {(row.relative_path, row.operation, row.object_type) for row in changes} == {
        ("个人文件/资料/笔记/说明.txt", "delete", "file"),
        ("个人文件/资料", "delete", "folder"),
        ("个人文件/资料/笔记", "delete", "folder"),
        ("个人文件/资料/空目录", "delete", "folder"),
        ("个人文件/资料", "create", "folder"),
        ("个人文件/资料/笔记", "create", "folder"),
        ("个人文件/资料/空目录", "create", "folder"),
        ("个人文件/资料/笔记/说明.txt", "create", "file"),
    }
    assert binding.dirty_revision == 8


@pytest.mark.asyncio
async def test_project_batch_trash_and_undo_restore_advance_binding_watermark(
    db, user_a, monkeypatch, tmp_path,
):
    """项目批量软删与撤回恢复沿用文件级同步事件，不漏掉项目下的文件路径。"""
    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol
    from app.services.projects import soft_delete_project_full

    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(bindings, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)

    storage = LocalStorageBackend(Path(tmp_path))
    project = Project(user_id=user_a.id, name="fs6-probe", start_date="2026-09-15")
    db.add(project)
    await db.flush()
    storage_key = f"{user_a.id}/项目文件/2026/09/fs6-probe #{project.id}/notes.md"
    await storage.put(storage_key, b"project data", "text/markdown")
    file_row = File(
        user_id=user_a.id, project_id=project.id, display_name="notes", ext="MD",
        space="project", storage_key=storage_key, size_bytes=12,
    )
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        status="active", root_path=".", root_fingerprint="f" * 64,
    )
    db.add_all([file_row, binding])
    await db.flush()

    stamp = now_utc()
    await soft_delete_project_full(db, storage, user_a.id, project, stamp)
    await db.flush()
    await restore_file_storage(file_row, storage, db)
    file_row.deleted_at = None
    await db.flush()

    changes = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
    ).order_by(FileSyncJournal.id))).all()
    assert [(row.relative_path, row.operation, row.object_type) for row in changes] == [
        (f"项目文件/2026/09/fs6-probe #{project.id}/notes.md", "delete", "file"),
        (f"项目文件/2026/09/fs6-probe #{project.id}/notes.md", "create", "file"),
    ]
    await db.refresh(binding)
    assert binding.dirty_revision == 2
