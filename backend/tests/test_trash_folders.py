"""P2.2-P2.5 文件夹回收站：软删端点、顶层列表、恢复端点、过期清理。

同 test_folders_api：直接调路由函数（current_user/db/origin 显式传），不起 TestClient。
FileService(db) 内部走 get_storage()，monkeypatch 指向 tmp_path 本地后端；事件广播 noop。
"""
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.api.v1 import folders as folders_api
from app.api.v1 import trash as trash_api
from app.core.errors import NotFound
from app.core.tz import now_utc
from app.models import File, Folder
from app.schemas import FolderCreate
from app.services.storage import LocalStorageBackend
from app.services.storage.file_service import FileService


@pytest.fixture(autouse=True)
def _storage_and_events(tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    monkeypatch.setattr("app.services.storage.file_service.get_storage", lambda: storage)
    monkeypatch.setattr(trash_api, "get_storage", lambda: storage)

    async def _noop(*a, **k):
        pass
    monkeypatch.setattr(folders_api.events, "publish", _noop)
    monkeypatch.setattr(trash_api.events, "publish", _noop)
    return storage


async def _mk_folder_with_file(db, user, name, data=b"x"):
    svc = FileService(db)
    folder = await folders_api.create_folder(
        FolderCreate(name=name), current_user=user, origin=None, db=db)
    r = await svc.create_file(
        user.id, space="personal", project_id=None, folder_id=folder.id, stage_name="",
        mind_map_id=None, display_name="note", ext="TXT", mime_type="text/plain", data=data)
    await db.commit()
    return folder, r.file


async def test_delete_folder_endpoint_soft_deletes(db, user_a):
    folder, f = await _mk_folder_with_file(db, user_a, "资料")
    await folders_api.delete_folder(folder.id, current_user=user_a, origin=None, db=db)
    row = await db.get(Folder, folder.id)
    assert row is not None and row.deleted_at is not None       # 行还在，软删
    await db.refresh(f)
    assert f.deleted_at is not None


async def test_delete_folder_endpoint_not_found(db, user_a):
    with pytest.raises(NotFound):
        await folders_api.delete_folder(999, current_user=user_a, origin=None, db=db)


async def test_delete_folder_hidden_from_list_endpoint(db, user_a):
    folder, _ = await _mk_folder_with_file(db, user_a, "资料")
    await folders_api.delete_folder(folder.id, current_user=user_a, origin=None, db=db)
    kids = await folders_api.list_folders(project_id=None, parent_id=None, current_user=user_a, db=db)
    assert kids == []


async def test_list_trash_folders_top_level_only(db, user_a):
    parent, _ = await _mk_folder_with_file(db, user_a, "parent")
    child_svc = FileService(db)
    child = await child_svc.create_folder(user_a.id, name="child", parent_id=parent.id, project_id=None)
    await db.commit()

    await folders_api.delete_folder(parent.id, current_user=user_a, origin=None, db=db)
    out = await trash_api.list_trash_folders(current_user=user_a, db=db)
    assert [f.id for f in out] == [parent.id]        # child 被祖先那次删除连带扫入，不单列
    assert out[0].file_count == 1                     # parent 自己直接包含的那个文件


async def test_list_trash_folders_excludes_live(db, user_a):
    await _mk_folder_with_file(db, user_a, "live")
    out = await trash_api.list_trash_folders(current_user=user_a, db=db)
    assert out == []


async def test_list_trash_folder_contents_returns_children(db, user_a):
    parent, parent_file = await _mk_folder_with_file(db, user_a, "可展开")
    child = await FileService(db).create_folder(
        user_a.id, name="二级目录", parent_id=parent.id, project_id=None)
    child_file = (await FileService(db).create_file(
        user_a.id, space="personal", project_id=None, folder_id=child.id, stage_name="",
        mind_map_id=None, display_name="子文件", ext="TXT", mime_type="text/plain", data=b"x"
    )).file
    await db.commit()
    await folders_api.delete_folder(parent.id, current_user=user_a, origin=None, db=db)

    out = await trash_api.list_trash_folder_contents(current_user=user_a, fid=parent.id, db=db)

    assert [folder.name for folder in out.folders] == ["二级目录"]
    assert out.folders[0].file_count == 1
    assert {file.display_name for file in out.files} == {parent_file.display_name}
    assert child_file.display_name not in {file.display_name for file in out.files}


async def test_folder_deleted_files_are_hidden_and_cannot_restore_individually(db, user_a):
    folder, f = await _mk_folder_with_file(db, user_a, "资料")
    await folders_api.delete_folder(folder.id, current_user=user_a, origin=None, db=db)

    # 文件夹是唯一恢复单元：子文件既不应单列，也不能被直接恢复成指向已删父目录的幽灵。
    assert await trash_api.list_trash(current_user=user_a, db=db) == []
    with pytest.raises(HTTPException) as exc:
        await trash_api.restore_file(f.id, current_user=user_a, origin=None, db=db)
    assert exc.value.status_code == 409
    await db.refresh(f)
    assert f.deleted_at is not None


async def test_empty_trash_removes_deleted_folder_with_its_files(db, user_a):
    folder, f = await _mk_folder_with_file(db, user_a, "待清空")
    await folders_api.delete_folder(folder.id, current_user=user_a, origin=None, db=db)

    await trash_api.empty_trash(current_user=user_a, origin=None, db=db)

    assert await db.get(Folder, folder.id) is None
    assert await db.get(File, f.id) is None


async def test_hard_delete_trash_folder_removes_its_subtree(db, user_a):
    parent, parent_file = await _mk_folder_with_file(db, user_a, "待永久删除")
    child = await FileService(db).create_folder(
        user_a.id, name="子文件夹", parent_id=parent.id, project_id=None)
    child_file = (await FileService(db).create_file(
        user_a.id, space="personal", project_id=None, folder_id=child.id, stage_name="",
        mind_map_id=None, display_name="child", ext="TXT", mime_type="text/plain", data=b"x"
    )).file
    await db.commit()
    await folders_api.delete_folder(parent.id, current_user=user_a, origin=None, db=db)

    await trash_api.hard_delete_folder(parent.id, current_user=user_a, origin=None, db=db)

    assert await db.get(Folder, parent.id) is None
    assert await db.get(Folder, child.id) is None
    assert await db.get(File, parent_file.id) is None
    assert await db.get(File, child_file.id) is None


async def test_restore_folder_endpoint_round_trip(db, user_a):
    folder, f = await _mk_folder_with_file(db, user_a, "资料", data=b"body")
    await folders_api.delete_folder(folder.id, current_user=user_a, origin=None, db=db)
    resp = await trash_api.restore_folder(folder.id, current_user=user_a, origin=None, db=db)
    assert resp.id == folder.id

    row = await db.get(Folder, folder.id)
    assert row.deleted_at is None
    await db.refresh(f)
    assert f.deleted_at is None
    kids = await folders_api.list_folders(project_id=None, parent_id=None, current_user=user_a, db=db)
    assert folder.id in {k.id for k in kids}


async def test_restore_folder_endpoint_not_found_when_live(db, user_a):
    folder, _ = await _mk_folder_with_file(db, user_a, "live")
    with pytest.raises(NotFound):
        await trash_api.restore_folder(folder.id, current_user=user_a, origin=None, db=db)


async def test_cleanup_expired_purges_old_folder_and_keeps_recent(db, user_a, _storage_and_events):
    old_folder, old_file = await _mk_folder_with_file(db, user_a, "old")
    new_folder, new_file = await _mk_folder_with_file(db, user_a, "recent")

    await folders_api.delete_folder(old_folder.id, current_user=user_a, origin=None, db=db)
    await folders_api.delete_folder(new_folder.id, current_user=user_a, origin=None, db=db)

    # 把 old 那批的时间戳往前拨 31 天，模拟「早已过期」
    stale = now_utc() - timedelta(days=31)
    old_folder_row = await db.get(Folder, old_folder.id)
    old_folder_row.deleted_at = stale
    await db.refresh(old_file)
    old_file.deleted_at = stale
    await db.commit()

    n = await trash_api.cleanup_expired(db)
    assert n == 1                                     # 只清了 old_file 这一个过期文件

    assert await db.get(Folder, old_folder.id) is None            # 过期文件夹被硬删
    assert await db.get(File, old_file.id) is None                # 对应文件行也没了

    assert await db.get(Folder, new_folder.id) is not None        # 近期删除的不受影响
    fresh_new_file = await db.get(File, new_file.id)
    assert fresh_new_file is not None and fresh_new_file.deleted_at is not None
