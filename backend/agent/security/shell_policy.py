"""Shell 权限与命令风险策略。

策略层不执行命令。执行器、工具注册和 dispatch 都应调用这里的判定，避免权限规则
散落在工具实现中。路径解析和容器限制属于 sandbox 层。
"""
from __future__ import annotations

import re
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import StrEnum

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import ConversationSession, Workspace
from app.services.workspaces import (
    effective_shell_dangerous_enabled,
    effective_shell_enabled,
    effective_shell_system_enabled,
)
from agent.sandbox.docker_runtime import sandbox_readiness


class ShellRisk(StrEnum):
    SAFE = "safe"
    WRITE = "write"
    DANGEROUS = "dangerous"


class ShellScope(StrEnum):
    OFF = "off"
    SANDBOX = "sandbox"
    SYSTEM = "system"


@dataclass(frozen=True)
class ShellDecision:
    allowed: bool
    reason: str
    risk: ShellRisk
    needs_confirmation: bool = False
    workspace_id: int | None = None
    scope: ShellScope = ShellScope.OFF


_DANGEROUS = re.compile(
    r"(^|[;&|()\n])\s*(rm|mv|chmod|chown|kill|pkill|dd|mkfs|shutdown|reboot)\b"
    r"|\b(git\s+(reset|clean)|sudo|doas|curl|wget)\b"
    r"|(?:>|>>|\$\(|`)|\b(?:drop|delete|truncate)\b",
    re.IGNORECASE,
)
_WRITE = re.compile(r"(^|[;&|()\n])\s*(mkdir|touch|cp|python|pytest|npm|pnpm|git)\b", re.IGNORECASE)
_SESSION_LOCKS: dict[int, asyncio.Lock] = {}


def _get_session_lock(session_id: int) -> asyncio.Lock:
    lock = _SESSION_LOCKS.get(session_id)
    if lock is None:
        lock = asyncio.Lock()
        _SESSION_LOCKS[session_id] = lock
    return lock


@asynccontextmanager
async def session_shell_lock(session_id: int | None):
    """串行化同一会话的工作区绑定和 Shell 执行。"""
    if not session_id:
        yield
        return
    async with _get_session_lock(int(session_id)):
        yield


def classify_command(command: str) -> ShellRisk:
    """按整条命令分类，避免只看第一个 token 绕过风险门。"""
    text = (command or "").strip()
    if not text:
        return ShellRisk.SAFE
    if _DANGEROUS.search(text):
        return ShellRisk.DANGEROUS
    if _WRITE.search(text):
        return ShellRisk.WRITE
    return ShellRisk.SAFE


async def evaluate(
    db: AsyncSession,
    user_id,
    session_id: int | None,
    command: str,
    *,
    confirm: bool = False,
    session: ConversationSession | None = None,
) -> ShellDecision:
    """计算最终 Shell 权限；范围由会话绑定状态派生。"""
    risk = classify_command(command)
    settings = get_settings()
    if not settings.agent.shell_enabled:
        return ShellDecision(False, "管理员未开启 Shell 工具", risk)
    if not session_id:
        return ShellDecision(False, "当前会话不可用", risk)
    if session is None:
        session = await db.get(ConversationSession, session_id)
    if not session or session.user_id != user_id:
        return ShellDecision(False, "会话不存在", risk)
    # Shell 只有 sandbox/system 两种执行后端。会话绑定只改变 sandbox 的挂载目录，
    # 历史 shell_scope 字段不再参与授权，避免旧状态与当前会话绑定分叉。
    scope = ShellScope.SANDBOX
    workspace = None
    if session.workspace_id is not None:
        if not await effective_shell_enabled(db, user_id):
            return ShellDecision(False, "用户未开启 Shell", risk, scope=scope)
        workspace = await db.get(Workspace, session.workspace_id)
        if not workspace or workspace.user_id != user_id or not workspace.enabled:
            return ShellDecision(False, "工作区不存在或已停用", risk, scope=scope)
    elif (
        getattr(settings.agent, "shell_system_enabled", False)
        and getattr(getattr(settings, "ai", None), "deployment_mode", "cloud") == "local"
        and await effective_shell_system_enabled(db, user_id)
    ):
        scope = ShellScope.SYSTEM
    elif not await effective_shell_enabled(db, user_id):
        return ShellDecision(False, "用户未开启 Shell", risk, scope=scope)

    # sandbox 是容器唯一执行后端；system 是明确授权的本机可信执行器。
    if scope is ShellScope.SANDBOX:
        sandbox = getattr(settings, "sandbox", None)
        if sandbox is not None:
            ready, reason = sandbox_readiness(sandbox)
            if not ready:
                return ShellDecision(False, reason, risk)
    if risk is ShellRisk.DANGEROUS:
        if not get_settings().agent.shell_dangerous_enabled:
            return ShellDecision(False, "管理员未开启危险 Shell 命令", risk, scope=scope)
        if not await effective_shell_dangerous_enabled(db, user_id):
            return ShellDecision(False, "用户未开启危险 Shell 命令", risk, scope=scope)
        if not confirm:
            return ShellDecision(True, "危险命令需要用户确认", risk, True, workspace.id if workspace else None, scope)
    return ShellDecision(True, f"允许在 {scope.value} 范围执行", risk, False, workspace.id if workspace else None, scope)


async def available_for_session(
    db: AsyncSession,
    user_id,
    session_id: int | None,
    *,
    session: ConversationSession | None = None,
) -> bool:
    """判断是否应把 Shell 工具放进本轮模型工具列表。"""
    if not session_id:
        return False
    decision = await evaluate(db, user_id, session_id, "pwd", session=session)
    return decision.allowed and not decision.needs_confirmation
