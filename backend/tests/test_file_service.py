"""P0.3 FileService 文件夹操作 —— 门面 delegate FolderTree + 按 move_semantics 门控物理归位。

P0.3b：文件写操作（create/update/copy）走 KeyStrategy 抽象，逐字复刻 files.py 语义
（key/配额/覆盖/冲突改名/跨空间归属/领域异常 status）。
"""
from pathlib import Path

import pytest

import app.services.storage.file_service.folders as folders_mod
from app.core.errors import Conflict, Invalid, NotFound
from app.models import Project
from app.services.storage import LocalStorageBackend
from app.services.storage.file_service import FileService


def _svc(db, tmp_path):
    return FileService(db, storage=LocalStorageBackend(Path(tmp_path)))


async def _create(svc, uid, name, ext, data=b"x", **kw):
    kw.setdefault("space", "personal")
    kw.setdefault("project_id", None)
    kw.setdefault("folder_id", None)
    kw.setdefault("stage_name", "")
    kw.setdefault("mind_map_id", None)
    kw.setdefault("mime_type", "text/plain")
    return await svc.create_file(uid, display_name=name, ext=ext, data=data, **kw)


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


# ── P0.3b 文件写操作 ──────────────────────────────────────────────────────────

async def test_create_file_personal(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    r = await _create(svc, user_a.id, "报告", "PDF", data=b"hello", mime_type="application/pdf")
    await db.commit()
    f = r.file
    assert f.id and f.display_name == "报告" and f.ext == "PDF" and f.space == "personal"
    assert f.storage_key == f"{user_a.id}/个人文件/报告.pdf"
    assert f.size_bytes == 5
    assert await svc.storage.exists(f.storage_key)
    assert r.project is None and r.folder_name is None and not r.was_overwrite


async def test_create_file_keep_both_conflict(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    r1 = await _create(svc, user_a.id, "a", "TXT", data=b"1")
    await db.commit()
    r2 = await _create(svc, user_a.id, "a", "TXT", data=b"2")
    await db.commit()
    assert r2.file.display_name == "a(1)"
    assert r2.file.storage_key != r1.file.storage_key
    assert r2.file.storage_key.endswith("/个人文件/a(1).txt")


async def test_create_file_overwrite(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    r1 = await _create(svc, user_a.id, "a", "TXT", data=b"old")
    await db.commit()
    r2 = await _create(svc, user_a.id, "a", "TXT", data=b"newer",
                       on_conflict="overwrite", overwrite_file_id=r1.file.id)
    await db.commit()
    assert r2.was_overwrite and r2.file.id == r1.file.id and r2.file.size_bytes == 5
    assert await svc.storage.get(r2.file.storage_key) == b"newer"


async def test_create_file_overwrite_target_missing(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    with pytest.raises(Invalid) as ei:
        await _create(svc, user_a.id, "a", "TXT", on_conflict="overwrite", overwrite_file_id=999)
    assert ei.value.public_message == "要覆盖的文件不存在"


async def test_create_file_quota_full(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    with pytest.raises(Invalid) as ei:
        await _create(svc, user_a.id, "big", "BIN", data=b"x" * 100, storage_limit_bytes=10)
    assert ei.value.public_message == "存储空间已满，无法上传"


async def test_create_file_project_not_found(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    with pytest.raises(Invalid) as ei:
        await _create(svc, user_a.id, "a", "TXT", space="project", project_id=999)
    assert ei.value.public_message == "项目不存在"


async def test_create_file_project_requires_id(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    with pytest.raises(Invalid) as ei:
        await _create(svc, user_a.id, "a", "TXT", space="project", project_id=None)
    assert ei.value.public_message == "project 空间需要提供 project_id"


async def test_create_file_in_project(db, user_a, tmp_path):
    p = Project(user_id=user_a.id, name="设计", start_date="2026-03-15")
    db.add(p)
    await db.commit()
    await db.refresh(p)
    svc = _svc(db, tmp_path)
    r = await _create(svc, user_a.id, "图", "PNG", data=b"x",
                      mime_type="image/png", space="project", project_id=p.id)
    await db.commit()
    assert r.file.storage_key == f"{user_a.id}/项目文件/2026/03/设计 #{p.id}/图.png"
    assert r.project is not None and r.project.id == p.id


async def test_update_file_rename(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    r = await _create(svc, user_a.id, "old", "TXT", data=b"1")
    await db.commit()
    old_key = r.file.storage_key
    r2 = await svc.update_file(user_a.id, r.file.id, display_name="new", stage_name=None,
                               folder_id=None, project_id=None, folder_set=False, project_set=False)
    await db.commit()
    assert r2.file.display_name == "new"
    assert r2.file.storage_key.endswith("/个人文件/new.txt")
    assert await svc.storage.exists(r2.file.storage_key)
    assert not await svc.storage.exists(old_key)


async def test_update_file_not_found(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    with pytest.raises(NotFound):
        await svc.update_file(user_a.id, 999, display_name="x", stage_name=None,
                              folder_id=None, project_id=None, folder_set=False, project_set=False)


async def test_update_file_other_user_denied(db, user_a, user_b, tmp_path):
    svc = _svc(db, tmp_path)
    r = await _create(svc, user_a.id, "mine", "TXT", data=b"1")
    await db.commit()
    with pytest.raises(NotFound):        # B 拿 A 的 file id → 归属不符即「不存在」
        await svc.update_file(user_b.id, r.file.id, display_name="x", stage_name=None,
                              folder_id=None, project_id=None, folder_set=False, project_set=False)


async def test_copy_file(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    r = await _create(svc, user_a.id, "doc", "TXT", data=b"body")
    await db.commit()
    r2 = await svc.copy_file(user_a.id, r.file.id, folder_id=None, project_id=None)
    await db.commit()
    assert r2.file.id != r.file.id
    assert r2.file.display_name == "doc(1)"        # 同空间同名 → 冲突改名
    assert await svc.storage.get(r2.file.storage_key) == b"body"


async def test_copy_file_not_found(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    with pytest.raises(NotFound):
        await svc.copy_file(user_a.id, 999, folder_id=None, project_id=None)
