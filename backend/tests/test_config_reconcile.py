from pathlib import Path

from sqlalchemy import select

from app.api.v1 import config as config_api
from app.models import File, Project
from app.services import storage as storage_module
from app.services.storage import LocalStorageBackend


async def test_import_orphan_uses_stat_and_rejects_unresolved_project(db, user_a, user_b, tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    project = Project(user_id=user_b.id, name="他人的项目", start_date="2026-08-01")
    db.add(project)
    await db.commit()
    await db.refresh(project)

    key = f"{user_a.id}/项目文件/2026/08/他人的项目 #{project.id}/secret.txt"
    await storage.put(key, b"secret")

    async def forbidden_get(_key):
        raise AssertionError("导入孤儿文件不应把整个对象读进内存")

    monkeypatch.setattr(storage, "get", forbidden_get)
    assert await config_api._import_orphan(db, key, storage) is False


async def test_import_orphan_creates_owned_file_with_stat_size(db, user_a, tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    key = f"{user_a.id}/个人文件/orphan.txt"
    await storage.put(key, b"payload")

    async def forbidden_get(_key):
        raise AssertionError("导入孤儿文件不应把整个对象读进内存")

    monkeypatch.setattr(storage, "get", forbidden_get)
    assert await config_api._import_orphan(db, key, storage) is True
    await db.commit()
    row = (await db.execute(select(File).where(File.storage_key == key))).scalars().one()
    assert row.user_id == user_a.id
    assert row.size_bytes == len(b"payload")


async def test_path_migration_rechecks_identity_uniqueness(db, user_a, tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    old_key = f"{user_a.id}/个人文件/old.txt"
    new_key = f"{user_a.id}/个人文件/new.txt"
    await storage.put(new_key, b"same")
    first = File(user_id=user_a.id, display_name="new", ext="txt", storage_key=old_key, size_bytes=4)
    db.add_all([
        first,
        File(user_id=user_a.id, display_name="new", ext="txt", storage_key=f"{user_a.id}/个人文件/other.txt", size_bytes=4),
    ])
    await db.commit()
    await db.refresh(first)
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)

    body = config_api.PathMigrationRequest(items=[
        config_api.PathMigrationItem(file_id=first.id, key=new_key, expected_old_key=old_key),
    ])
    result = await config_api.repair_path_migration(body, db=db)
    assert result["done"] == []
    assert result["failed"][0]["error"] == "路径身份不再唯一，请重新扫描"


async def test_path_migration_reports_missing_file_ids(db, tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)
    body = config_api.PathMigrationRequest(items=[
        config_api.PathMigrationItem(file_id=999999, key="bad", expected_old_key="old"),
    ])

    result = await config_api.repair_path_migration(body, db=db)

    assert result["done"] == []
    assert result["failed"] == [{"file_id": 999999, "error": "文件不存在或已删除"}]
