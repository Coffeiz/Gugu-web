"""P3.2 Agent 文件夹工具与 FileService 的最小对称回归。"""
from pathlib import Path

from app.core.tz import now_utc
from app.services.storage import LocalStorageBackend
from app.services.storage.file_service import FileService
from app.services.storage.trash import move_file_to_trash


async def _wire_agent_storage(monkeypatch, root: Path):
    storage = LocalStorageBackend(root)
    monkeypatch.setattr("app.services.storage.file_service.get_storage", lambda: storage)
    monkeypatch.setattr("app.services.storage.folders.get_storage", lambda: storage)
    import agent.tools.files as agent_files
    monkeypatch.setattr(agent_files, "get_storage", lambda: storage)
    return agent_files, storage


async def test_agent_folder_create_rename_delete_matches_service(db, user_a, tmp_path, monkeypatch):
    agent_files, storage = await _wire_agent_storage(monkeypatch, tmp_path)

    created = await agent_files._create_folder(db, user_a.id, {"name": "资料"})
    assert created["success"] is True
    folder_id = created["folder_id"]
    assert (storage.root / f"{user_a.id}/个人文件/资料").is_dir()

    renamed = await agent_files._rename_folder(
        db, user_a.id, {"folder_id": folder_id, "new_name": "归档"}
    )
    assert renamed["success"] is True
    assert (storage.root / f"{user_a.id}/个人文件/归档").is_dir()
    assert not (storage.root / f"{user_a.id}/个人文件/资料").exists()

    deleted = await agent_files._delete_folder(db, user_a.id, {"folder_id": folder_id})
    assert deleted["success"] is True
    assert await FileService(db, storage=storage).folder_tree.get(user_a.id, folder_id) is None

    visible = await agent_files._list_folders(db, user_a.id, {})
    assert folder_id not in {item["id"] for item in visible}

    import agent.tools.trash as agent_trash
    trash = await agent_trash._list_trash(db, user_a.id, {})
    assert isinstance(trash, list)
    assert {item["folder_id"] for item in trash if item["kind"] == "folder"} == {folder_id}


async def test_agent_folder_move_uses_service_physical_relocation(db, user_a, tmp_path, monkeypatch):
    agent_files, storage = await _wire_agent_storage(monkeypatch, tmp_path)
    service = FileService(db, storage=storage)
    source = await service.create_folder(user_a.id, name="来源", parent_id=None, project_id=None)
    target = await service.create_folder(user_a.id, name="目标", parent_id=None, project_id=None)
    await db.commit()
    moved = await agent_files._move_folder(db, user_a.id, source, "personal", None, target.id)
    assert moved["success"] is True
    await db.refresh(source)
    assert source.parent_id == target.id
    assert (storage.root / f"{user_a.id}/个人文件/目标/来源").is_dir()


async def test_agent_restore_file_matches_file_service(db, user_a, tmp_path, monkeypatch):
    _, storage = await _wire_agent_storage(monkeypatch, tmp_path)
    import agent.tools.trash as agent_trash
    monkeypatch.setattr(agent_trash, "get_storage", lambda: storage)

    service = FileService(db, storage=storage)
    folder = await service.create_folder(user_a.id, name="回收测试", parent_id=None, project_id=None)
    await db.commit()
    result = await service.create_file(
        user_a.id,
        space="personal",
        project_id=None,
        folder_id=folder.id,
        stage_name="",
        mind_map_id=None,
        display_name="恢复对象",
        ext="TXT",
        mime_type="text/plain",
        data=b"restore-body",
    )
    file = result.file
    original_key = file.storage_key
    await db.commit()

    await move_file_to_trash(storage, file)
    file.deleted_at = now_utc()
    await db.commit()
    await db.refresh(file)
    assert file.deleted_at is not None
    assert file.storage_key != original_key

    restored = await agent_trash._restore_file(db, user_a.id, {"file_id": file.id})
    assert restored["success"] is True
    await db.refresh(file)
    assert file.deleted_at is None
    assert file.storage_key == original_key
    assert await storage.get(original_key) == b"restore-body"
    assert (storage.root / f"{user_a.id}/个人文件/回收测试").is_dir()


async def test_agent_restore_folder_matches_file_service(db, user_a, tmp_path, monkeypatch):
    _, storage = await _wire_agent_storage(monkeypatch, tmp_path)
    import agent.tools.trash as agent_trash
    monkeypatch.setattr(agent_trash, "get_storage", lambda: storage)

    service = FileService(db, storage=storage)
    folder = await service.create_folder(user_a.id, name="目录恢复", parent_id=None, project_id=None)
    await db.commit()
    result = await service.create_file(
        user_a.id,
        space="personal",
        project_id=None,
        folder_id=folder.id,
        stage_name="",
        mind_map_id=None,
        display_name="目录内文件",
        ext="TXT",
        mime_type="text/plain",
        data=b"folder-body",
    )
    file = result.file
    original_key = file.storage_key
    await db.commit()

    await service.delete_folder(user_a.id, folder.id)
    await db.commit()
    await db.refresh(folder)
    await db.refresh(file)
    assert folder.deleted_at is not None
    assert file.deleted_at is not None

    restored = await agent_trash._restore_folder(db, user_a.id, {"folder_id": folder.id})
    assert restored == {"success": True, "folder_id": folder.id, "name": "目录恢复"}
    await db.refresh(folder)
    await db.refresh(file)
    assert folder.deleted_at is None
    assert file.deleted_at is None
    assert file.storage_key == original_key
    assert await storage.get(original_key) == b"folder-body"
    assert (storage.root / f"{user_a.id}/个人文件/目录恢复").is_dir()


async def test_agent_edit_file_updates_content_and_metadata(db, user_a, tmp_path, monkeypatch):
    agent_files, storage = await _wire_agent_storage(monkeypatch, tmp_path)
    service = FileService(db, storage=storage)
    result = await service.create_file(
        user_a.id,
        space="personal",
        project_id=None,
        folder_id=None,
        stage_name="",
        mind_map_id=None,
        display_name="编辑测试",
        ext="md",
        mime_type="text/markdown",
        data="旧内容".encode(),
    )
    file = result.file
    await db.commit()

    edited = await agent_files._edit_file(
        db, user_a.id,
        {"file_id": file.id, "mode": "line_edit", "line_edits": [{"target_lines": "all", "content": "新内容"}]},
    )

    assert edited["success"] is True
    assert await storage.get(file.storage_key) == "新内容".encode()
    await db.refresh(file)
    assert file.size_bytes == len("新内容".encode())


async def test_agent_delete_file_moves_file_to_trash(db, user_a, tmp_path, monkeypatch):
    agent_files, storage = await _wire_agent_storage(monkeypatch, tmp_path)
    service = FileService(db, storage=storage)
    result = await service.create_file(
        user_a.id,
        space="personal",
        project_id=None,
        folder_id=None,
        stage_name="",
        mind_map_id=None,
        display_name="删除测试",
        ext="txt",
        mime_type="text/plain",
        data=b"trash me",
    )
    file = result.file
    original_key = file.storage_key
    await db.commit()

    deleted = await agent_files._delete_file(db, user_a.id, {"file_id": file.id})

    assert deleted["success"] is True
    await db.refresh(file)
    assert file.deleted_at is not None
    assert file.storage_key != original_key
