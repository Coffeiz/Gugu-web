from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import select

from app.api.v1 import config as config_api
from app.models import File, FileSyncBinding, FileSyncJournal, Project
from app.services import storage as storage_module
from app.services.storage import LocalStorageBackend


def test_reconcile_skips_runtime_managed_user_namespaces(user_a):
    user_id = str(user_a.id)

    assert config_api._is_internal_key(f"{user_id}/.agent/rag/unified/index.json")
    assert config_api._is_internal_key(f"{user_id}/.agent/rag/memory/index.json")
    assert config_api._is_internal_key(f"{user_id}/.agent/pattern.json")
    assert config_api._is_internal_key(f"{user_id}/shell/plot_test.py")
    assert config_api._is_internal_key(f"{user_id}/shell/shell_recover_test.txt")
    assert config_api._is_internal_key(f"{user_id}/.voice/attachment.ogg")
    assert config_api._is_internal_key(f"{user_id}/.video_cache/transcoded.mp4")
    assert config_api._is_internal_key(f"u/{user_id}/.system/rag/index.json")
    assert config_api._is_internal_key(f"u/{user_id}/shell/terminal.txt")


def test_reconcile_does_not_skip_same_names_in_regular_user_directory(user_a):
    user_id = str(user_a.id)

    assert not config_api._is_internal_key(f"{user_id}/个人文件/shell/note.txt")
    assert not config_api._is_internal_key(f"{user_id}/个人文件/.system/note.txt")


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


async def test_import_orphan_creates_owned_file_and_advances_binding_watermark(
    db, user_a, tmp_path, monkeypatch,
):
    storage = LocalStorageBackend(Path(tmp_path))
    key = f"{user_a.id}/个人文件/orphan.txt"
    await storage.put(key, b"payload")
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        status="active", root_path=".", root_fingerprint="c" * 64,
    )
    db.add(binding)
    await db.flush()
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr("app.services.filesync.bindings.get_settings", lambda: settings)
    monkeypatch.setattr("app.services.filesync.protocol.get_settings", lambda: settings)
    monkeypatch.setattr("app.services.filesync.protocol.is_file_sync_enabled", lambda: True)

    async def forbidden_get(_key):
        raise AssertionError("导入孤儿文件不应把整个对象读进内存")

    monkeypatch.setattr(storage, "get", forbidden_get)
    assert await config_api._import_orphan(db, key, storage) is True
    await db.commit()
    row = (await db.execute(select(File).where(File.storage_key == key))).scalars().one()
    assert row.user_id == user_a.id
    assert row.size_bytes == len(b"payload")
    journal = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
    ))).one()
    assert (journal.relative_path, journal.operation, journal.status) == (
        "个人文件/orphan.txt", "create", "synced",
    )
    await db.refresh(binding)
    assert binding.dirty_revision == 1


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


async def test_path_migration_repair_advances_old_and_new_binding_paths(
    db, user_a, tmp_path, monkeypatch,
):
    storage = LocalStorageBackend(Path(tmp_path))
    old_key = f"{user_a.id}/个人文件/old.txt"
    new_key = f"{user_a.id}/个人文件/new.txt"
    await storage.put(new_key, b"same")
    file = File(
        user_id=user_a.id, display_name="new", ext="txt", space="personal",
        storage_key=old_key, size_bytes=4,
    )
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        status="active", root_path=".", root_fingerprint="b" * 64,
    )
    db.add_all([file, binding])
    await db.commit()
    await db.refresh(file)
    await db.refresh(binding)
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr("app.services.filesync.bindings.get_settings", lambda: settings)
    monkeypatch.setattr("app.services.filesync.protocol.get_settings", lambda: settings)
    monkeypatch.setattr("app.services.filesync.protocol.is_file_sync_enabled", lambda: True)

    body = config_api.PathMigrationRequest(items=[
        config_api.PathMigrationItem(file_id=file.id, key=new_key, expected_old_key=old_key),
    ])
    result = await config_api.repair_path_migration(body, db=db)

    assert result == {"done": [file.id], "failed": []}
    changes = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
    ).order_by(FileSyncJournal.id))).all()
    assert [(row.relative_path, row.operation) for row in changes] == [
        ("个人文件/old.txt", "delete"),
        ("个人文件/new.txt", "create"),
    ]
    await db.refresh(binding)
    assert binding.dirty_revision == 2


async def test_path_migration_reports_missing_file_ids(db, tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)
    body = config_api.PathMigrationRequest(items=[
        config_api.PathMigrationItem(file_id=999999, key="bad", expected_old_key="old"),
    ])

    result = await config_api.repair_path_migration(body, db=db)

    assert result["done"] == []
    assert result["failed"] == [{"file_id": 999999, "error": "文件不存在或已删除"}]


async def test_reconcile_users_only_reports_users_without_local_directory(db, user_a, user_b, tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    (storage.root / str(user_b.id)).mkdir(parents=True)
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)

    result = await config_api.reconcile_users(db=db)

    assert result["backend"] == "local"
    assert result["missing_directory_count"] == 1
    assert result["users"][0]["user_id"] == str(user_a.id)


async def test_reconcile_users_accepts_legacy_onboarding_directory(db, user_a, tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    (storage.root / "u" / str(user_a.id)).mkdir(parents=True)
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)

    result = await config_api.reconcile_users(db=db)

    assert result["missing_directory_count"] == 0
