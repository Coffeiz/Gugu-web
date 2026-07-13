"""P1.5 folder_doctor —— 目录对账：报缺失/孤儿、补缺失、确认后清孤儿、忽略结构目录。"""
from pathlib import Path

from app.api.v1 import folder_doctor_admin as doctor_api
from app.models import Folder
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
