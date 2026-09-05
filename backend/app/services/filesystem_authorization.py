"""用户沙箱授权事实源与统一文件系统策略。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import ConversationSession, FilesystemAuthorizationGrant, Folder, ScheduledTask

SUBJECT_SESSION = "session"
SUBJECT_SCHEDULED_TASK = "scheduled_task"
USER_SANDBOX_SCOPE = "user_sandbox"
READ_WRITE = "read_write"


def filesystem_authorization_enabled() -> bool:
    """返回完整用户沙箱授权入口的后端灰度状态。"""
    return bool(get_settings().sandbox.filesystem_authorization_enabled)


def _record_authorization_event(
    db,
    *, user_id, subject_type: str, subject_id, outcome: str,
    grant_id: int | None = None, source: str = "system",
) -> None:
    from app.core import opsmetrics
    from app.security.events import add_filesystem_authorization_event

    add_filesystem_authorization_event(
        db,
        user_id=user_id, subject_type=subject_type, subject_id=subject_id,
        outcome=outcome, grant_id=grant_id, source=source,
    )
    opsmetrics.record_filesystem_authorization(outcome, subject_type)


@dataclass(frozen=True)
class FilesystemPolicy:
    """执行器所需的最小策略，不携带用户路径或敏感数据。"""

    subject_type: str = SUBJECT_SESSION
    subject_id: str | None = None
    grant_id: int | None = None
    workspace_read_write: bool = True
    personal_read_only: bool = True
    project_read_only: bool = True
    workspace_id: int | None = None
    cwd: str | None = None

    @property
    def full_user_sandbox(self) -> bool:
        return not self.personal_read_only and not self.project_read_only


async def _location_is_in_workspace(
    db: AsyncSession,
    user_id,
    workspace_id: int,
    *,
    space: str,
    project_id: int | None,
    folder_id: int | None,
) -> bool:
    """判断文件库位置是否位于 workspace 根或其子树内。"""
    from app.services.workspaces import resolve_workspace_target

    target = await resolve_workspace_target(db, user_id, workspace_id)
    if target is None or space not in {"personal", "project"}:
        return False
    if target["kind"] == "project":
        return space == "project" and project_id == target.get("project_id")
    if space != target.get("space") or project_id != target.get("project_id"):
        return False
    target_folder_id = target.get("folder_id")
    if target_folder_id is None or folder_id is None:
        return folder_id is None and target_folder_id is None

    current_id = folder_id
    visited: set[int] = set()
    while current_id is not None and current_id not in visited:
        visited.add(current_id)
        if current_id == target_folder_id:
            return True
        folder = await get_owned(db, Folder, current_id, user_id)
        if folder is None or folder.deleted_at is not None:
            return False
        current_id = folder.parent_id
    return False


async def filesystem_location_can_write(
    db: AsyncSession,
    user_id,
    policy: FilesystemPolicy,
    *,
    space: str,
    project_id: int | None = None,
    folder_id: int | None = None,
) -> bool:
    """按统一 policy 判断文件库位置是否允许写入。

    mind/asset 不属于沙箱的 ``/personal``/``/project`` 挂载，因此仍由其领域
    服务自己的 ownership 和确认门负责；本函数只约束用户沙箱两类文件空间。
    """
    if space not in {"personal", "project"}:
        return True
    try:
        project_id = int(project_id) if project_id is not None else None
        folder_id = int(folder_id) if folder_id is not None else None
    except (TypeError, ValueError):
        return False
    if policy.full_user_sandbox:
        return True
    if policy.workspace_id is None:
        return False
    return await _location_is_in_workspace(
        db, user_id, policy.workspace_id,
        space=space, project_id=project_id, folder_id=folder_id,
    )


async def filesystem_write_error(
    db: AsyncSession,
    user_id,
    policy: FilesystemPolicy,
    *,
    space: str,
    project_id: int | None = None,
    folder_id: int | None = None,
) -> str | None:
    """返回稳定的只读错误；允许时返回 ``None``。"""
    if await filesystem_location_can_write(
        db, user_id, policy, space=space, project_id=project_id, folder_id=folder_id,
    ):
        return None
    from app.core import opsmetrics
    opsmetrics.record_security("filesystem.authorization.denied")
    opsmetrics.record_filesystem_authorization("denied", policy.subject_type)
    return "当前文件系统权限只允许读取该个人/项目位置；请绑定对应 workspace，或先显式授权完整用户沙箱读写权限。"


def record_filesystem_authorization_request(
    db,
    *, user_id, subject_type: str, subject_id: int | str, source: str = "user",
) -> None:
    """记录一次已创建的授权确认请求，不创建授权本身。"""
    if not filesystem_authorization_enabled():
        raise LookupError("完整用户沙箱授权功能当前未开启")
    _record_authorization_event(
        db, user_id=user_id, subject_type=subject_type, subject_id=subject_id,
        outcome="requested", source=source,
    )


async def get_active_grant(
    db: AsyncSession,
    user_id,
    *,
    subject_type: str,
    subject_id: int | str,
    now: datetime | None = None,
) -> FilesystemAuthorizationGrant | None:
    """查询当前主体的未撤销、未过期授权。"""
    current = now or now_utc()
    return await db.scalar(
        select(FilesystemAuthorizationGrant)
        .where(
            FilesystemAuthorizationGrant.user_id == user_id,
            FilesystemAuthorizationGrant.subject_type == subject_type,
            FilesystemAuthorizationGrant.subject_id == str(subject_id),
            FilesystemAuthorizationGrant.scope == USER_SANDBOX_SCOPE,
            FilesystemAuthorizationGrant.permission == READ_WRITE,
            FilesystemAuthorizationGrant.revoked_at.is_(None),
            (FilesystemAuthorizationGrant.expires_at.is_(None)
             | (FilesystemAuthorizationGrant.expires_at > current)),
        )
        .order_by(FilesystemAuthorizationGrant.id.desc())
    )


async def resolve_filesystem_policy(
    db: AsyncSession,
    user_id,
    *,
    subject_type: str = SUBJECT_SESSION,
    subject_id: int | str | None = None,
) -> FilesystemPolicy:
    """统一解析主体的文件系统策略；调用方应在异常时 fail closed。"""
    normalized_id = str(subject_id) if subject_id is not None else None
    if normalized_id is None:
        return FilesystemPolicy(subject_type=subject_type, subject_id=normalized_id)
    if subject_type == SUBJECT_SESSION:
        try:
            owner_id = int(normalized_id)
        except (TypeError, ValueError):
            return FilesystemPolicy(subject_type=subject_type, subject_id=normalized_id)
        subject = await get_owned(db, ConversationSession, owner_id, user_id)
        workspace_id = subject.workspace_id if subject else None
        cwd = None
    elif subject_type == SUBJECT_SCHEDULED_TASK:
        try:
            owner_id = int(normalized_id)
        except (TypeError, ValueError):
            return FilesystemPolicy(subject_type=subject_type, subject_id=normalized_id)
        subject = await get_owned(db, ScheduledTask, owner_id, user_id)
        if subject is None or subject.event_id is not None:
            return FilesystemPolicy(subject_type=subject_type, subject_id=normalized_id)
        workspace_id = subject.workspace_id
        cwd = None
    else:
        return FilesystemPolicy(subject_type=subject_type, subject_id=normalized_id)
    if subject is None:
        return FilesystemPolicy(subject_type=subject_type, subject_id=normalized_id)
    if not filesystem_authorization_enabled():
        return FilesystemPolicy(
            subject_type=subject_type, subject_id=normalized_id,
            workspace_id=workspace_id, cwd=cwd,
        )
    grant = None
    expected_grant_id = getattr(subject, "filesystem_authorization_grant_id", None)
    if expected_grant_id is not None:
        candidate = await db.get(FilesystemAuthorizationGrant, expected_grant_id)
        if candidate is not None and candidate.user_id == user_id:
            current = now_utc()
            if (
                candidate.subject_type == subject_type
                and candidate.subject_id == normalized_id
                and candidate.scope == USER_SANDBOX_SCOPE
                and candidate.permission == READ_WRITE
                and candidate.revoked_at is None
                and (candidate.expires_at is None or candidate.expires_at > current)
            ):
                grant = candidate
    elif subject_type == SUBJECT_SESSION:
        grant = await get_active_grant(
            db, user_id, subject_type=subject_type, subject_id=normalized_id,
        )
    if grant is None:
        return FilesystemPolicy(
            subject_type=subject_type, subject_id=normalized_id,
            workspace_id=workspace_id, cwd=cwd,
        )
    return FilesystemPolicy(
        subject_type=subject_type,
        subject_id=normalized_id,
        grant_id=grant.id,
        workspace_read_write=True,
        personal_read_only=False,
        project_read_only=False,
        workspace_id=workspace_id,
        cwd=cwd,
    )


async def grant_session_filesystem_access(
    db: AsyncSession, user_id, session_id: int, *, granted_by: str = "user",
) -> FilesystemAuthorizationGrant:
    """为当前用户的会话授予完整用户沙箱读写权限。"""
    if not filesystem_authorization_enabled():
        raise LookupError("完整用户沙箱授权功能当前未开启")
    session = await get_owned(db, ConversationSession, session_id, user_id)
    if session is None:
        raise LookupError("会话不存在")
    current = now_utc()
    active = await get_active_grant(
        db, user_id, subject_type=SUBJECT_SESSION, subject_id=session_id, now=current,
    )
    if active is not None:
        return active
    grant = FilesystemAuthorizationGrant(
        user_id=user_id,
        subject_type=SUBJECT_SESSION,
        subject_id=str(session_id),
        scope=USER_SANDBOX_SCOPE,
        permission=READ_WRITE,
        granted_by=granted_by if granted_by in {"user", "askuser"} else "user",
        granted_at=current,
    )
    db.add(grant)
    await db.flush()
    _record_authorization_event(
        db, user_id=user_id, subject_type=SUBJECT_SESSION, subject_id=session_id,
        outcome="granted", grant_id=grant.id, source=granted_by,
    )
    return grant


async def revoke_session_filesystem_access(db: AsyncSession, user_id, session_id: int) -> bool:
    """撤销当前会话的全部用户沙箱授权；不删除审计事实。"""
    session = await get_owned(db, ConversationSession, session_id, user_id)
    if session is None:
        raise LookupError("会话不存在")
    from agent.interactions.confirmations import revoke_confirmation

    revoke_confirmation(
        user_id,
        f"允许会话「{session.title or '当前会话'}」读写整个用户沙箱（包含 /workspace、/personal、/project）",
        identity=f"session:filesystem:{session.id}",
    )
    grant = await get_active_grant(db, user_id, subject_type=SUBJECT_SESSION, subject_id=session_id)
    if grant is None:
        return False
    grant.revoked_at = now_utc()
    await db.flush()
    _record_authorization_event(
        db, user_id=user_id, subject_type=SUBJECT_SESSION, subject_id=session_id,
        outcome="revoked", grant_id=grant.id,
    )
    return True


async def grant_scheduled_task_filesystem_access(
    db: AsyncSession, user_id, task_id: int, *, granted_by: str = "user",
) -> FilesystemAuthorizationGrant:
    """为独立定时任务授予完整用户沙箱读写权限。"""
    if not filesystem_authorization_enabled():
        raise LookupError("完整用户沙箱授权功能当前未开启")
    task = await get_owned(db, ScheduledTask, task_id, user_id)
    if task is None or task.event_id is not None:
        raise LookupError("定时任务不存在")
    if task.filesystem_authorization_grant_id is not None:
        current = await db.get(FilesystemAuthorizationGrant, task.filesystem_authorization_grant_id)
        if current is not None and current.revoked_at is None:
            return current
    active = await get_active_grant(
        db, user_id, subject_type=SUBJECT_SCHEDULED_TASK, subject_id=task_id,
    )
    if active is not None:
        task.filesystem_authorization_grant_id = active.id
        await db.flush()
        return active
    current = now_utc()
    grant = FilesystemAuthorizationGrant(
        user_id=user_id,
        subject_type=SUBJECT_SCHEDULED_TASK,
        subject_id=str(task_id),
        scope=USER_SANDBOX_SCOPE,
        permission=READ_WRITE,
        granted_by=granted_by if granted_by in {"user", "askuser"} else "user",
        granted_at=current,
    )
    db.add(grant)
    await db.flush()
    task.filesystem_authorization_grant_id = grant.id
    await db.flush()
    _record_authorization_event(
        db, user_id=user_id, subject_type=SUBJECT_SCHEDULED_TASK, subject_id=task_id,
        outcome="granted", grant_id=grant.id, source=granted_by,
    )
    return grant


async def revoke_scheduled_task_filesystem_access(db: AsyncSession, user_id, task_id: int) -> bool:
    """撤销定时任务的完整用户沙箱权限，保留授权审计记录。"""
    task = await get_owned(db, ScheduledTask, task_id, user_id)
    if task is None or task.event_id is not None:
        raise LookupError("定时任务不存在")
    from agent.interactions.confirmations import revoke_confirmation

    revoke_confirmation(
        user_id,
        f"允许定时任务「{task.name}」读写整个用户沙箱（包含 /workspace、/personal、/project）",
        identity=f"scheduled-task:filesystem:{task.id}",
    )
    grant = (
        await db.get(FilesystemAuthorizationGrant, task.filesystem_authorization_grant_id)
        if task.filesystem_authorization_grant_id is not None else None
    )
    task.filesystem_authorization_grant_id = None
    if grant is None or grant.revoked_at is not None:
        await db.flush()
        return False
    grant.revoked_at = now_utc()
    await db.flush()
    _record_authorization_event(
        db, user_id=user_id, subject_type=SUBJECT_SCHEDULED_TASK, subject_id=task_id,
        outcome="revoked", grant_id=grant.id,
    )
    return True
