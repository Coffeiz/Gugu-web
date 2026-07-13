"""P0.3 FileService 文件夹操作 —— 门面 delegate FolderTree + 按 move_semantics 门控物理归位。"""
import pytest

import app.services.storage.file_service.folders as folders_mod
from app.core.errors import Conflict
from app.services.storage.file_service import FileService


class _OpaqueStub:
    @property
    def move_semantics(self):
        return "db-only"


async def test_create_folder_delegates(db, user_a):
    svc = FileService(db)
    f = await svc.create_folder(user_a.id, name="资料", parent_id=None, project_id=None)
    await db.commit()
    assert f.id and f.name == "资料"


async def test_create_folder_duplicate_raises(db, user_a):
    svc = FileService(db)
    await svc.create_folder(user_a.id, name="dup", parent_id=None, project_id=None)
    await db.commit()
    with pytest.raises(Conflict):
        await svc.create_folder(user_a.id, name="dup", parent_id=None, project_id=None)


async def test_rename_folder_pathmirror_relocates(db, user_a, monkeypatch):
    calls = []

    async def spy(db_, uid, root_id):
        calls.append(root_id)

    monkeypatch.setattr(folders_mod, "relocate_folder_tree_files", spy)
    svc = FileService(db)   # 默认 PathMirrorStrategy → move_semantics=relocate
    f = await svc.create_folder(user_a.id, name="old", parent_id=None, project_id=None)
    await db.commit()
    r = await svc.rename_folder(user_a.id, f.id, "new")
    await db.commit()
    assert r.name == "new"
    assert calls == [f.id]      # path-mirror → relocate 被调


async def test_move_folder_pathmirror_relocates(db, user_a, monkeypatch):
    calls = []

    async def spy(db_, uid, root_id):
        calls.append(root_id)

    monkeypatch.setattr(folders_mod, "relocate_folder_tree_files", spy)
    svc = FileService(db)
    a = await svc.create_folder(user_a.id, name="a", parent_id=None, project_id=None)
    await db.flush()
    b = await svc.create_folder(user_a.id, name="b", parent_id=None, project_id=None)
    await db.commit()
    moved = await svc.move_folder(user_a.id, a.id, b.id)
    await db.commit()
    assert moved.parent_id == b.id
    assert calls == [a.id]


async def test_opaque_skips_relocate(db, user_a, monkeypatch):
    calls = []

    async def spy(*a):
        calls.append(1)

    monkeypatch.setattr(folders_mod, "relocate_folder_tree_files", spy)
    svc = FileService(db, key_strategy=_OpaqueStub())
    f = await svc.create_folder(user_a.id, name="x", parent_id=None, project_id=None)
    await db.commit()
    await svc.rename_folder(user_a.id, f.id, "y")
    await db.commit()
    assert calls == []          # opaque（db-only）→ relocate 不调
