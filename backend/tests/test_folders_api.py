"""P0.5 folder REST 端点 —— delegate 到 FileService 后端到端行为 + 领域异常映射不变。

同 test_mind_api：直接调路由函数（current_user/db/origin 显式传），不起 TestClient。
"""
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import folders as folders_api
from app.core.errors import Conflict, Invalid, NotFound
from app.models import FileSyncBinding, FileSyncJournal, Project
from app.schemas import FolderCopy, FolderCreate, FolderMove, FolderRename
from app.services.storage import LocalStorageBackend


@pytest.fixture(autouse=True)
def _no_events(tmp_path, monkeypatch):
    async def _noop(*a, **k):
        pass
    monkeypatch.setattr(folders_api.events, "publish", _noop)
    # 端点内部 FileService(db) 走 get_storage()，指向临时本地后端（P1 建夹/改名会真 mkdir/mv）
    storage = LocalStorageBackend(Path(tmp_path))
    monkeypatch.setattr("app.services.storage.file_service.get_storage", lambda: storage)


async def _create(db, user, name, **kw):
    return await folders_api.create_folder(
        FolderCreate(name=name, **kw), current_user=user, origin=None, db=db)


async def test_create_endpoint(db, user_a):
    r = await _create(db, user_a, "资料")
    assert r.name == "资料" and r.file_count == 0 and r.parent_id is None


async def test_create_duplicate_conflict(db, user_a):
    await _create(db, user_a, "dup")
    with pytest.raises(Conflict):
        await _create(db, user_a, "dup")


async def test_create_project_not_found(db, user_a):
    with pytest.raises(NotFound):
        await _create(db, user_a, "x", project_id=999)


async def test_rename_endpoint(db, user_a):
    r = await _create(db, user_a, "old")
    r2 = await folders_api.rename_folder(r.id, FolderRename(name="new", version=r.version),
                                         current_user=user_a, origin=None, db=db)
    assert r2.name == "new" and r2.version == r.version + 1


async def test_empty_folder_rename_advances_sync_path_watermark(
    db, user_a, monkeypatch, tmp_path,
):
    """即使文件夹为空，改名也要向绑定提交旧/新路径的变更水位。"""
    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol

    folder = await _create(db, user_a, "before")
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(protocol, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(bindings, "get_settings", lambda: settings)
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        status="active", root_path=".", root_fingerprint="c" * 64,
    )
    db.add(binding)
    await db.flush()

    renamed = await folders_api.rename_folder(
        folder.id, FolderRename(name="after", version=folder.version),
        current_user=user_a, origin=None, db=db,
    )

    changes = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
        FileSyncJournal.object_type == "folder",
    ).order_by(FileSyncJournal.id))).all()
    assert renamed.name == "after"
    assert [(row.relative_path, row.operation) for row in changes] == [
        ("个人文件/before", "delete"),
        ("个人文件/after", "create"),
    ]
    await db.refresh(binding)
    assert binding.dirty_revision == 2


async def test_rename_not_found(db, user_a):
    with pytest.raises(NotFound):
        await folders_api.rename_folder(999, FolderRename(name="x", version=1),
                                        current_user=user_a, origin=None, db=db)


async def test_rename_version_conflict(db, user_a):
    r = await _create(db, user_a, "old")
    with pytest.raises(Conflict):
        await folders_api.rename_folder(r.id, FolderRename(name="new", version=999),
                                        current_user=user_a, origin=None, db=db)


async def test_move_endpoint_and_cycle(db, user_a):
    a = await _create(db, user_a, "a")
    b = await _create(db, user_a, "b")
    moved = await folders_api.move_folder(a.id, FolderMove(parent_id=b.id, version=a.version),
                                          current_user=user_a, origin=None, db=db)
    assert moved.parent_id == b.id
    with pytest.raises(Invalid):     # b 移进其子孙 a → 循环
        await folders_api.move_folder(b.id, FolderMove(parent_id=a.id, version=b.version),
                                      current_user=user_a, origin=None, db=db)


async def test_move_target_not_found(db, user_a):
    a = await _create(db, user_a, "a")
    with pytest.raises(NotFound):
        await folders_api.move_folder(a.id, FolderMove(parent_id=999, version=a.version),
                                      current_user=user_a, origin=None, db=db)


async def test_move_and_copy_folder_across_project_endpoint(db, user_a):
    source = await _create(db, user_a, "来源")
    project = Project(user_id=user_a.id, name="目标项目", start_date="2026-07-15")
    db.add(project)
    await db.commit()

    moved = await folders_api.move_folder(
        source.id, FolderMove(parent_id=None, project_id=project.id, version=source.version),
        current_user=user_a, origin=None, db=db,
    )
    assert moved.project_id == project.id

    copied = await folders_api.copy_folder(
        source.id, FolderCopy(parent_id=None, project_id=None),
        current_user=user_a, origin=None, db=db,
    )
    assert copied.id != source.id
    assert copied.project_id == project.id


async def test_move_version_conflict(db, user_a):
    a = await _create(db, user_a, "a")
    b = await _create(db, user_a, "b")
    with pytest.raises(Conflict):
        await folders_api.move_folder(a.id, FolderMove(parent_id=b.id, version=999),
                                      current_user=user_a, origin=None, db=db)


async def test_folder_download_rejects_other_user_folder(db, user_a, user_b):
    folder = await _create(db, user_b, "私有文件夹")
    with pytest.raises(HTTPException) as error:
        await folders_api.download_folder(folder.id, current_user=user_a, db=db)
    assert error.value.status_code == 404
