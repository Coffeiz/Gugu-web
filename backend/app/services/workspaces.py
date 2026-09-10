"""工作区归属与会话绑定服务。

这里只负责声明、归属和绑定；Shell 范围由会话绑定状态派生，执行器及沙盒留在执行层。
"""
from __future__ import annotations

import os

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from pathlib import Path

from app.models import (
    ConversationSession, File, Folder, Project, ScheduledTask, UserPreferences,
    User, Workspace, WorkspaceDirectory, WorkspaceMigrationReport, TerminalSessionRecord,
)
from app.core.ownership import get_owned
from app.core.config import get_settings
from app.core.tz import now_utc
from app.services.storage.folders import resolve_folder_path
from app.services.storage.keys import RESERVED_USER_ROOTS, _safe_name, compose_logical_path
from app.services.storage.quota_ledger import ensure_user_storage_space, SHELL_PERSISTENT, DEFAULT_WORKSPACE_FOLDER_NAME


def workspace_shell_supported() -> bool:
    """只有本地文件事实源支持 workspace 作为 Shell 挂载。"""
    return get_settings().storage.backend == "local"


async def get_workspace(db: AsyncSession, user_id, workspace_id: int) -> Workspace | None:
    if not workspace_shell_supported():
        return None
    return await get_owned(db, Workspace, workspace_id, user_id)


def _workspace_directory_root(user_id, directory_name: str) -> Path:
    settings = get_settings()
    return (Path(settings.storage.local_path).expanduser().resolve() / str(user_id) / directory_name).resolve()


def _prepare_workspace_root(root: Path) -> None:
    """创建工作区目录并保证沙盒容器进程可写。

    rootless docker 下沙盒进程映射 uid 与宿主机部署用户不同，默认 755 会让
    沙盒内在 /workspace 写文件直接 PermissionError；与 ensure_sandbox_root
    保持同一套全员可写的兼容性取舍（见其注释），目录内条目仍受容器权限约束。
    """
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o777)


async def list_workspace_directories(db: AsyncSession, user_id) -> list[WorkspaceDirectory]:
    # 只读：默认 Workspace 在注册事务内创建（见 auth.register），GET 不做 ensure/mkdir，
    # 否则 get_db 的请求末 rollback 会丢掉这里 INSERT 出来的 ID（磁盘目录却已创建）。
    result = await db.execute(select(WorkspaceDirectory).where(
        WorkspaceDirectory.user_id == user_id,
        WorkspaceDirectory.deleted_at.is_(None),
    ).order_by(WorkspaceDirectory.is_default.desc(), WorkspaceDirectory.name))
    rows = list(result.scalars().all())
    # 顺带自愈历史目录的沙盒可写权限（只 chmod 已存在的目录，不创建任何东西）。
    if get_settings().storage.backend == "local":
        for row in rows:
            root = _workspace_directory_root(user_id, row.directory_name)
            if root.exists():
                root.chmod(0o777)
    return rows


async def _ensure_directory_binding(db: AsyncSession, user_id, directory: WorkspaceDirectory) -> Workspace | None:
    """目录与工作区声明一对一同步：缺声明行时补建，保证 agent 工具可见。

    网页创建的 WorkspaceDirectory 与 agent ``list_workspaces`` 读的 Workspace
    声明是两张表；不补声明的话目录在 agent 侧不可见，也无法绑定会话/任务。
    """
    if not workspace_shell_supported():
        return None
    binding = await db.scalar(select(Workspace).where(
        Workspace.user_id == user_id, Workspace.directory_id == directory.id,
    ))
    if binding is None:
        binding = Workspace(
            user_id=user_id, name=directory.name, kind="directory",
            directory_id=directory.id, enabled=True,
        )
        db.add(binding)
        await db.flush()
    return binding


async def ensure_default_workspace_directory(db: AsyncSession, user_id) -> WorkspaceDirectory:
    """为新用户补齐默认 Workspace；可重复调用且不在迁移中触碰文件系统。"""
    row = await db.scalar(select(WorkspaceDirectory).where(
        WorkspaceDirectory.user_id == user_id,
        WorkspaceDirectory.directory_name == DEFAULT_WORKSPACE_FOLDER_NAME,
        WorkspaceDirectory.deleted_at.is_(None),
    ))
    if row is None:
        row = WorkspaceDirectory(
            user_id=user_id, name="默认工作区",
            directory_name=DEFAULT_WORKSPACE_FOLDER_NAME,
            is_default=True, is_system=True,
        )
        db.add(row)
        await db.flush()
    if get_settings().storage.backend == "local":
        _prepare_workspace_root(_workspace_directory_root(user_id, row.directory_name))
    await _ensure_directory_binding(db, user_id, row)
    return row


async def workspace_directory_payload(db: AsyncSession, user_id, row: WorkspaceDirectory) -> dict:
    file_count = await db.scalar(select(func.count(File.id)).where(
        File.user_id == user_id, File.workspace_directory_id == row.id, File.deleted_at.is_(None),
    ))
    folder_count = await db.scalar(select(func.count(Folder.id)).where(
        Folder.user_id == user_id, Folder.workspace_directory_id == row.id, Folder.deleted_at.is_(None),
    ))
    bound_workspace_ids = select(Workspace.id).where(Workspace.user_id == user_id, Workspace.directory_id == row.id)
    session_count = await db.scalar(select(func.count(ConversationSession.id)).where(
        ConversationSession.user_id == user_id, ConversationSession.workspace_id.in_(bound_workspace_ids)
    ))
    task_count = await db.scalar(select(func.count(ScheduledTask.id)).where(
        ScheduledTask.user_id == user_id, ScheduledTask.workspace_id.in_(bound_workspace_ids)
    ))
    return {
        "id": row.id, "name": row.name, "directory_name": row.directory_name,
        "is_default": row.is_default, "is_system": row.is_system,
        "file_count": int(file_count or 0), "folder_count": int(folder_count or 0),
        "bound_session_count": int(session_count or 0),
        "bound_task_count": int(task_count or 0),
    }


def _validate_workspace_display_name(name: str) -> str:
    """显示名规范化：非空且不与系统保留根目录同名（create/rename 共用）。"""
    normalized = name.strip()
    if not normalized:
        raise ValueError("Workspace 名称不能为空")
    # 只拦显示名与系统空间同名造成的认知混淆；物理目录名按 id 生成，结构上不碰撞。
    if _safe_name(normalized) in RESERVED_USER_ROOTS:
        raise ValueError("Workspace 名称与系统目录冲突")
    return normalized


async def _flush_workspace_name_unique(db: AsyncSession) -> None:
    """显示名 (user_id, name) 部分唯一索引兜底：precheck 之后的并发同名竞争
    在 flush 时撞索引，统一映射成 ValueError（API 层转 409）。"""
    try:
        await db.flush()
    except IntegrityError as exc:
        raise ValueError("Workspace 已存在") from exc


async def create_workspace_directory(db: AsyncSession, user_id, *, name: str) -> WorkspaceDirectory:
    if get_settings().storage.backend != "local":
        raise ValueError("当前存储后端不支持本地 Workspace")
    await ensure_default_workspace_directory(db, user_id)
    normalized = _validate_workspace_display_name(name)
    existing = await db.scalar(select(WorkspaceDirectory).where(
        WorkspaceDirectory.user_id == user_id,
        WorkspaceDirectory.name == normalized,
        WorkspaceDirectory.deleted_at.is_(None),
    ))
    if existing:
        raise ValueError("Workspace 已存在")
    row = WorkspaceDirectory(user_id=user_id, name=normalized, directory_name="")
    db.add(row)
    await _flush_workspace_name_unique(db)
    # 物理目录用不可变 id（workspace-<id>）：File.storage_key 永久引用物理路径，
    # 若按显示名建目录，rename 后所有 key 失效（download/preview 全挂）。
    # id 命名也结构性地排除了与系统保留根目录的碰撞。
    row.directory_name = f"workspace-{row.id}"
    await db.flush()
    root = _workspace_directory_root(user_id, row.directory_name)
    _prepare_workspace_root(root)
    await _ensure_directory_binding(db, user_id, row)
    return row


async def update_workspace_directory(db: AsyncSession, user_id, directory_id: int, *, name: str) -> WorkspaceDirectory:
    row = await get_owned(db, WorkspaceDirectory, directory_id, user_id)
    if row is None or row.deleted_at is not None:
        raise LookupError("Workspace 不存在")
    if row.is_system:
        raise ValueError("默认 Workspace 不可重命名")
    normalized = _validate_workspace_display_name(name)
    if normalized != row.name:
        if await db.scalar(select(WorkspaceDirectory).where(
            WorkspaceDirectory.user_id == user_id,
            WorkspaceDirectory.name == normalized,
            WorkspaceDirectory.deleted_at.is_(None),
            WorkspaceDirectory.id != row.id,
        )):
            raise ValueError("Workspace 已存在")
        # 物理目录（workspace-<id>）不可变：File.storage_key 永久引用它，rename 只改显示名。
        row.name = normalized
        bindings = (await db.execute(select(Workspace).where(
            Workspace.user_id == user_id, Workspace.directory_id == row.id,
        ))).scalars().all()
        for binding in bindings:
            binding.name = normalized
    # rename 与 create 共用同一份唯一索引兜底映射，避免并发同名 rename 漏成 500。
    await _flush_workspace_name_unique(db)
    return row


async def delete_workspace_directory(db: AsyncSession, user_id, directory_id: int) -> tuple[list[str], Path]:
    row = await get_owned(db, WorkspaceDirectory, directory_id, user_id)
    if row is None or row.deleted_at is not None:
        raise LookupError("Workspace 不存在")
    if row.is_default or row.is_system:
        raise ValueError("默认 Workspace 不可删除")
    root = _workspace_directory_root(user_id, row.directory_name)
    user_root = Path(get_settings().storage.local_path).expanduser().resolve() / str(user_id)
    try:
        root.relative_to(user_root)
    except ValueError as exc:
        raise ValueError("Workspace 目录不在用户存储根内") from exc
    deleted_at = now_utc()
    bindings = (await db.execute(select(Workspace).where(
        Workspace.user_id == user_id, Workspace.directory_id == row.id
    ))).scalars().all()
    binding_ids = [binding.id for binding in bindings]
    terminal_ids: list[str] = []
    if binding_ids:
        terminal_ids = list((await db.scalars(select(TerminalSessionRecord.id).where(
            TerminalSessionRecord.owner_id == user_id,
            TerminalSessionRecord.workspace_id.in_(binding_ids),
            TerminalSessionRecord.closed_at.is_(None),
        ))).all())
        await db.execute(ConversationSession.__table__.update().where(
            ConversationSession.user_id == user_id,
            ConversationSession.workspace_id.in_(binding_ids),
        ).values(workspace_id=None))
        await db.execute(ScheduledTask.__table__.update().where(
            ScheduledTask.user_id == user_id,
            ScheduledTask.workspace_id.in_(binding_ids),
        ).values(workspace_id=None, enabled=False))
        # 先改 terminal 状态再删 Workspace：ON DELETE SET NULL 会在 DELETE 后把
        # workspace_id 置空，之后按 workspace_id IN 匹配的 UPDATE 将一无所获，
        # 留下 workspace_id=NULL + status=running 的僵尸行。
        await db.execute(TerminalSessionRecord.__table__.update().where(
            TerminalSessionRecord.owner_id == user_id,
            TerminalSessionRecord.workspace_id.in_(binding_ids),
            TerminalSessionRecord.closed_at.is_(None),
        ).values(status="terminated", closed_at=deleted_at, updated_at=deleted_at))
        await db.execute(Workspace.__table__.delete().where(Workspace.id.in_(binding_ids)))
    await db.execute(File.__table__.update().where(
        File.user_id == user_id, File.workspace_directory_id == row.id, File.deleted_at.is_(None),
    ).values(deleted_at=deleted_at, updated_at=deleted_at))
    await db.execute(Folder.__table__.update().where(
        Folder.user_id == user_id, Folder.workspace_directory_id == row.id, Folder.deleted_at.is_(None),
    ).values(deleted_at=deleted_at, updated_at=deleted_at, version=Folder.version + 1))
    await db.execute(WorkspaceDirectory.__table__.update().where(
        WorkspaceDirectory.id == row.id, WorkspaceDirectory.user_id == user_id,
    ).values(deleted_at=deleted_at, updated_at=deleted_at))
    await db.flush()
    # 磁盘操作由 API 层执行，顺序为 fail-closed：terminate PTY → commit DB →
    # 原子改名 → rmtree。terminate 失败会回滚事务（权限未撤销、文件仍可用）；
    # commit 成功后清理失败只留下可回收 orphan 目录，不会出现"DB 说文件健在而
    # 磁盘已消失"的破坏性状态，也不会在重试删除时遗留墓碑。
    return terminal_ids, root


async def scan_legacy_shell_directories(db: AsyncSession, user_id=None) -> list[WorkspaceMigrationReport]:
    """只读盘点旧 ``shell`` 目录并持久化可重试的迁移状态。"""
    if get_settings().storage.backend != "local":
        return []
    stmt = select(User).where(User.is_active.is_(True))
    if user_id is not None:
        stmt = stmt.where(User.id == user_id)
    users = list((await db.execute(stmt)).scalars().all())
    reports: list[WorkspaceMigrationReport] = []
    for user in users:
        source = _workspace_directory_root(user.id, "shell")
        target = _workspace_directory_root(user.id, DEFAULT_WORKSPACE_FOLDER_NAME)
        status = "not_found"
        count = 0
        error_message = None
        if source.exists():
            try:
                count = sum(1 for item in source.rglob("*") if item.is_file())
                if not os.access(source, os.R_OK):
                    raise PermissionError("旧 Shell 目录不可读")
                status = "ready"
            except OSError as exc:
                status = "failed"
                error_message = type(exc).__name__
        report = await db.scalar(select(WorkspaceMigrationReport).where(
            WorkspaceMigrationReport.user_id == user.id,
            WorkspaceMigrationReport.source_directory == str(source),
        ))
        values = {
            "target_directory": str(target), "status": status,
            "source_file_count": count, "error_message": error_message,
            "scanned_at": now_utc(),
        }
        if report is None:
            report = WorkspaceMigrationReport(
                user_id=user.id, source_directory=str(source), **values,
            )
            db.add(report)
        else:
            for key, value in values.items():
                setattr(report, key, value)
        reports.append(report)
    await db.flush()
    return reports


async def list_workspaces(db: AsyncSession, user_id) -> list[Workspace]:
    """列出当前用户可绑定的启用工作区。"""
    if not workspace_shell_supported():
        return []
    result = await db.execute(
        select(Workspace)
        .where(Workspace.user_id == user_id, Workspace.enabled.is_(True))
        .order_by(Workspace.updated_at.desc(), Workspace.id.desc())
    )
    return list(result.scalars().all())


async def list_workspaces_for_management(db: AsyncSession, user_id) -> list[Workspace]:
    """列出当前用户全部工作区，包含停用项供管理工具使用。"""
    if not workspace_shell_supported():
        return []
    result = await db.execute(
        select(Workspace)
        .where(Workspace.user_id == user_id)
        .order_by(Workspace.updated_at.desc(), Workspace.id.desc())
    )
    return list(result.scalars().all())


async def workspace_payload(db: AsyncSession, user_id, row: Workspace) -> dict:
    """构造工作区工具结果，并在服务层完成关联对象的归属查询。"""
    count = await db.scalar(
        select(func.count(ConversationSession.id)).where(
            ConversationSession.user_id == user_id,
            ConversationSession.workspace_id == row.id,
        )
    )
    result = {
        "workspace_id": row.id,
        "name": row.name,
        "kind": row.kind,
        "enabled": row.enabled,
        "is_default": row.is_default,
        "bound_session_count": int(count or 0),
        "project_id": row.project_id,
        "folder_id": row.folder_id,
    }
    if row.project_id is not None:
        project = await get_owned(db, Project, row.project_id, user_id)
        result["project_name"] = project.name if project else None
    if row.folder_id is not None:
        folder = await get_owned(db, Folder, row.folder_id, user_id)
        result["folder_name"] = folder.name if folder else None
    if row.directory_id is not None:
        directory = await get_owned(db, WorkspaceDirectory, row.directory_id, user_id)
        result["directory_id"] = row.directory_id
        result["directory_name"] = directory.name if directory else None
    return result


async def create_workspace(
    db: AsyncSession, user_id, *, name: str, kind: str,
    folder_id: int | None = None, project_id: int | None = None,
    directory_id: int | None = None,
    enabled: bool = True,
) -> Workspace:
    if not workspace_shell_supported():
        raise ValueError("OSS 存储模式不支持 workspace，请使用独立 Shell 沙盒")
    if kind == "folder":
        if folder_id is None or await get_owned(db, Folder, folder_id, user_id) is None:
            raise ValueError("文件夹不存在")
        project_id = None
    elif kind == "project":
        if project_id is None or await get_owned(db, Project, project_id, user_id) is None:
            raise ValueError("项目不存在")
        folder_id = None
    elif kind == "directory":
        directory = await get_owned(db, WorkspaceDirectory, directory_id, user_id)
        if directory is None or directory.deleted_at is not None:
            raise ValueError("Workspace 目录不存在")
        folder_id = project_id = None
    else:
        raise ValueError("工作区类型无效")

    workspace = Workspace(
        user_id=user_id, name=name.strip(), kind=kind,
        folder_id=folder_id, project_id=project_id, directory_id=directory_id if kind == "directory" else None, enabled=enabled,
    )
    db.add(workspace)
    await db.flush()
    return workspace


async def update_workspace(
    db: AsyncSession, user_id, workspace_id: int, *,
    name: str | None = None, enabled: bool | None = None,
) -> Workspace:
    if not workspace_shell_supported():
        raise ValueError("OSS 存储模式不支持 workspace，请使用独立 Shell 沙盒")
    workspace = await get_workspace(db, user_id, workspace_id)
    if workspace is None:
        raise LookupError("工作区不存在")
    if name is not None:
        normalized = name.strip()
        if not normalized:
            raise ValueError("工作区名称不能为空")
        workspace.name = normalized
    if enabled is not None:
        workspace.enabled = enabled
    await db.flush()
    return workspace


async def delete_workspace(db: AsyncSession, user_id, workspace_id: int) -> None:
    if not workspace_shell_supported():
        raise ValueError("OSS 存储模式不支持 workspace，请使用独立 Shell 沙盒")
    workspace = await get_workspace(db, user_id, workspace_id)
    if workspace is None:
        raise LookupError("工作区不存在")
    # 显式解除绑定，确保测试数据库与生产数据库的 ON DELETE 行为一致。
    sessions = (await db.execute(
        select(ConversationSession).where(
            ConversationSession.user_id == user_id,
            ConversationSession.workspace_id == workspace.id,
        )
    )).scalars().all()
    for session in sessions:
        session.workspace_id = None
    # 任务不能在工作区删除后静默回落到默认 /workspace；先停用绑定任务，随后
    # 由外键 SET NULL 清理绑定值。用户重新编辑前不会继续执行旧任务。
    tasks = (await db.execute(
        select(ScheduledTask).where(
            ScheduledTask.user_id == user_id,
            ScheduledTask.workspace_id == workspace.id,
            ScheduledTask.event_id.is_(None),
        )
    )).scalars().all()
    for task in tasks:
        task.enabled = False
        task.workspace_id = None
    await db.delete(workspace)
    await db.flush()


async def bind_session(db: AsyncSession, user_id, session_id: int, workspace_id: int | None) -> ConversationSession:
    session = await get_owned(db, ConversationSession, session_id, user_id)
    if session is None:
        raise LookupError("会话不存在")
    if workspace_id is not None and not workspace_shell_supported():
        raise ValueError("OSS 存储模式不支持 workspace，请使用独立 Shell 沙盒")
    if workspace_id is None:
        session.workspace_id = None
    else:
        workspace = await get_workspace(db, user_id, workspace_id)
        if workspace is None or not workspace.enabled:
            raise LookupError("工作区不存在或已停用")
        session.workspace_id = workspace.id
    await db.flush()
    return session


async def effective_shell_enabled(db: AsyncSession, user_id) -> bool:
    """返回用户级开关；全局开关由调用方与本函数结果做 AND。"""
    prefs = (await db.execute(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    )).scalar_one_or_none()
    return bool(prefs and prefs.data.get("shell_enabled", False))


async def effective_shell_system_enabled(db: AsyncSession, user_id) -> bool:
    prefs = (await db.execute(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    )).scalar_one_or_none()
    return bool(prefs and prefs.data.get("shell_system_enabled", False))


async def effective_shell_dangerous_enabled(db: AsyncSession, user_id) -> bool:
    """读取用户全部 Shell 命令权限；管理员开关和确认门由策略层校验。"""
    result = await db.execute(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    )
    prefs = result.scalar_one_or_none()
    return bool(prefs and prefs.data.get("shell_dangerous_enabled", False))


async def effective_shell_autopilot_enabled(db: AsyncSession, user_id) -> bool:
    """读取用户 Autopilot 开关；管理员总开关由调用方同时校验。"""
    prefs = (await db.execute(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    )).scalar_one_or_none()
    return bool(prefs and prefs.data.get("shell_autopilot_enabled", False))


async def describe_session(db: AsyncSession, user_id, session_id: int) -> Workspace | None:
    session = await get_owned(db, ConversationSession, session_id, user_id)
    if session is None or session.workspace_id is None:
        return None
    return await get_workspace(db, user_id, session.workspace_id)


async def resolve_workspace_target(
    db: AsyncSession, user_id, workspace_id: int,
) -> dict | None:
    """解析会话工作区对应的文件库规范落点。

    工作区 id 与项目/文件夹 id 属于不同命名空间；文件工具只消费这里返回的
    ``space/project_id/folder_id``，避免把同数值的 workspace_id 误当成 project_id。
    """
    if not workspace_shell_supported():
        return None
    workspace = await get_workspace(db, user_id, workspace_id)
    if workspace is None or not workspace.enabled:
        return None
    if workspace.kind == "project" and workspace.project_id is not None:
        project = await get_owned(db, Project, workspace.project_id, user_id)
        if project is None:
            return None
        return {
            "workspace_id": workspace.id, "workspace_name": workspace.name,
            "kind": "project", "space": "project",
            "project_id": project.id, "folder_id": None,
            "project_name": project.name,
        }
    if workspace.kind == "directory" and workspace.directory_id is not None:
        directory = await get_owned(db, WorkspaceDirectory, workspace.directory_id, user_id)
        if directory is None or directory.deleted_at is not None:
            return None
        return {
            "workspace_id": workspace.id, "workspace_name": workspace.name,
            "kind": "directory", "space": "workspace",
            "workspace_directory_id": directory.id,
            "workspace_directory_name": directory.directory_name,
            "project_id": None, "folder_id": None,
        }
    if workspace.kind == "folder" and workspace.folder_id is not None:
        folder = await get_owned(db, Folder, workspace.folder_id, user_id)
        if folder is None or folder.deleted_at is not None:
            return None
        if folder.project_id is None:
            return {
                "workspace_id": workspace.id, "workspace_name": workspace.name,
                "kind": "folder", "space": "personal",
                "project_id": None, "folder_id": folder.id,
                "folder_name": folder.name,
            }
        project = await get_owned(db, Project, folder.project_id, user_id)
        if project is None:
            return None
        return {
            "workspace_id": workspace.id, "workspace_name": workspace.name,
            "kind": "folder", "space": "project",
            "project_id": project.id, "folder_id": folder.id,
            "project_name": project.name, "folder_name": folder.name,
        }
    return None


async def resolve_default_workspace_target(db: AsyncSession, user_id) -> dict | None:
    """解析用户默认 Workspace 的文件库落点，不改变会话绑定或数据库状态。

    未绑定会话使用默认 Workspace 是运行时默认值，不等同于给会话授予
    ``/personal`` 或 ``/project`` 的完整用户沙箱权限。OSS 模式没有本地
    Workspace，因此始终返回 ``None``。
    """
    if not workspace_shell_supported():
        return None
    workspace = await db.scalar(
        select(Workspace)
        .join(WorkspaceDirectory, Workspace.directory_id == WorkspaceDirectory.id)
        .where(
            Workspace.user_id == user_id,
            Workspace.enabled.is_(True),
            WorkspaceDirectory.user_id == user_id,
            WorkspaceDirectory.is_default.is_(True),
            WorkspaceDirectory.deleted_at.is_(None),
        )
        .order_by(Workspace.id)
    )
    if workspace is None:
        return None
    return await resolve_workspace_target(db, user_id, workspace.id)


async def resolve_workspace_root(db: AsyncSession, user_id, workspace_id: int) -> Path | None:
    """把已归属的工作区解析为本地存储根下的真实目录。

    只返回本地存储路径；远程存储后端不能被本机执行器隐式当成本地目录使用。
    """
    workspace = await get_workspace(db, user_id, workspace_id)
    if workspace is None or not workspace.enabled:
        return None
    settings = get_settings()
    if settings.storage.backend != "local":
        return None

    logical = None
    if workspace.kind == "project" and workspace.project_id is not None:
        project = await get_owned(db, Project, workspace.project_id, user_id)
        if project is None:
            return None
        date_str = project.start_date or project.created_at.strftime("%Y-%m-%d")
        logical = compose_logical_path(
            "project", project_name=project.name, project_id=project.id,
            project_year=date_str[:4], project_month=date_str[5:7],
        )
    elif workspace.kind == "directory" and workspace.directory_id is not None:
        directory = await get_owned(db, WorkspaceDirectory, workspace.directory_id, user_id)
        if directory is None or directory.deleted_at is not None:
            return None
        logical = compose_logical_path("workspace", workspace_directory_name=directory.directory_name)
    elif workspace.kind == "folder" and workspace.folder_id is not None:
        folder = await get_owned(db, Folder, workspace.folder_id, user_id)
        if folder is None or folder.deleted_at is not None:
            return None
        resolved = await resolve_folder_path(db, user_id, folder.id, folder.project_id)
        if not resolved:
            return None
        _, folder_path = resolved
        if folder.project_id is None:
            logical = compose_logical_path("personal", folder_path=folder_path)
        else:
            project = await get_owned(db, Project, folder.project_id, user_id)
            if project is None:
                return None
            date_str = project.start_date or project.created_at.strftime("%Y-%m-%d")
            logical = compose_logical_path(
                "project", project_name=project.name, project_id=project.id,
                project_year=date_str[:4], project_month=date_str[5:7],
                folder_path=folder_path,
            )
    if not logical:
        return None
    return (Path(settings.storage.local_path).resolve() / str(user_id) / logical).resolve()


async def resolve_sandbox_root(db: AsyncSession, user_id) -> Path | None:
    """解析文件库个人空间下的默认沙盒工作区目录。"""
    settings = get_settings()
    if settings.storage.backend not in {"local", "oss"}:
        return None
    if db is None:
        # 纯路径解析测试/启动探测没有数据库上下文，不能伪造配额登记；正式
        # Shell 请求始终传入 AsyncSession，并走统一账本初始化。
        from agent.sandbox.quota import ensure_sandbox_root
        root = (Path(settings.storage.local_path).resolve() / str(user_id) / DEFAULT_WORKSPACE_FOLDER_NAME).resolve()
        return ensure_sandbox_root(root)
    rows = await ensure_user_storage_space(db, user_id)
    row = next(item for item in rows if item.category == SHELL_PERSISTENT)
    return Path(row.root_path).resolve()


async def resolve_user_personal_root(db: AsyncSession, user_id) -> Path | None:
    """解析当前用户个人文件库根目录，供沙盒以只读方式挂载到 ``/personal``。

    这里只暴露「个人文件」空间，不暴露用户存储根、人格目录、Shell 持久目录
    或其他内部空间。workspace 是否绑定不影响此映射；``/project`` 也由用户根目录
    独立解析，不能通过 workspace 参数改变。
    """
    settings = get_settings()
    # OSS 对象没有本机目录，不能把一个空的 local_path 伪装成文件库挂载。
    # 后续若要支持 OSS，应先实现受控的只读 materialize/cache，而不是直接放开。
    if settings.storage.backend != "local":
        return None
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    user_root = (storage_root / str(user_id)).resolve()
    personal_root = (user_root / compose_logical_path("personal")).resolve()
    try:
        user_root.relative_to(storage_root)
        personal_root.relative_to(user_root)
    except ValueError:
        return None
    # 文件库可能刚创建、尚无文件；创建空间根后仍能稳定提供 /personal。
    personal_root.mkdir(parents=True, exist_ok=True)
    return personal_root


async def resolve_project_root(db: AsyncSession, user_id) -> Path | None:
    """解析当前用户完整项目文件库根目录，供沙盒只读挂载到 ``/project``。

    ``/project`` 不是当前 workspace，也不是某一个项目子目录；它对应用户存储
    下的 ``项目文件``，内部保留 ``年/月/项目名 #id`` 层级。workspace 只决定
    ``/workspace`` 的默认工作目录。
    """
    settings = get_settings()
    if settings.storage.backend != "local":
        return None
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    user_root = (storage_root / str(user_id)).resolve()
    project_root = (user_root / compose_logical_path("project")).resolve()
    try:
        user_root.relative_to(storage_root)
        project_root.relative_to(user_root)
    except ValueError:
        return None
    project_root.mkdir(parents=True, exist_ok=True)
    return project_root


async def resolve_shell_root(db: AsyncSession, user_id, scope: str, workspace_id: int | None) -> Path | None:
    if scope == "sandbox" and workspace_id:
        return await resolve_workspace_root(db, user_id, workspace_id) if workspace_id else None
    if scope == "sandbox":
        return await resolve_sandbox_root(db, user_id)
    if scope == "system":
        return Path("/").resolve()
    return None
