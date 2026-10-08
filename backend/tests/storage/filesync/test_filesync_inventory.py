"""保护完整目录核对所用 File/Folder 清单的分页与归属范围。"""
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from app.core.tz import now_utc
from app.db import session as db_session
from app.models import File, FileSyncBinding, FileSyncJournal, Folder
from app.services.filesync.inventory import stage_database_inventory
from app.services.filesync.protocol import FileSyncStatus
from app.services.filesync.scan import connect_manifest, scan_to_manifest


@pytest.mark.asyncio
async def test_inventory_stages_only_active_rows_inside_binding_and_keeps_duplicate_paths(
    db, user_a, monkeypatch, tmp_path: Path,
):
    import app.services.filesync.inventory as inventory

    # 当前 schema 禁止活动 storage_key 重复；这里模拟唯一索引上线前的旧数据库记录。
    await db.execute(text("DROP INDEX IF EXISTS uq_files_active_user_storage_key"))

    storage_root = tmp_path / "storage"
    user_root = storage_root / str(user_a.id)
    (user_root / "个人文件").mkdir(parents=True)
    monkeypatch.setattr(
        inventory,
        "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(local_path=str(storage_root))),
    )

    binding = FileSyncBinding(
        user_id=user_a.id,
        workspace_id=None,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint="a" * 64,
    )
    folder = Folder(user_id=user_a.id, project_id=None, parent_id=None, name="目录")
    db.add_all([binding, folder])
    await db.flush()
    key = f"{user_a.id}/个人文件/文档.txt"
    active_rows = [
        File(
            user_id=user_a.id,
            display_name="文档",
            ext="txt",
            space="personal",
            folder_id=folder.id,
            storage_key=key,
            size="4",
            size_bytes=4,
            version=version,
        )
        for version in (2, 5)
    ]
    deleted_row = File(
        user_id=user_a.id,
        display_name="已删除",
        ext="txt",
        space="personal",
        storage_key=f"{user_a.id}/个人文件/deleted.txt",
        size="1",
        size_bytes=1,
        deleted_at=now_utc(),
    )
    journal = FileSyncJournal(
        binding_id=binding.id,
        user_id=user_a.id,
        idempotency_key="file-doc-fingerprint",
        source="local_directory",
        operation="create",
        object_type="file",
        relative_path="个人文件/文档.txt",
        observed_fingerprint="f" * 64,
        status=FileSyncStatus.SYNCED,
    )
    db.add_all([*active_rows, deleted_row, journal])
    await db.commit()

    manifest = scan_to_manifest(
        user_root,
        temp_directory=tmp_path / "temporary",
        stop_event=Event(),
        max_manifest_bytes=1024 * 1024,
    )
    try:
        files_count, folders_count = await stage_database_inventory(
            db_session._SessionLocal,
            user_id=user_a.id,
            binding_id=binding.id,
            root=user_root,
            manifest=manifest,
            max_manifest_bytes=1024 * 1024,
        )
        assert files_count == 2
        assert folders_count == 1
        with connect_manifest(manifest) as connection:
            duplicate_count = connection.execute(
                "SELECT COUNT(*) FROM db_files WHERE relative_path = ?",
                ("个人文件/文档.txt",),
            ).fetchone()[0]
            staged_deleted_count = connection.execute(
                "SELECT COUNT(*) FROM db_files WHERE relative_path = ?",
                ("个人文件/deleted.txt",),
            ).fetchone()[0]
            fingerprint = connection.execute(
                "SELECT fingerprint FROM db_files WHERE relative_path = ? LIMIT 1",
                ("个人文件/文档.txt",),
            ).fetchone()[0]
            folder_path = connection.execute(
                "SELECT relative_path FROM db_folders WHERE id = ?",
                (folder.id,),
            ).fetchone()[0]

        assert duplicate_count == 2
        assert staged_deleted_count == 0
        assert fingerprint == "f" * 64
        assert folder_path == "个人文件/目录"
    finally:
        manifest.close()
