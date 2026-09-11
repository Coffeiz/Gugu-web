"""Agent 文件工具共享的 filesystem policy 适配层。

权限事实只在 ``app.services.filesystem_authorization``；本模块只负责把当前
Agent dispatch 主体解析出来，避免 files/trash 各自复制 Session/定时任务判断。

2026-09-11 产品定案：workspace 绑定与完整沙箱授权只约束 Shell（挂载哪些根、
哪个根可写），文件库工具（create/edit/rename/move/copy/delete/回收站/下载落库）
一律不再按 policy 拦截；绑定只作为省略目标时的默认落点。
"""
from __future__ import annotations

from app.services.filesystem_authorization import FilesystemPolicy, resolve_filesystem_policy
from agent.tools.base import (
    current_dispatch_filesystem_subject,
    current_dispatch_session,
    current_dispatch_session_id,
)


async def current_filesystem_policy(db, user_id) -> FilesystemPolicy | None:
    """解析当前工具调用主体；没有 Agent dispatch 上下文时返回 ``None``。

    ``None`` 仅用于直接调用 handler 的单元测试和内部服务复用；真实 registry
    dispatch 总会绑定 Session 或 scheduled-task 主体。
    """
    subject = current_dispatch_filesystem_subject()
    if subject:
        subject_type = str(subject.get("subject_type") or "session")
        subject_id = subject.get("subject_id")
        if subject_id is not None:
            return await resolve_filesystem_policy(
                db, user_id, subject_type=subject_type, subject_id=subject_id,
            )

    session = current_dispatch_session()
    session_id = current_dispatch_session_id()
    if session_id is None and session is not None:
        session_id = getattr(session, "id", None)
    if session_id is None:
        return None
    return await resolve_filesystem_policy(
        db, user_id, subject_type="session", subject_id=session_id,
    )


async def current_workspace_target(db, user_id, policy: FilesystemPolicy | None = None):
    """返回当前主体的 workspace 文件库落点（绑定只决定默认位置，不做写入拦截）。"""
    policy = policy or await current_filesystem_policy(db, user_id)
    if policy is None or policy.workspace_id is None:
        return None
    from app.services.workspaces import resolve_workspace_target
    return await resolve_workspace_target(db, user_id, policy.workspace_id)


def folder_write_space(folder) -> str:
    """文件夹的三值空间：project / workspace / personal（仅用于展示落点）。"""
    if folder.project_id is not None:
        return "project"
    if getattr(folder, "workspace_directory_id", None) is not None:
        return "workspace"
    return "personal"
