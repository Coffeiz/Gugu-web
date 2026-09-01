"""共享协作终端的访问判定。

终端页面只复用 Shell 的有效权限，不创建第二套工具开关。终端真正执行命令
时仍必须回到 ``shell_policy.evaluate``，本模块只负责终端层的访问边界。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from sqlalchemy.ext.asyncio import AsyncSession

from agent.security.shell_policy import available_for_session, evaluate
from agent.sandbox.docker_runtime import sandbox_readiness
from app.core.config import get_settings
from app.core.ownership import get_owned
from app.models import ConversationSession
from app.services.workspaces import (
    effective_shell_enabled,
    effective_shell_system_enabled,
)


class TerminalOperation(StrEnum):
    VIEW = "view"
    INPUT = "input"
    TERMINATE = "terminate"
    DELETE = "delete"
    REOPEN = "reopen"
    RESET = "reset"


@dataclass(frozen=True)
class TerminalAccessDecision:
    allowed: bool
    reason: str
    operation: TerminalOperation


async def page_access(db: AsyncSession, user_id) -> TerminalAccessDecision:
    """判断用户是否可以看到终端页面入口。

    页面可见性只判断有效 Shell capability，不要求已有工作区；没有工作区时由
    后续页面显示绑定提示。Admin 总开关关闭时始终隐藏。
    """
    operation = TerminalOperation.VIEW
    settings = get_settings()
    sandbox = getattr(settings, "sandbox", None)
    if sandbox is None:
        return TerminalAccessDecision(False, "Shell 沙盒未开启", operation)
    sandbox_ready, sandbox_reason = sandbox_readiness(sandbox)
    if not sandbox_ready:
        return TerminalAccessDecision(False, sandbox_reason, operation)
    if not getattr(settings.agent, "shell_enabled", False):
        return TerminalAccessDecision(False, "管理员未开启 Shell 工具", operation)
    if await effective_shell_enabled(db, user_id):
        return TerminalAccessDecision(True, "允许访问终端", operation)
    if (
        getattr(settings.agent, "shell_system_enabled", False)
        and await effective_shell_system_enabled(db, user_id)
    ):
        return TerminalAccessDecision(True, "允许访问终端", operation)
    return TerminalAccessDecision(False, "用户未开启 Shell", operation)


async def authorize_operation(
    db: AsyncSession,
    user_id,
    *,
    owner_id,
    session_id: int | None,
    workspace_id: int | None = None,
    operation: TerminalOperation,
) -> TerminalAccessDecision:
    """校验终端操作的用户归属和 Shell 能力。

    终止/删除操作在 Shell 权限被撤销后仍允许 owner 清理自己的会话，避免权限
    撤销后留下无法关闭的孤儿终端；用户输入和查看仍要求当前 Shell capability。
    """
    if str(owner_id) != str(user_id):
        return TerminalAccessDecision(False, "终端不存在", operation)
    session = None
    if session_id is not None:
        session = await get_owned(db, ConversationSession, session_id, user_id)
        if session is None:
            return TerminalAccessDecision(False, "终端会话不存在", operation)
    if operation in {TerminalOperation.DELETE, TerminalOperation.TERMINATE, TerminalOperation.RESET}:
        return TerminalAccessDecision(True, "允许清理终端", operation)
    if operation is TerminalOperation.REOPEN:
        return await page_access(db, user_id)
    if operation is TerminalOperation.VIEW:
        return await page_access(db, user_id)
    if operation is TerminalOperation.INPUT:
        if not (await page_access(db, user_id)).allowed:
            return TerminalAccessDecision(False, "Shell 权限不可用", operation)
        if session is None:
            decision = await evaluate(db, user_id, None, "pwd", workspace_id=workspace_id)
            if not decision.allowed:
                return TerminalAccessDecision(False, "当前终端没有可用的 Shell 执行范围", operation)
            return TerminalAccessDecision(True, "允许向终端输入", operation)
        if not await available_for_session(db, user_id, session_id, session=session):
            return TerminalAccessDecision(False, "当前会话没有可用的 Shell 执行范围", operation)
        return TerminalAccessDecision(True, "允许向终端输入", operation)
    return TerminalAccessDecision(False, "终端操作不受支持", operation)
