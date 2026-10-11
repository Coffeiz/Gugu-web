"""文件夹层级变化必须同步物理 key，个人与项目空间共用同一条回归。"""
from pathlib import Path

from app.models import File, Folder, Project
from app.services.storage import LocalStorageBackend
from app.services.storage.folders import relocate_folder_tree_files


async def _save(db, obj):
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


async def _put(storage: LocalStorageBackend, key: str) -> None:
    await storage.put(key, b"test", "text/markdown")


async def test_relocate_folder_tree_files_rebuilds_personal_and_project_keys(db, user_a, tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    monkeypatch.setattr("app.services.storage.folders.get_storage", lambda: storage)

    personal_root = await _save(db, Folder(user_id=user_a.id, name="咕咕开发"))
    personal_prd = await _save(db, Folder(user_id=user_a.id, name="PRD"))
    personal_file = await _save(db, File(
        user_id=user_a.id, display_name="README", ext="md", folder_id=personal_prd.id,
        storage_key=f"{user_a.id}/个人文件/PRD/README.md",
    ))
    await _put(storage, personal_file.storage_key)

    # 同一个个人空间内移动也必须重搬，不能只改 parent_id。
    personal_prd.parent_id = personal_root.id
    await db.flush()
    assert await relocate_folder_tree_files(db, user_a.id, personal_prd.id) == 1
    await db.commit()
    assert personal_file.storage_key.endswith("/个人文件/咕咕开发/PRD/README.md")
    assert await storage.exists(personal_file.storage_key)

    project = await _save(db, Project(user_id=user_a.id, name="项目文件测试"))
    project_folder = await _save(db, Folder(user_id=user_a.id, project_id=project.id, name="需求"))
    project_file = await _save(db, File(
        user_id=user_a.id, display_name="接口", ext="md", space="project", project_id=project.id,
        folder_id=project_folder.id,
        storage_key=f"{user_a.id}/项目文件/old/需求/接口.md",
    ))
    await _put(storage, project_file.storage_key)

    # 项目文件夹改名同样会改变完整 key，必须和个人目录走同一迁移逻辑。
    project_folder.name = "规格"
    await db.flush()
    assert await relocate_folder_tree_files(db, user_a.id, project_folder.id) == 1
    await db.commit()
    assert "/规格/接口.md" in project_file.storage_key
    assert await storage.exists(project_file.storage_key)
