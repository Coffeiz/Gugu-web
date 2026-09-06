from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models import File, FileSyncJournal, Folder, Workspace
from app.services.filesync import reconcile_local_directory


@pytest.mark.asyncio
async def test_phase6_reconcile_projects_folder_create_move_and_delete(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.protocol as protocol
    import app.services.filesync.reconcile as reconcile

    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(
        reconcile,
        "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path))),
    )

    root = tmp_path / str(user_a.id) / "个人文件"
    source = root / "source"
    source.mkdir(parents=True)
    (source / "report.txt").write_text("report", encoding="utf-8")

    first = await reconcile_local_directory(db, user_a.id)
    await db.commit()
    assert first.folders_created == 1
    folder = (await db.scalars(select(Folder).where(Folder.name == "source"))).one()
    file_row = (await db.scalars(select(File))).one()

    workspace = Workspace(
        user_id=user_a.id, name="同步工作区", kind="folder", folder_id=folder.id,
        enabled=True,
    )
    db.add(workspace)
    await db.flush()
    async def workspace_root(_db, _user_id, _workspace_id):
        return source
    monkeypatch.setattr(reconcile, "resolve_workspace_root", workspace_root)
    anchored = await reconcile_local_directory(db, user_a.id, workspace_id=workspace.id)
    await db.commit()
    assert anchored.deleted == 0
    assert folder.deleted_at is None

    target = root / "archive" / "source"
    target.parent.mkdir()
    source.rename(target)
    second = await reconcile_local_directory(db, user_a.id)
    await db.commit()
    assert second.moved == 1
    assert second.folders_created == 2
    assert file_row.folder_id != folder.id
    assert folder.deleted_at is not None
    assert (await db.scalars(select(Folder).where(
        Folder.name == "source", Folder.deleted_at.is_(None),
    ))).one().id == file_row.folder_id

    (target / "report.txt").unlink()
    target.rmdir()
    target.parent.rmdir()
    third = await reconcile_local_directory(db, user_a.id)
    await db.commit()
    assert third.deleted == 1
    assert third.folders_deleted == 2
    assert file_row.deleted_at is not None
    folder_journals = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.object_type == "folder",
    ))).all()
    assert {item.operation for item in folder_journals} >= {"create", "delete"}
