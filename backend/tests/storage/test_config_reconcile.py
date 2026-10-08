from pathlib import Path

from sqlalchemy import select

from app.api.v1 import config as config_api
from app.models import File, Folder, Project
from app.services import storage as storage_module
from app.services.storage import LocalStorageBackend
from app.services.storage import reconciliation


def test_reconcile_skips_runtime_managed_user_namespaces(user_a):
    user_id = str(user_a.id)

    assert config_api._is_internal_key(f"{user_id}/.agent/rag/unified/index.json")
    assert config_api._is_internal_key(f"{user_id}/.agent/rag/memory/index.json")
    assert config_api._is_internal_key(f"{user_id}/.agent/pattern.json")
    assert config_api._is_internal_key(f"{user_id}/shell/plot_test.py")
    assert config_api._is_internal_key(f"{user_id}/shell/shell_recover_test.txt")
    assert config_api._is_internal_key(f"{user_id}/.voice/attachment.ogg")
    assert config_api._is_internal_key(f"{user_id}/.video_cache/transcoded.mp4")
    assert config_api._is_internal_key(f"{user_id}/.data-portability/imports/job.gupi")
    assert config_api._is_internal_key(f"{user_id}/workspace/default/.git/objects/data")
    assert config_api._is_internal_key(f"u/{user_id}/.system/rag/index.json")
    assert config_api._is_internal_key(f"u/{user_id}/shell/terminal.txt")
    assert config_api._is_internal_key("_analytics/runtime.md")


def test_reconcile_does_not_skip_same_names_in_regular_user_directory(user_a):
    user_id = str(user_a.id)

    assert not config_api._is_internal_key(f"{user_id}/个人文件/shell/note.txt")
    assert not config_api._is_internal_key(f"{user_id}/个人文件/.system/note.txt")
    assert not config_api._is_internal_key(f"{user_id}/个人文件/.data-portability/note.txt")
    assert not config_api._is_internal_key(f"{user_id}/个人文件/workspace/note.txt")


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
    assert await reconciliation.import_orphan_file(db, key, storage) == (
        False, "所属项目不存在或不属于文件所有者",
    )


async def test_import_orphan_restores_missing_project_from_original_path(
    db, user_a, tmp_path,
):
    storage = LocalStorageBackend(Path(tmp_path))
    project_id = 987654
    key = f"{user_a.id}/项目文件/2026/10/已丢失项目 #{project_id}/目录/文件.md"
    await storage.put(key, b"orphan content")

    assert reconciliation.parse_path_migration_key(key)["project_name"] == "已丢失项目"
    assert reconciliation.parse_path_migration_key(key)["project_start_date"] == "2026-10-01"
    assert await reconciliation.import_orphan_file(db, key, storage) == (True, None)
    await db.commit()

    project = await db.get(Project, project_id)
    assert project is not None
    assert project.user_id == user_a.id
    assert project.name == "已丢失项目"
    assert project.start_date == "2026-10-01"
    row = (await db.execute(select(File).where(File.storage_key == key))).scalars().one()
    assert row.project_id == project_id
    folder = await db.get(Folder, row.folder_id)
    assert folder is not None
    assert folder.name == "目录"


async def test_import_orphan_reuses_recovered_project_for_sibling_files(db, user_a, tmp_path):
    storage = LocalStorageBackend(Path(tmp_path))
    project_id = 987655
    keys = [
        f"{user_a.id}/项目文件/2026/10/待恢复项目 #{project_id}/说明-{index}.md"
        for index in range(2)
    ]
    for key in keys:
        await storage.put(key, b"orphan content")
        assert await reconciliation.import_orphan_file(db, key, storage) == (True, None)
    await db.commit()

    projects = (await db.execute(select(Project).where(Project.id == project_id))).scalars().all()
    assert len(projects) == 1
    rows = (await db.execute(select(File).where(File.storage_key.in_(keys)))).scalars().all()
    assert len(rows) == 2
    assert {row.project_id for row in rows} == {project_id}


async def test_import_orphan_rolls_back_project_when_path_folder_is_invalid(db, user_a, tmp_path):
    storage = LocalStorageBackend(Path(tmp_path))
    project_id = 987656
    key = (
        f"{user_a.id}/项目文件/2026/10/不可留下空项目 #{project_id}/"
        # 使用单字节合成目录，超过业务 200 字符上限但不超过文件系统单段字节限制。
        f"{'x' * 201}/文件.md"
    )
    await storage.put(key, b"orphan content")

    assert await reconciliation.import_orphan_file(db, key, storage) == (
        False, "目录路径无效，或对应目录已删除",
    )
    await db.commit()

    assert await db.get(Project, project_id) is None
    assert (await db.execute(select(File).where(File.storage_key == key))).scalars().first() is None


async def test_import_orphan_creates_owned_file_with_stat_size(db, user_a, tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    key = f"{user_a.id}/个人文件/orphan.txt"
    await storage.put(key, b"payload")

    async def forbidden_get(_key):
        raise AssertionError("导入孤儿文件不应把整个对象读进内存")

    monkeypatch.setattr(storage, "get", forbidden_get)
    assert await reconciliation.import_orphan_file(db, key, storage) == (True, None)
    await db.commit()
    row = (await db.execute(select(File).where(File.storage_key == key))).scalars().one()
    assert row.user_id == user_a.id
    assert row.size_bytes == len(b"payload")


async def test_import_orphan_recreates_missing_nested_project_folders(
    db, user_a, tmp_path, monkeypatch,
):
    storage = LocalStorageBackend(Path(tmp_path))
    project = Project(user_id=user_a.id, name="合成企划", start_date="2026-10-01")
    db.add(project)
    await db.commit()
    await db.refresh(project)
    key = (
        f"{user_a.id}/项目文件/2026/10/合成企划 #{project.id}/"
        "00-原始大纲/01-核心定位/说明.md"
    )
    await storage.put(key, b"orphan content")
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)

    assert await reconciliation.import_orphan_file(db, key, storage) == (True, None)
    await db.commit()

    folders = (await db.execute(
        select(Folder).where(Folder.project_id == project.id)
    )).scalars().all()
    by_name = {folder.name: folder for folder in folders}
    assert set(by_name) == {"00-原始大纲", "01-核心定位"}
    assert by_name["00-原始大纲"].parent_id is None
    assert by_name["01-核心定位"].parent_id == by_name["00-原始大纲"].id

    row = (await db.execute(select(File).where(File.storage_key == key))).scalars().one()
    assert row.project_id == project.id
    assert row.folder_id == by_name["01-核心定位"].id


async def test_import_orphan_does_not_recreate_a_soft_deleted_folder(
    db, user_a, tmp_path, monkeypatch,
):
    from app.core.tz import now_utc

    storage = LocalStorageBackend(Path(tmp_path))
    project = Project(user_id=user_a.id, name="已删除目录测试", start_date="2026-10-01")
    db.add(project)
    await db.flush()
    deleted_folder = Folder(
        user_id=user_a.id, project_id=project.id, name="已删除目录", deleted_at=now_utc(),
    )
    db.add(deleted_folder)
    await db.commit()
    await db.refresh(project)
    key = f"{user_a.id}/项目文件/2026/10/已删除目录测试 #{project.id}/已删除目录/文件.md"
    await storage.put(key, b"orphan content")
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)

    assert await reconciliation.import_orphan_file(db, key, storage) == (
        False, "目录路径无效，或对应目录已删除",
    )
    await db.commit()

    assert (await db.execute(select(File).where(File.storage_key == key))).scalars().first() is None
    active_folders = (await db.execute(select(Folder).where(
        Folder.project_id == project.id, Folder.deleted_at.is_(None),
    ))).scalars().all()
    assert active_folders == []


async def test_import_orphan_rejects_soft_deleted_project(db, user_a, tmp_path):
    from app.core.tz import now_utc

    storage = LocalStorageBackend(Path(tmp_path))
    project = Project(
        user_id=user_a.id, name="回收站项目", start_date="2026-10-01", deleted_at=now_utc(),
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    key = f"{user_a.id}/项目文件/2026/10/回收站项目 #{project.id}/文件.md"
    await storage.put(key, b"orphan content")

    assert await reconciliation.import_orphan_file(db, key, storage) == (
        False, "所属项目在回收站中，请先恢复项目后重试",
    )


async def test_ghost_cleanup_rechecks_storage_and_removes_only_missing_library_rows(
    db, user_a, tmp_path, monkeypatch,
):
    storage = LocalStorageBackend(Path(tmp_path))
    missing = File(
        user_id=user_a.id, display_name="missing", ext="png", space="personal",
        storage_key=f"{user_a.id}/个人文件/missing.png",
    )
    restored = File(
        user_id=user_a.id, display_name="restored", ext="png", space="personal",
        storage_key=f"{user_a.id}/个人文件/restored.png",
    )
    runtime = File(
        user_id=user_a.id, display_name="runtime", ext="pak", space="workspace",
        storage_key=f"{user_a.id}/workspace/default/.cache/runtime.pak",
    )
    db.add_all([missing, restored, runtime])
    await storage.put(restored.storage_key, b"restored")
    await db.commit()
    await db.refresh(missing)
    await db.refresh(restored)
    await db.refresh(runtime)
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)
    published = []

    async def publish(*args, **kwargs):
        published.append((args, kwargs))

    monkeypatch.setattr("app.core.events.publish", publish)
    result = await config_api.repair_ghost_records(
        config_api.GhostRepairRequest(
            file_ids=[missing.id, restored.id, runtime.id], confirm=True,
        ),
        db=db,
    )

    assert result["done"] == [missing.id]
    assert result["failed"] == [
        {"file_id": restored.id, "error": "物理文件已存在，请重新扫描"},
        {"file_id": runtime.id, "error": "该路径不属于 File 文件库对账范围"},
    ]
    assert await db.get(File, missing.id) is None
    assert await db.get(File, restored.id) is not None
    assert await db.get(File, runtime.id) is not None
    assert published[0][1]["file_op"] == {"op": "remove", "kind": "file", "ids": [missing.id]}


async def test_ghost_cleanup_does_not_delete_rows_when_storage_cannot_be_verified(
    db, user_a, monkeypatch,
):
    file = File(
        user_id=user_a.id, display_name="uncertain", ext="png", space="personal",
        storage_key=f"{user_a.id}/个人文件/uncertain.png",
    )
    db.add(file)
    await db.commit()
    await db.refresh(file)

    class UnverifiableStorage:
        async def stat(self, _key):
            raise PermissionError("permission details")

    monkeypatch.setattr(storage_module, "get_storage", lambda: UnverifiableStorage())
    result = await config_api.repair_ghost_records(
        config_api.GhostRepairRequest(file_ids=[file.id], confirm=True), db=db,
    )

    assert result["done"] == []
    assert result["failed"] == [{
        "file_id": file.id,
        "error": "权限不足；未更改记录，请检查存储目录权限后重试",
    }]
    assert await db.get(File, file.id) is not None


async def test_storage_audit_returns_complete_ghost_ids_and_excludes_workspace_rows(
    db, user_a, tmp_path, monkeypatch,
):
    from types import SimpleNamespace

    from app.services.storage import folder_doctor

    rows = [
        File(
            user_id=user_a.id, display_name=f"missing-{index}", ext="txt",
            space="personal", storage_key=f"{user_a.id}/个人文件/missing-{index}.txt",
        )
        for index in range(301)
    ]
    runtime = File(
        user_id=user_a.id, display_name="runtime", ext="pak", space="workspace",
        storage_key=f"{user_a.id}/workspace/default/.cache/runtime.pak",
    )
    db.add_all([*rows, runtime])
    await db.commit()
    for row in rows:
        await db.refresh(row)
    await db.refresh(runtime)
    storage = LocalStorageBackend(Path(tmp_path))
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)
    monkeypatch.setattr(config_api, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(backend="local", local_path="test-storage"),
    ))

    async def unexpected_directory_scan(*_args):
        raise AssertionError("文件对账不应重复执行目录扫描")

    monkeypatch.setattr(folder_doctor, "scan", unexpected_directory_scan)
    report = await config_api.reconcile_storage(db=db)

    assert report["ghost_count"] == 301
    assert report["db_file_rows"] == 301
    assert len(report["ghosts"]) == 300
    assert len(report["ghost_ids"]) == 301
    assert set(report["ghost_ids"]) == {row.id for row in rows}
    assert runtime.id not in report["ghost_ids"]
    assert report["truncated"] is True
    assert "misplaced_count" not in report
    assert "misplaced_files" not in report


async def test_local_storage_stat_propagates_permission_error_instead_of_reporting_missing(
    tmp_path, monkeypatch,
):
    storage = LocalStorageBackend(Path(tmp_path))
    target = storage.root / "locked/file.txt"
    original_stat = Path.stat

    def stat_with_denial(path, *args, **kwargs):
        if path == target:
            raise PermissionError("permission details")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat_with_denial)

    import pytest

    with pytest.raises(PermissionError):
        await storage.stat("locked/file.txt")


async def test_storage_reconcile_prunes_private_workspace_before_walking(
    db, user_a, tmp_path, monkeypatch,
):
    from types import SimpleNamespace

    storage = LocalStorageBackend(Path(tmp_path))
    ordinary_key = f"{user_a.id}/个人文件/note.txt"
    await storage.put(ordinary_key, b"file library object")
    private_dir = storage.root / str(user_a.id) / "workspace" / "default" / ".local"
    private_dir.mkdir(parents=True)
    (private_dir / "runtime-cache").write_text("not a file-library object")

    original_walk = storage_module.os.walk
    visited = []

    def track_walk(*args, **kwargs):
        for directory, dirnames, filenames in original_walk(*args, **kwargs):
            current = Path(directory)
            visited.append(current)
            if current == private_dir:
                raise AssertionError("文件对账遍历了已排除的 workspace 私有目录")
            yield directory, dirnames, filenames

    monkeypatch.setattr(storage_module.os, "walk", track_walk)
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)
    monkeypatch.setattr(config_api, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(backend="local", local_path="test-storage"),
    ))

    report = await config_api.reconcile_storage(db=db)

    assert report["storage_objects"] == 1
    assert report["orphans"] == [ordinary_key]
    assert private_dir not in visited


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


async def test_path_migration_scan_prunes_private_workspace_before_walking(
    db, user_a, tmp_path, monkeypatch,
):
    storage = LocalStorageBackend(Path(tmp_path))
    private_dir = storage.root / str(user_a.id) / "workspace" / "default" / ".local"
    private_dir.mkdir(parents=True)
    (private_dir / "runtime-cache").write_text("not a file-library object")

    original_walk = storage_module.os.walk
    visited = []

    def track_walk(*args, **kwargs):
        for directory, dirnames, filenames in original_walk(*args, **kwargs):
            current = Path(directory)
            visited.append(current)
            if current == private_dir:
                raise AssertionError("路径归属扫描遍历了已排除的 workspace 私有目录")
            yield directory, dirnames, filenames

    monkeypatch.setattr(storage_module.os, "walk", track_walk)
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)

    report = await config_api.scan_path_migration(db=db)

    assert report["candidate_count"] == 0
    assert report["ambiguous_count"] == 0
    assert private_dir not in visited


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
