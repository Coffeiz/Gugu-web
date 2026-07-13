"""P0.5 folder REST 端点 —— delegate 到 FileService 后端到端行为 + 领域异常映射不变。

同 test_mind_api：直接调路由函数（current_user/db/origin 显式传），不起 TestClient。
"""
from pathlib import Path

import pytest

from app.api.v1 import folders as folders_api
from app.core.errors import Conflict, Invalid, NotFound
from app.schemas import FolderCreate, FolderMove, FolderRename
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


async def test_move_version_conflict(db, user_a):
    a = await _create(db, user_a, "a")
    b = await _create(db, user_a, "b")
    with pytest.raises(Conflict):
        await folders_api.move_folder(a.id, FolderMove(parent_id=b.id, version=999),
                                      current_user=user_a, origin=None, db=db)
