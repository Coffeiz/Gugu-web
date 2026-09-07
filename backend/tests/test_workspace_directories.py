"""顶层 Workspace 文件空间元数据契约测试。"""

from sqlalchemy import inspect
import pytest

from app.models import WorkspaceDirectory
from app.services.workspaces import (
    create_workspace_directory,
    delete_workspace_directory,
    ensure_default_workspace_directory,
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
    await ensure_default_workspace_directory(db, user_b.id)

    row = await create_workspace_directory(db, user_a.id, name="数据分析")
    await db.commit()
    # 物理目录是不可变的 workspace-<id>：File.storage_key 永久引用它，
    # 显示名只活在 WorkspaceDirectory.name，rename 不能再动磁盘路径。
    root = tmp_path / str(user_a.id) / f"workspace-{row.id}"
    assert root.is_dir()
    listed = await list_workspace_directories(db, user_a.id)
    assert [item.id for item in listed if item.id == row.id] == [row.id]
    assert [item.name for item in await list_workspace_directories(db, user_b.id)] == ["默认工作区"]

    await update_workspace_directory(db, user_a.id, row.id, name="数据分析 v2")
    await db.commit()
    # rename 只改显示名：物理目录原地不动，storage_key 继续有效。
    assert row.directory_name == f"workspace-{row.id}"
    assert root.is_dir()
    assert not (tmp_path / str(user_a.id) / "数据分析 v2").exists()

    with pytest.raises(LookupError):
        await update_workspace_directory(db, user_b.id, row.id, name="越权")

    terminal_ids, tombstone = await delete_workspace_directory(db, user_a.id, row.id)
    await db.commit()
    assert terminal_ids == []
    # service 只把物理目录改名成墓碑，真正 rmtree 由 API 在 DB commit 之后执行。
    assert not root.exists()
    assert tombstone is not None and tombstone.exists()
    import shutil
    shutil.rmtree(tombstone)
    assert [item.name for item in await list_workspace_directories(db, user_a.id)] == ["默认工作区"]

    recreated = await create_workspace_directory(db, user_a.id, name="数据分析")
    await db.commit()
    assert recreated.id != row.id
    assert (tmp_path / str(user_a.id) / f"workspace-{recreated.id}").is_dir()


@pytest.mark.asyncio
async def test_workspace_directory_rejects_reserved_system_roots(db, user_a, tmp_path, monkeypatch):
    """显示名与系统顶层空间同名直接拒绝（事实源见 keys.RESERVED_USER_ROOTS）。"""
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    monkeypatch.setattr(settings.storage, "local_path", str(tmp_path))
    uid = user_a.id  # rollback 会过期 ORM 对象，先取出不可变 id

    for reserved in ("个人文件", "项目文件", "思维", "素材板", "workspace", "shell"):
        with pytest.raises(ValueError):
            await create_workspace_directory(db, uid, name=reserved)
        await db.rollback()


@pytest.mark.asyncio
async def test_workspace_rename_keeps_file_storage_key_valid(db, user_a, tmp_path, monkeypatch):
    """Workspace 里已有文件后 rename，File.storage_key 指向的磁盘路径必须仍然存在。"""
    from app.core.config import get_settings
    from app.models import File
    from app.services.storage.keys import _build_key

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    monkeypatch.setattr(settings.storage, "local_path", str(tmp_path))

    row = await create_workspace_directory(db, user_a.id, name="F1 数据分析")
    await db.commit()
    key = _build_key(
        user_a.id, space="workspace", display_name="report", ext="md",
        workspace_directory_name=row.directory_name,
    )
    physical = tmp_path / key
    physical.parent.mkdir(parents=True, exist_ok=True)
    physical.write_text("hello", encoding="utf-8")
    db.add(File(user_id=user_a.id, display_name="report", ext="md", storage_key=key,
                size="5 B", size_bytes=5, mime_type="text/markdown", space="workspace",
                workspace_directory_id=row.id))
    await db.commit()

    await update_workspace_directory(db, user_a.id, row.id, name="改名的分析")
    await db.commit()
    assert (tmp_path / key).exists()


@pytest.mark.asyncio
async def test_default_workspace_created_outside_get_and_survives_rollback(db, user_b, tmp_path, monkeypatch):
    """P1 回归：GET 列表是只读的；默认 Workspace 由 ensure 显式创建并经 commit 落账。

    曾经 list_workspace_directories 里偷偷 ensure + INSERT，get_db 请求末 rollback 后
    前端拿到的默认目录 ID 消失，磁盘 workspace/ 目录却已创建。
    """
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    monkeypatch.setattr(settings.storage, "local_path", str(tmp_path))
    uid_b = user_b.id  # rollback 会过期 ORM 对象，先取出不可变 id

    # 没注册过默认目录的新用户：GET 列表不创建任何东西。
    assert await list_workspace_directories(db, uid_b) == []
    await db.rollback()
    assert not (tmp_path / str(uid_b) / "workspace").exists()

    # ensure 在注册事务内调用：flush 后有 ID，rollback 后 DB 行消失（磁盘 mkdir 不受
    # 事务控制会留下空目录，但注册流程 commit 成功是主路径，不会产生孤儿行）。
    row = await ensure_default_workspace_directory(db, uid_b)
    await db.rollback()
    assert await list_workspace_directories(db, uid_b) == []

    row = await ensure_default_workspace_directory(db, uid_b)
    await db.commit()
    assert row.is_default and row.is_system
    assert (tmp_path / str(uid_b) / "workspace").is_dir()

    # 幂等：重复 ensure 返回同一行。
    await db.refresh(row)
    again = await ensure_default_workspace_directory(db, uid_b)
    assert again.id == row.id


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


@pytest.mark.asyncio
async def test_workspace_directory_binding_visible_to_agent_tools(db, user_a, tmp_path, monkeypatch):
    """目录必须同步生成 kind=directory 的 Workspace 声明，agent 的 list_workspaces 才可见。"""
    from app.core.config import get_settings
    from app.services.workspaces import list_workspaces_for_management, workspace_payload

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    monkeypatch.setattr(settings.storage, "local_path", str(tmp_path))

    row = await create_workspace_directory(db, user_a.id, name="小北的工作区")
    await db.commit()

    bindings = [b for b in await list_workspaces_for_management(db, user_a.id) if b.directory_id == row.id]
    assert len(bindings) == 1
    assert bindings[0].kind == "directory"
    assert bindings[0].name == "小北的工作区"
    assert bindings[0].enabled is True

    await update_workspace_directory(db, user_a.id, row.id, name="改名的工作区")
    await db.commit()
    bindings = [b for b in await list_workspaces_for_management(db, user_a.id) if b.directory_id == row.id]
    assert len(bindings) == 1
    assert bindings[0].name == "改名的工作区"

    payload = await workspace_payload(db, user_a.id, bindings[0])
    assert payload["kind"] == "directory"
    assert payload["directory_id"] == row.id
    assert payload["directory_name"] == "改名的工作区"

    # 删除目录时声明行一并清理（外键绑定行由 delete_workspace_directory 删除）。
    await delete_workspace_directory(db, user_a.id, row.id)
    await db.commit()
    assert [b for b in await list_workspaces_for_management(db, user_a.id) if b.directory_id == row.id] == []
