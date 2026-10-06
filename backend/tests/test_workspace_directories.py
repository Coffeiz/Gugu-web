"""顶层 Workspace 文件空间元数据契约测试。"""

from sqlalchemy import inspect, select
import pytest

from app.models import File, FileSyncBinding, FileSyncJournal, Folder, WorkspaceDirectory
import app.services.filesync.protocol as filesync_protocol
import app.services.workspaces as workspace_service
from app.services.workspaces import (
    create_workspace_directory,
    delete_workspace_directory,
    ensure_default_workspace_directory,
    list_workspace_directories,
    get_workspace_by_directory,
    resolve_shell_workspace_mounts,
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
    # 物理目录段创建后不可变：File.storage_key 永久引用它，
    # 显示名只活在 WorkspaceDirectory.name，rename 不能再动磁盘路径。
    root = tmp_path / str(user_a.id) / "workspace" / row.directory_name
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

    terminal_ids, del_root = await delete_workspace_directory(db, user_a.id, row.id)
    await db.commit()
    assert terminal_ids == []
    # service 只做 DB 落账，物理目录保持原样；磁盘清理由 API 在 commit、
    # 断开活 PTY 之后做（改名墓碑 + rmtree），commit 失败时文件完整可用。
    assert root.is_dir()
    assert del_root == root
    import shutil
    shutil.rmtree(del_root)
    assert [item.name for item in await list_workspace_directories(db, user_a.id)] == ["默认工作区"]

    recreated = await create_workspace_directory(db, user_a.id, name="数据分析")
    await db.commit()
    assert recreated.id != row.id
    assert (tmp_path / str(user_a.id) / "workspace" / recreated.directory_name).is_dir()


@pytest.mark.asyncio
async def test_workspace_directory_delete_advances_overlapping_root_binding(db, user_a, tmp_path, monkeypatch):
    """删除独立工作区时，覆盖全用户根目录的同步绑定仍收到文件和目录墓碑。"""
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    monkeypatch.setattr(settings.storage, "local_path", str(tmp_path))
    monkeypatch.setattr(settings.filesync, "enabled", True)
    monkeypatch.setattr(workspace_service, "get_settings", lambda: settings)
    monkeypatch.setattr(filesync_protocol, "get_settings", lambda: settings)
    monkeypatch.setattr(filesync_protocol, "is_file_sync_enabled", lambda: True)

    directory = await create_workspace_directory(db, user_a.id, name="资料工作区")
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        status="active", root_path=".", root_fingerprint="a" * 64,
    )
    folder = Folder(
        user_id=user_a.id, workspace_directory_id=directory.id, name="文档",
    )
    db.add_all([binding, folder])
    await db.flush()
    file = File(
        user_id=user_a.id, workspace_directory_id=directory.id,
        folder_id=folder.id, display_name="说明", ext="md", space="workspace",
        storage_key=f"{user_a.id}/workspace/{directory.directory_name}/文档/说明.md",
    )
    db.add(file)
    await db.commit()
    await db.refresh(binding)

    await delete_workspace_directory(db, user_a.id, directory.id)
    changes = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
    ).order_by(FileSyncJournal.id))).all()

    assert [(entry.relative_path, entry.operation) for entry in changes] == [
        (f"workspace/{directory.directory_name}/文档/说明.md", "delete"),
        (f"workspace/{directory.directory_name}/文档", "delete"),
    ]
    await db.refresh(binding)
    assert binding.dirty_revision == 2


@pytest.mark.asyncio
async def test_shell_workspace_namespace_is_owner_scoped_and_binding_only_selects_default_cwd(
    db, user_a, user_b, tmp_path, monkeypatch,
):
    """普通授权只挂当前目录；完整授权才扩展到同一用户的工作区树。"""
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    monkeypatch.setattr(settings.storage, "local_path", str(tmp_path))
    default = await ensure_default_workspace_directory(db, user_a.id)
    qq = await create_workspace_directory(db, user_a.id, name="QQ 工作区")
    await ensure_default_workspace_directory(db, user_b.id)
    await db.commit()
    qq_binding = await get_workspace_by_directory(db, user_a.id, qq.id)
    assert qq_binding is not None

    default_mounts, default_cwd = await resolve_shell_workspace_mounts(
        db, user_a.id, None, include_all=False,
    )
    assert default_cwd == "/workspace/default"
    assert default_mounts == [("/workspace/default", tmp_path / str(user_a.id) / "workspace" / default.directory_name)]

    bound_mounts, bound_cwd = await resolve_shell_workspace_mounts(
        db, user_a.id, qq_binding.id, include_all=False,
    )
    assert bound_cwd == "/workspace/qq"
    assert bound_mounts == [("/workspace/qq", tmp_path / str(user_a.id) / "workspace" / qq.directory_name)]

    all_mounts, all_cwd = await resolve_shell_workspace_mounts(
        db, user_a.id, qq_binding.id, include_all=True,
    )
    assert all_cwd == "/workspace/qq"
    assert dict(all_mounts) == {
        "/workspace/default": tmp_path / str(user_a.id) / "workspace" / default.directory_name,
        "/workspace/qq": tmp_path / str(user_a.id) / "workspace" / qq.directory_name,
    }
    assert all(str(user_b.id) not in str(path) for _name, path in all_mounts)


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


@pytest.mark.asyncio
async def test_workspace_directory_name_rules_shared_by_create_and_rename(db, user_a, tmp_path, monkeypatch):
    """保留名/空名检查由 create 与 rename 共用，rename 不留绕过口。"""
    from app.core.config import get_settings
    from app.services.workspaces import create_workspace_directory, update_workspace_directory

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    monkeypatch.setattr(settings.storage, "local_path", str(tmp_path))

    for reserved in ("个人文件", "项目文件", "workspace", "shell", "  "):
        with pytest.raises(ValueError):
            await create_workspace_directory(db, user_a.id, name=reserved)
    row = await create_workspace_directory(db, user_a.id, name="合法名")
    await db.commit()

    for reserved in ("shell", "个人文件", ""):
        with pytest.raises(ValueError):
            await update_workspace_directory(db, user_a.id, row.id, name=reserved)
    assert row.name == "合法名"


@pytest.mark.asyncio
async def test_workspace_directory_display_name_unique_at_db_level(db, user_a):
    """物理目录段冻结后，显示名唯一性由部分唯一索引兜底并发创建。"""
    from sqlalchemy.exc import IntegrityError

    db.add(WorkspaceDirectory(user_id=user_a.id, name="撞名", directory_name="workspace-901"))
    db.add(WorkspaceDirectory(user_id=user_a.id, name="撞名", directory_name="workspace-902"))
    with pytest.raises(IntegrityError):
        await db.flush()
    await db.rollback()
