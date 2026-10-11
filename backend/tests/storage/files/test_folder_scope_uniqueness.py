import importlib.util
from pathlib import Path

import pytest
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.core.errors import Conflict
from app.models import File, Folder, Project, Workspace
from app.services.storage.folder_tree import SqlAlchemyFolderTree


def _load_folder_scope_migration():
    migration_path = (
        Path(__file__).parents[3]
        / "alembic"
        / "versions"
        / "20261001000002_unique_active_folder_scope.py"
    )
    spec = importlib.util.spec_from_file_location("folder_scope_migration", migration_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.mark.asyncio
async def test_folder_migration_merges_legacy_duplicate_trees_and_keeps_references(db, user_a):
    """历史重复目录合并时保留文件、子目录和 Workspace 的有效归属。"""
    await db.execute(text("DROP INDEX uq_folders_active_scope_name"))

    project = Project(user_id=user_a.id, name="迁移测试项目")
    db.add(project)
    await db.flush()

    root_a = Folder(user_id=user_a.id, project_id=project.id, name="重复目录")
    root_b = Folder(user_id=user_a.id, project_id=project.id, name="重复目录")
    db.add_all([root_a, root_b])
    await db.flush()

    child_a = Folder(
        user_id=user_a.id, project_id=project.id, parent_id=root_a.id, name="相同子目录",
    )
    child_b = Folder(
        user_id=user_a.id, project_id=project.id, parent_id=root_b.id, name="相同子目录",
    )
    db.add_all([child_a, child_b])
    await db.flush()

    file = File(
        user_id=user_a.id, display_name="保留文件", ext="txt", space="project",
        project_id=project.id, folder_id=child_b.id,
        storage_key=f"{user_a.id}/projects/{project.id}/保留文件.txt",
        size="1", size_bytes=1,
    )
    workspace = Workspace(
        user_id=user_a.id, name="目录工作区", kind="folder", folder_id=root_b.id,
    )
    db.add_all([file, workspace])
    await db.flush()

    migration = _load_folder_scope_migration()

    def apply_migration(session):
        connection = session.connection()
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()

    await db.run_sync(apply_migration)

    active_roots = (await db.scalars(select(Folder).where(
        Folder.user_id == user_a.id,
        Folder.project_id == project.id,
        Folder.parent_id.is_(None),
        Folder.name == "重复目录",
        Folder.deleted_at.is_(None),
    ))).all()
    active_children = (await db.scalars(select(Folder).where(
        Folder.user_id == user_a.id,
        Folder.parent_id == root_a.id,
        Folder.name == "相同子目录",
        Folder.deleted_at.is_(None),
    ))).all()
    await db.refresh(file)
    await db.refresh(workspace)
    await db.refresh(root_b)
    await db.refresh(child_b)

    assert [folder.id for folder in active_roots] == [root_a.id]
    assert [folder.id for folder in active_children] == [child_a.id]
    assert file.folder_id == child_a.id
    assert workspace.folder_id == root_a.id
    assert root_b.deleted_at is not None
    assert child_b.deleted_at is not None

    db.add(Folder(user_id=user_a.id, project_id=project.id, name="重复目录"))
    with pytest.raises(IntegrityError):
        await db.flush()
    await db.rollback()


@pytest.mark.asyncio
async def test_folder_rename_and_move_reject_active_sibling_name_conflicts(db, user_a):
    tree = SqlAlchemyFolderTree(db)
    source = await tree.create(
        user_a.id, name="源目录", parent_id=None, project_id=None,
    )
    await tree.create(user_a.id, name="目标名", parent_id=None, project_id=None)
    target_parent = await tree.create(
        user_a.id, name="目标父目录", parent_id=None, project_id=None,
    )
    await tree.create(
        user_a.id, name="源目录", parent_id=target_parent.id, project_id=None,
    )
    await db.commit()

    with pytest.raises(Conflict, match="同名文件夹"):
        await tree.rename(user_a.id, source.id, "目标名", client_version=source.version)
    with pytest.raises(Conflict, match="同名文件夹"):
        await tree.move(user_a.id, source.id, target_parent.id, client_version=source.version)

    await db.refresh(source)
    assert source.name == "源目录"
    assert source.parent_id is None
