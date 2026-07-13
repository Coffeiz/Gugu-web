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


def _svc_wired(db, tmp_path, monkeypatch):
    """真实 relocate 集成用：relocate_folder_tree_files 内部自取 get_storage()，须与
    FileService 用同一后端，故两处 get_storage 都指向同一 tmp 本地后端。"""
    storage = LocalStorageBackend(Path(tmp_path))
    monkeypatch.setattr("app.services.storage.file_service.get_storage", lambda: storage)
    monkeypatch.setattr("app.services.storage.folders.get_storage", lambda: storage)
    return FileService(db)


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


async def test_create_folder_delegates(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    f = await svc.create_folder(user_a.id, name="资料", parent_id=None, project_id=None)
    await db.commit()
    assert f.id and f.name == "资料"
    assert (svc.storage.root / f"{user_a.id}/个人文件/资料").is_dir()   # P1.2：空夹上盘


async def test_create_folder_duplicate_raises(db, user_a, tmp_path):
    svc = _svc(db, tmp_path)
    await svc.create_folder(user_a.id, name="dup", parent_id=None, project_id=None)
    await db.commit()
    with pytest.raises(Conflict):
        await svc.create_folder(user_a.id, name="dup", parent_id=None, project_id=None)


async def test_rename_folder_pathmirror_relocates(db, user_a, tmp_path, monkeypatch):
    calls = []

    async def spy(db_, uid, root_id):
        calls.append(root_id)

    monkeypatch.setattr(folders_mod, "relocate_folder_tree_files", spy)
    svc = _svc(db, tmp_path)   # 默认 PathMirrorStrategy → move_semantics=relocate
    f = await svc.create_folder(user_a.id, name="old", parent_id=None, project_id=None)
    await db.commit()
    r = await svc.rename_folder(user_a.id, f.id, "new")
    await db.commit()
    assert r.name == "new"
    assert calls == [f.id]      # path-mirror → relocate 被调


async def test_move_folder_pathmirror_relocates(db, user_a, tmp_path, monkeypatch):
    calls = []

    async def spy(db_, uid, root_id):
        calls.append(root_id)

    monkeypatch.setattr(folders_mod, "relocate_folder_tree_files", spy)
    svc = _svc(db, tmp_path)
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


# ── P1 目录一致性（真实 relocate + 目录对账，验证 adr/123 修复且不误删活夹）──────

async def test_rename_folder_moves_dir_and_cleans_orphan(db, user_a, tmp_path, monkeypatch):
    svc = _svc_wired(db, tmp_path, monkeypatch)
    folder = await svc.create_folder(user_a.id, name="adr", parent_id=None, project_id=None)
    await db.commit()
    r = await _create(svc, user_a.id, "note", "MD", data=b"x", folder_id=folder.id)
    await db.commit()
    root = svc.storage.root
    assert (root / f"{user_a.id}/个人文件/adr/note.md").is_file()
    await svc.rename_folder(user_a.id, folder.id, "adr2")
    await db.commit()
    await db.refresh(r.file)
    assert "/个人文件/adr2/" in r.file.storage_key
    assert await svc.storage.exists(r.file.storage_key)
    assert not (root / f"{user_a.id}/个人文件/adr").exists()      # 幽灵目录清掉（治 adr）
    assert (root / f"{user_a.id}/个人文件/adr2").is_dir()


async def test_rename_empty_folder_moves_dir(db, user_a, tmp_path, monkeypatch):
    svc = _svc_wired(db, tmp_path, monkeypatch)
    folder = await svc.create_folder(user_a.id, name="空", parent_id=None, project_id=None)
    await db.commit()
    root = svc.storage.root
    assert (root / f"{user_a.id}/个人文件/空").is_dir()
    await svc.rename_folder(user_a.id, folder.id, "空2")
    await db.commit()
    assert (root / f"{user_a.id}/个人文件/空2").is_dir()          # 空夹改名也搬目录
    assert not (root / f"{user_a.id}/个人文件/空").exists()


async def test_move_folder_out_keeps_live_parent_dir(db, user_a, tmp_path, monkeypatch):
    svc = _svc_wired(db, tmp_path, monkeypatch)
    parent = await svc.create_folder(user_a.id, name="parent", parent_id=None, project_id=None)
    await db.commit()
    child = await svc.create_folder(user_a.id, name="child", parent_id=parent.id, project_id=None)
    await db.commit()
    root = svc.storage.root
    assert (root / f"{user_a.id}/个人文件/parent/child").is_dir()
    await svc.move_folder(user_a.id, child.id, None)             # child 移到根
    await db.commit()
    assert (root / f"{user_a.id}/个人文件/child").is_dir()          # 新位置
    assert not (root / f"{user_a.id}/个人文件/parent/child").exists()  # 旧位置清掉
    assert (root / f"{user_a.id}/个人文件/parent").is_dir()          # 活着的空父夹保留（不误删，治反向 123）


async def test_file_move_keeps_source_folder_dir(db, user_a, tmp_path, monkeypatch):
    svc = _svc_wired(db, tmp_path, monkeypatch)
    src = await svc.create_folder(user_a.id, name="src", parent_id=None, project_id=None)
    dst = await svc.create_folder(user_a.id, name="dst", parent_id=None, project_id=None)
    await db.commit()
    r = await _create(svc, user_a.id, "f", "TXT", data=b"1", folder_id=src.id)
    await db.commit()
    root = svc.storage.root
    await svc.update_file(user_a.id, r.file.id, display_name=None, stage_name=None,
                          folder_id=dst.id, project_id=None, folder_set=True, project_set=False)
    await db.commit()
    await db.refresh(r.file)
    assert "/个人文件/dst/" in r.file.storage_key
    assert await svc.storage.exists(r.file.storage_key)
    assert (root / f"{user_a.id}/个人文件/src").is_dir()            # 源文件夹仍活着 → 目录保留
