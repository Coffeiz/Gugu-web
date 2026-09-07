"""顶层 Workspace 文件空间元数据契约测试。"""

from sqlalchemy import inspect
import pytest

from app.models import WorkspaceDirectory
from app.services.workspaces import (
    create_workspace_directory,
    delete_workspace_directory,
    list_workspace_directories,
    update_workspace_directory,
    scan_legacy_shell_directories,
)


def test_workspace_directory_model_contract():
    mapper = inspect(WorkspaceDirectory)
    columns = mapper.columns

    assert WorkspaceDirectory.__tablename__ == "workspace_directories"
    assert {"id", "user_id", "name", "directory_name", "is_default", "is_system", "deleted_at"} <= {
        column.key for column in columns
    }
    assert any(
        index.name == "uq_workspace_directory_name"
        and index.unique
        and {column.name for column in index.columns} == {"user_id", "directory_name"}
        for index in WorkspaceDirectory.__table__.indexes
    )


def test_workspace_directory_default_is_system_protection_is_explicit():
    columns = {column.name: column for column in WorkspaceDirectory.__table__.columns}

    assert columns["is_default"].nullable is False
    assert columns["is_system"].nullable is False
    assert columns["is_default"].default.arg is False
    assert columns["is_system"].default.arg is False


@pytest.mark.asyncio
async def test_workspace_directory_crud_is_owned_and_removes_only_its_physical_root(db, user_a, user_b, tmp_path, monkeypatch):
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    monkeypatch.setattr(settings.storage, "local_path", str(tmp_path))

    row = await create_workspace_directory(db, user_a.id, name="数据分析")
    await db.commit()
    root = tmp_path / str(user_a.id) / "数据分析"
    assert root.is_dir()
    listed = await list_workspace_directories(db, user_a.id)
    assert [item.id for item in listed if item.id == row.id] == [row.id]
    assert [item.name for item in await list_workspace_directories(db, user_b.id)] == ["默认工作区"]

    await update_workspace_directory(db, user_a.id, row.id, name="数据分析 v2")
    await db.commit()
    assert not root.exists()
    assert (tmp_path / str(user_a.id) / "数据分析 v2").is_dir()

    with pytest.raises(LookupError):
        await update_workspace_directory(db, user_b.id, row.id, name="越权")

    await delete_workspace_directory(db, user_a.id, row.id)
    await db.commit()
    assert not (tmp_path / str(user_a.id) / "数据分析 v2").exists()
    assert [item.name for item in await list_workspace_directories(db, user_a.id)] == ["默认工作区"]

    recreated = await create_workspace_directory(db, user_a.id, name="数据分析")
    await db.commit()
    assert recreated.id != row.id
    assert (tmp_path / str(user_a.id) / "数据分析").is_dir()


@pytest.mark.asyncio
async def test_legacy_shell_scan_is_idempotent_and_reports_readable_source(db, user_a, tmp_path, monkeypatch):
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    monkeypatch.setattr(settings.storage, "local_path", str(tmp_path))
    source = tmp_path / str(user_a.id) / "shell"
    source.mkdir(parents=True)
    (source / "old.txt").write_text("legacy", encoding="utf-8")

    first = await scan_legacy_shell_directories(db, user_a.id)
    await db.commit()
    second = await scan_legacy_shell_directories(db, user_a.id)
    await db.commit()

    assert first[0].status == "ready"
    assert first[0].source_file_count == 1
    assert second[0].id == first[0].id
    assert source.exists()
