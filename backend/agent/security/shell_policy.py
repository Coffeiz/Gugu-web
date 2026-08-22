"""Shell 权限与命令风险策略。

策略层不执行命令。执行器、工具注册和 dispatch 都应调用这里的判定，避免权限规则
散落在工具实现中。路径解析和容器限制属于 sandbox 层。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import ConversationSession, Workspace
from app.services.workspaces import effective_shell_enabled


class ShellRisk(StrEnum):
    SAFE = "safe"
    WRITE = "write"
    DANGEROUS = "dangerous"


@dataclass(frozen=True)
class ShellDecision:
    allowed: bool
    reason: str
    risk: ShellRisk
    needs_confirmation: bool = False
    workspace_id: int | None = None


_DANGEROUS = re.compile(
    r"(^|[;&|()\n])\s*(rm|mv|chmod|chown|kill|pkill|dd|mkfs|shutdown|reboot)\b"
    r"|\b(git\s+(reset|clean)|sudo|doas|curl|wget)\b"
    r"|(?:>|>>|\$\(|`)|\b(?:drop|delete|truncate)\b",
    re.IGNORECASE,
)
_WRITE = re.compile(r"(^|[;&|()\n])\s*(mkdir|touch|cp|python|pytest|npm|pnpm|git)\b", re.IGNORECASE)


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
) -> ShellDecision:
    """计算最终 Shell 权限；不满足任一层时拒绝，不自动猜测工作区。"""
    risk = classify_command(command)
    if not get_settings().agent.shell_enabled:
        return ShellDecision(False, "管理员未开启 Shell 工具", risk)
    if not await effective_shell_enabled(db, user_id):
        return ShellDecision(False, "用户未开启 Shell 工具", risk)
    if not session_id:
        return ShellDecision(False, "当前会话未绑定工作区", risk)
    session = await db.get(ConversationSession, session_id)
    if not session or session.user_id != user_id or not session.workspace_id:
        return ShellDecision(False, "当前会话未绑定工作区", risk)
    workspace = await db.get(Workspace, session.workspace_id)
    if not workspace or workspace.user_id != user_id or not workspace.enabled:
        return ShellDecision(False, "工作区不存在或已停用", risk)
    if risk is ShellRisk.DANGEROUS and not confirm:
        return ShellDecision(True, "危险命令需要用户确认", risk, True, workspace.id)
    return ShellDecision(True, "允许在当前工作区执行", risk, False, workspace.id)
