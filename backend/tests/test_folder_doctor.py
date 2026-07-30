"""P1.5 folder_doctor —— 目录对账：报缺失/孤儿、补缺失、确认后清孤儿、忽略结构目录。"""
from pathlib import Path

from app.api.v1 import folder_doctor_admin as doctor_api
from app.models import File, Folder
from app.services.storage import LocalStorageBackend, folder_doctor
from app.services.storage.file_service import FileService


def _storage(tmp_path):
    return LocalStorageBackend(Path(tmp_path))


async def _folder_row(db, user, name, **kw):
    f = Folder(user_id=user.id, name=name, **kw)
    db.add(f)
    await db.commit()
    await db.refresh(f)
    return f


async def test_scan_detects_missing(db, user_a, tmp_path):
    storage = _storage(tmp_path)
    await _folder_row(db, user_a, "资料")       # DB 有行、盘上无目录
    report = await folder_doctor.scan(db, storage, user_a.id)
    assert f"{user_a.id}/个人文件/资料" in report.missing_dirs
    assert report.orphan_dirs == []
    assert report.scanned_folders == 1


async def test_scan_detects_orphan(db, user_a, tmp_path):
    storage = _storage(tmp_path)
    await storage.ensure_folder(f"{user_a.id}/个人文件/ghost")   # 盘上有、DB 无
    report = await folder_doctor.scan(db, storage, user_a.id)
    assert report.orphan_dirs == [f"{user_a.id}/个人文件/ghost"]


async def test_scan_ignores_structural_dirs(db, user_a, tmp_path):
    storage = _storage(tmp_path)
    await storage.ensure_folder(f"{user_a.id}/个人文件")   # 空间根，非孤儿
    await storage.ensure_folder(f"{user_a.id}/trash/5")   # 回收站，非孤儿
    report = await folder_doctor.scan(db, storage, user_a.id)
    assert report.orphan_dirs == []


async def test_scan_ignores_nonempty_orphan(db, user_a, tmp_path):
    storage = _storage(tmp_path)
    await storage.put(f"{user_a.id}/个人文件/hasfile/x.txt", b"1")
    report = await folder_doctor.scan(db, storage, user_a.id)
    assert report.orphan_dirs == []   # 非空目录绝不纳入


async def test_repair_creates_missing(db, user_a, tmp_path):
    storage = _storage(tmp_path)
    await _folder_row(db, user_a, "补")
    report = await folder_doctor.repair(db, storage, user_id=user_a.id)
    assert report.created == 1
    assert (storage.root / f"{user_a.id}/个人文件/补").is_dir()


async def test_repair_removes_orphan_only_with_flag(db, user_a, tmp_path):
    storage = _storage(tmp_path)
    await storage.ensure_folder(f"{user_a.id}/个人文件/ghost")
    r1 = await folder_doctor.repair(db, storage, user_id=user_a.id)   # 默认不删
    assert r1.removed == 0
    assert (storage.root / f"{user_a.id}/个人文件/ghost").is_dir()
    r2 = await folder_doctor.repair(db, storage, user_id=user_a.id, remove_orphans=True)
    assert r2.removed == 1
    assert not (storage.root / f"{user_a.id}/个人文件/ghost").exists()


async def test_scan_healthy_after_create(db, user_a, tmp_path):
    svc = FileService(db, storage=_storage(tmp_path))
    await svc.create_folder(user_a.id, name="ok", parent_id=None, project_id=None)
    await db.commit()
    report = await folder_doctor.scan(db, svc.storage, user_a.id)
    assert report.to_dict()["healthy"]


# ── admin 端点 smoke（直接调路由函数；require_admin 在 include 时注入，单测不经过）──

async def test_scan_endpoint(db, user_a, tmp_path, monkeypatch):
    storage = _storage(tmp_path)
    monkeypatch.setattr(doctor_api, "get_storage", lambda: storage)
    await _folder_row(db, user_a, "端点")
    out = await doctor_api.scan_dirs(user_id=user_a.id, db=db)
    assert f"{user_a.id}/个人文件/端点" in out["missing_dirs"] and out["healthy"] is False


async def test_repair_endpoint(db, user_a, tmp_path, monkeypatch):
    storage = _storage(tmp_path)
    monkeypatch.setattr(doctor_api, "get_storage", lambda: storage)
    await _folder_row(db, user_a, "端点补")
    out = await doctor_api.repair_dirs(
        doctor_api.RepairRequest(user_id=user_a.id, remove_orphans=False), db=db)
    assert out["created"] == 1 and (storage.root / f"{user_a.id}/个人文件/端点补").is_dir()


# ── 文件位置对账（misplaced_files）：DB 说文件在 A 文件夹，物理字节还在旧位置 ──────

async def test_scan_detects_misplaced_file(db, user_a, tmp_path):
    storage = _storage(tmp_path)
    parent = await _folder_row(db, user_a, "咕咕开发")
    child = await _folder_row(db, user_a, "ADR", parent_id=parent.id)
    # 模拟历史遗留 bug：DB 说文件属于 咕咕开发/ADR，物理字节却还留在根级旧位置
    stale_key = f"{user_a.id}/个人文件/ADR/ADR-002.md"
    await storage.put(stale_key, b"content")
    f = File(user_id=user_a.id, display_name="ADR-002", ext="md", folder_id=child.id, storage_key=stale_key)
    db.add(f)
    await db.commit()
    await db.refresh(f)

    report = await folder_doctor.scan(db, storage, user_a.id)
    assert len(report.misplaced_files) == 1
    m = report.misplaced_files[0]
    assert m["file_id"] == f.id
    assert m["current_key"] == stale_key
    assert m["expected_key"] == f"{user_a.id}/个人文件/咕咕开发/ADR/ADR-002.md"
    assert report.to_dict()["healthy"] is False


async def test_repair_relocates_file_only_with_flag(db, user_a, tmp_path):
    storage = _storage(tmp_path)
    parent = await _folder_row(db, user_a, "咕咕开发")
    child = await _folder_row(db, user_a, "ADR", parent_id=parent.id)
    stale_key = f"{user_a.id}/个人文件/ADR/ADR-002.md"
    await storage.put(stale_key, b"content")
    f = File(user_id=user_a.id, display_name="ADR-002", ext="md", folder_id=child.id, storage_key=stale_key)
    db.add(f)
    await db.commit()
    await db.refresh(f)

    r1 = await folder_doctor.repair(db, storage, user_id=user_a.id)   # 默认不搬
    assert r1.relocated == 0
    assert await storage.exists(stale_key)

    r2 = await folder_doctor.repair(db, storage, user_id=user_a.id, relocate_files=True)
    assert r2.relocated == 1
    expected_key = f"{user_a.id}/个人文件/咕咕开发/ADR/ADR-002.md"
    assert await storage.exists(expected_key)
    assert not await storage.exists(stale_key)
    await db.refresh(f)
    assert f.storage_key == expected_key
    assert r2.misplaced_files == []                       # 不再有位置不一致的文件
    # 文件搬空后，陈旧的根级 "ADR" 目录变成了普通空壳孤儿——这正是两个检查组合起来
    # 完整解决真实 bug 的方式：先搬文件内容，再清空壳（remove_orphans）才到 healthy。
    assert f"{user_a.id}/个人文件/ADR" in r2.orphan_dirs
    r3 = await folder_doctor.repair(db, storage, user_id=user_a.id, remove_orphans=True)
    assert r3.to_dict()["healthy"] is True


async def test_misplaced_file_skips_missing_physical_object(db, user_a, tmp_path):
    storage = _storage(tmp_path)
    parent = await _folder_row(db, user_a, "咕咕开发")
    child = await _folder_row(db, user_a, "ADR", parent_id=parent.id)
    # storage_key 指向的位置压根没有物理对象——幽灵记录范畴，不归这个检查管
    f = File(user_id=user_a.id, display_name="ghost", ext="md", folder_id=child.id,
             storage_key=f"{user_a.id}/个人文件/nowhere/ghost.md")
    db.add(f)
    await db.commit()
    report = await folder_doctor.scan(db, storage, user_a.id)
    assert report.misplaced_files == []


async def test_misplaced_file_skips_mind_space(db, user_a, tmp_path):
    storage = _storage(tmp_path)
    stale_key = f"{user_a.id}/思维/旧画布 #1/note.md"
    await storage.put(stale_key, b"1")
    f = File(user_id=user_a.id, display_name="note", ext="md", space="mind",
             mind_map_id=1, storage_key=stale_key)
    db.add(f)
    await db.commit()
    report = await folder_doctor.scan(db, storage, user_a.id)
    assert report.misplaced_files == []   # mind 空间历史归档字段，不在纠正范围


async def test_repair_relocate_resolves_conflict(db, user_a, tmp_path):
    storage = _storage(tmp_path)
    folder = await _folder_row(db, user_a, "资料")
    # 目标位置已经有一个同名文件占着
    await storage.put(f"{user_a.id}/个人文件/资料/note.md", b"existing")
    stale_key = f"{user_a.id}/个人文件/note.md"
    await storage.put(stale_key, b"incoming")
    f = File(user_id=user_a.id, display_name="note", ext="md", folder_id=folder.id, storage_key=stale_key)
    db.add(f)
    await db.commit()

    report = await folder_doctor.repair(db, storage, user_id=user_a.id, relocate_files=True)
    assert report.relocated == 1
    await db.refresh(f)
    assert f.display_name == "note(1)"                          # 冲突改名，不覆盖已有文件
    assert f.storage_key == f"{user_a.id}/个人文件/资料/note(1).md"
    assert await storage.get(f.storage_key) == b"incoming"
    assert await storage.get(f"{user_a.id}/个人文件/资料/note.md") == b"existing"   # 原文件未被覆盖


# ── admin 端点：relocate_files 透传 ──────────────────────────────────────────

async def test_repair_endpoint_relocate_files(db, user_a, tmp_path, monkeypatch):
    storage = _storage(tmp_path)
    monkeypatch.setattr(doctor_api, "get_storage", lambda: storage)
    folder = await _folder_row(db, user_a, "资料")
    stale_key = f"{user_a.id}/个人文件/x.md"
    await storage.put(stale_key, b"1")
    f = File(user_id=user_a.id, display_name="x", ext="md", folder_id=folder.id, storage_key=stale_key)
    db.add(f)
    await db.commit()

    out = await doctor_api.repair_dirs(
        doctor_api.RepairRequest(user_id=user_a.id, relocate_files=True), db=db)
    assert out["relocated"] == 1
