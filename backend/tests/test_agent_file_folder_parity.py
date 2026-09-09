"""P3.2 Agent 文件夹工具与 FileService 的最小对称回归。"""
from pathlib import Path

from app.core.tz import now_utc
from app.services.storage import LocalStorageBackend
from app.services.storage.file_service import FileService
from app.services.storage.trash import move_file_to_trash
from app.models import Folder, WorkspaceDirectory


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


async def test_list_folders_does_not_inherit_bound_workspace_directory(db, user_a, monkeypatch):
    personal = Folder(user_id=user_a.id, name="个人影视")
    workspace = await _mk_workspace_folder(db, user_a.id)
    db.add(personal)
    await db.commit()
    await db.refresh(personal)

    import agent.tools.files.folders as folder_tools

    async def bound_workspace(*_args, **_kwargs):
        return {
            "space": "workspace",
            "project_id": None,
            "folder_id": None,
            "workspace_directory_id": workspace.workspace_directory_id,
        }

    monkeypatch.setattr(folder_tools, "_bound_workspace_target", bound_workspace)

    rows = await folder_tools._list_folders(db, user_a.id, {})

    assert {item["id"] for item in rows} == {personal.id, workspace.id}


async def _mk_workspace_folder(db, user_id):
    workspace_directory = WorkspaceDirectory(
        user_id=user_id, name="F1 工作区", directory_name="f1-folders",
    )
    db.add(workspace_directory)
    await db.commit()
    await db.refresh(workspace_directory)
    folder = Folder(
        user_id=user_id,
        name="工作区目录",
        workspace_directory_id=workspace_directory.id,
    )
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    return folder


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
    old_version = file.version

    edited = await agent_files._edit_file(
        db, user_a.id,
        {"file_id": file.id, "mode": "line_edit", "line_edits": [{"target_lines": "all", "content": "新内容"}]},
    )

    assert edited["success"] is True
    assert await storage.get(file.storage_key) == "新内容".encode()
    await db.refresh(file)
    assert file.size_bytes == len("新内容".encode())
    assert file.version == old_version + 1


async def test_agent_create_file_supports_batch_custom_extensions_and_partial_results(db, user_a, tmp_path, monkeypatch):
    agent_files, storage = await _wire_agent_storage(monkeypatch, tmp_path)

    result = await agent_files._create_file(db, user_a.id, {
        "files": [
            {"name": "script.py", "content": "print('ok')"},
            {"name": "panel.custom", "content": "自定义文本"},
            {"name": "无后缀", "content": "这一项应失败"},
        ],
    })

    assert result["success"] is True
    assert result["created_count"] == 2
    assert result["failed_count"] == 1
    created_names = {item["name"] for item in result["created"]}
    assert created_names == {"script.py", "panel.custom"}
    assert {item["ext"] for item in await agent_files._list_files(db, user_a.id, {})} >= {"py", "custom"}
    custom = next(item for item in result["created"] if item["name"] == "panel.custom")
    custom_file = await agent_files._resolve_file(db, user_a.id, {"file_id": custom["file_id"]})
    assert await storage.get(custom_file[0].storage_key) == "自定义文本".encode()

    edited = await agent_files._edit_file(db, user_a.id, {
        "file_id": custom["file_id"], "mode": "replace", "content": "已编辑",
    })
    assert edited["success"] is True
    read_back = await agent_files._read_file(db, user_a.id, {"file_id": custom["file_id"]})
    assert read_back["content"] == "已编辑"


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
