"""Shell 权限与命令风险策略。

策略层不执行命令。执行器、工具注册和 dispatch 都应调用这里的判定，避免权限规则
散落在工具实现中。路径解析和容器限制属于 sandbox 层。
"""
from __future__ import annotations

import re
import asyncio
import shlex
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import StrEnum

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import ConversationSession, Workspace
from app.services.workspaces import (
    effective_shell_dangerous_enabled,
    effective_shell_enabled,
    effective_shell_autopilot_enabled,
    effective_shell_system_enabled,
)
from app.services.filesystem_authorization import (
    SUBJECT_SCHEDULED_TASK,
    SUBJECT_SESSION,
    resolve_filesystem_policy,
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
    autopilot_enabled: bool = False
    full_user_sandbox_write: bool = False


_DANGEROUS = re.compile(
    r"(^|[;&|()\n])\s*(rm|mv|chmod|chown|kill|pkill|dd|mkfs|shutdown|reboot)\b"
    r"|\b(git\s+(reset|clean)|sudo|doas|curl|wget)\b"
    r"|(?:>|>>|\$\(|`)|\b(?:drop|delete|truncate)\b",
    re.IGNORECASE,
)
_WRITE = re.compile(r"(^|[;&|()\n])\s*(mkdir|touch|cp|python|pytest|npm|pnpm|git)\b", re.IGNORECASE)
_RUNTIME_NAMES = frozenset({"node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "pip", "pip3", "uv", "pytest", "py"})
_RUNTIME_WRAPPERS = frozenset({"env", "command", "exec"})
_SHELL_WRAPPERS = frozenset({"sh", "bash", "zsh", "dash"})
_PYTHON_RUNTIME = re.compile(r"^python(?:\d+(?:\.\d+)*)?$")
_SESSION_LOCKS: dict[int, asyncio.Lock] = {}


def _runtime_name(argv: list[str]) -> str | None:
    """从单条 argv 中识别直接或 Shell wrapper 调用的代码运行时。"""
    if not argv:
        return None
    executable = argv[0].rsplit("/", 1)[-1].lower()
    if executable in _RUNTIME_NAMES or _PYTHON_RUNTIME.fullmatch(executable):
        return executable
    if executable in _RUNTIME_WRAPPERS:
        index = 1
        while index < len(argv) and (argv[index].startswith("-") or "=" in argv[index]):
            index += 1
        return _runtime_name(argv[index:])
    if executable in _SHELL_WRAPPERS:
        for index, value in enumerate(argv[1:], start=1):
            if value in {"-c", "-lc", "--command"} and index + 1 < len(argv):
                return _runtime_name(shlex.split(argv[index + 1], posix=True))
    return None


def blocked_runtime(command: str) -> str | None:
    """返回命令中的代码运行时；解析失败时交由既有命令校验处理。"""
    try:
        return _runtime_name(shlex.split((command or "").strip(), posix=True))
    except ValueError:
        return None


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
    workspace_id: int | None = None,
    requested_scope: ShellScope | str | None = None,
    subject_type: str = SUBJECT_SESSION,
    subject_id: int | str | None = None,
) -> ShellDecision:
    """计算最终 Shell 权限；Session 与定时任务使用各自的文件系统主体。"""
    risk = classify_command(command)
    settings = get_settings()
    try:
        scope = ShellScope(requested_scope or ShellScope.SANDBOX)
    except ValueError:
        return ShellDecision(False, "Shell 范围无效，只能是 sandbox 或 system", risk)
    if not settings.agent.shell_enabled:
        return ShellDecision(False, "管理员未开启 Shell 工具", risk)
    sandbox = getattr(settings, "sandbox", None)
    if sandbox is not None and not getattr(sandbox, "enabled", False):
        return ShellDecision(False, "Shell 沙盒未开启", risk)
    if scope is ShellScope.SANDBOX and sandbox is not None and not getattr(sandbox, "code_execution_enabled", True):
        runtime = blocked_runtime(command)
        if runtime is not None:
            return ShellDecision(False, f"管理员未开启代码运行环境，禁止使用 {runtime} 运行时", risk, scope=scope)
    if subject_id is None and subject_type == SUBJECT_SESSION:
        subject_id = session_id
    if session_id and session is None:
        session = await db.get(ConversationSession, session_id)
    if session_id and (not session or session.user_id != user_id):
        return ShellDecision(False, "会话不存在", risk)
    full_user_sandbox_write = False
    # scope 在本轮调用开始时固定。默认只能进 sandbox，system 必须由调用方显式选择，
    # 防止权限配置或会话状态在连续调用之间把执行器从容器漂移到宿主机。
    workspace = None
    filesystem_policy = None
    if subject_type == SUBJECT_SCHEDULED_TASK:
        if scope is ShellScope.SYSTEM:
            return ShellDecision(False, "定时任务只能在 sandbox 范围执行", risk, scope=scope)
        if not await effective_shell_enabled(db, user_id):
            return ShellDecision(False, "用户未开启 Shell", risk, scope=scope)
        try:
            filesystem_policy = await resolve_filesystem_policy(
                db, user_id, subject_type=subject_type, subject_id=subject_id,
            )
        except Exception:
            return ShellDecision(False, "用户沙箱授权状态暂时不可用", risk, scope=scope)
        full_user_sandbox_write = filesystem_policy.full_user_sandbox
        task_workspace_id = filesystem_policy.workspace_id
        if workspace_id is not None and workspace_id != task_workspace_id:
            return ShellDecision(False, "定时任务只能使用其绑定的工作区", risk, scope=scope)
        workspace_id = task_workspace_id
        # 没有 workspace 且没有完整沙箱授权的任务不应获得一个隐含的共享
        # /workspace；scheduler 也只会在这两种显式条件下注册 shell 工具。
        if workspace_id is None and not full_user_sandbox_write:
            return ShellDecision(False, "定时任务未绑定工作区或获得完整沙箱授权", risk, scope=scope)
        if workspace_id is not None:
            workspace = await db.get(Workspace, workspace_id)
            if not workspace or workspace.user_id != user_id or not workspace.enabled:
                return ShellDecision(False, "工作区不存在或已停用", risk, scope=scope)
    elif session is not None and session.workspace_id is not None:
        if scope is ShellScope.SYSTEM:
            return ShellDecision(False, "绑定工作区只能在 sandbox 范围执行", risk, scope=scope)
        workspace_id = session.workspace_id
        if not await effective_shell_enabled(db, user_id):
            return ShellDecision(False, "用户未开启 Shell", risk, scope=scope)
        workspace = await db.get(Workspace, workspace_id)
        if not workspace or workspace.user_id != user_id or not workspace.enabled:
            return ShellDecision(False, "工作区不存在或已停用", risk, scope=scope)
    elif workspace_id is not None:
        if not await effective_shell_enabled(db, user_id):
            return ShellDecision(False, "用户未开启 Shell", risk, scope=scope)
        workspace = await db.get(Workspace, workspace_id)
        if not workspace or workspace.user_id != user_id or not workspace.enabled:
            return ShellDecision(False, "工作区不存在或已停用", risk, scope=scope)
    elif scope is ShellScope.SYSTEM:
        if not (
            getattr(settings.agent, "shell_system_enabled", False)
            and await effective_shell_system_enabled(db, user_id)
        ):
            return ShellDecision(False, "用户未开启 system 范围 Shell", risk, scope=scope)
    elif not await effective_shell_enabled(db, user_id):
        return ShellDecision(False, "用户未开启 Shell", risk, scope=scope)

    # sandbox 是容器唯一执行后端；system 是明确授权的本机可信执行器。
    if scope is ShellScope.SANDBOX:
        sandbox = getattr(settings, "sandbox", None)
        if sandbox is not None:
            ready, reason = sandbox_readiness(sandbox)
            if not ready:
                return ShellDecision(False, reason, risk)
        if filesystem_policy is None and subject_type == SUBJECT_SESSION and session_id and hasattr(db, "execute"):
            try:
                filesystem_policy = await resolve_filesystem_policy(
                    db, user_id, subject_type=SUBJECT_SESSION, subject_id=session_id,
                )
            except Exception:
                # 授权事实源不可读时拒绝执行，不能把数据库故障解释为默认放行。
                return ShellDecision(False, "用户沙箱授权状态暂时不可用", risk, scope=scope)
            full_user_sandbox_write = filesystem_policy.full_user_sandbox
    autopilot_enabled = (
        bool(getattr(settings.agent, "shell_autopilot_enabled", False))
        and await effective_shell_autopilot_enabled(db, user_id)
    )
    if risk is ShellRisk.DANGEROUS:
        if not get_settings().agent.shell_dangerous_enabled:
            return ShellDecision(False, "管理员未开启危险 Shell 命令", risk, scope=scope)
        if not await effective_shell_dangerous_enabled(db, user_id):
            return ShellDecision(False, "用户未开启危险 Shell 命令", risk, scope=scope)
        if not confirm and not autopilot_enabled:
            return ShellDecision(
                True, "危险命令需要用户确认", risk, True,
                workspace.id if workspace else None, scope,
                full_user_sandbox_write=full_user_sandbox_write,
            )
    return ShellDecision(
        True, f"允许在 {scope.value} 范围执行", risk, False,
        workspace.id if workspace else None, scope, autopilot_enabled,
        full_user_sandbox_write,
    )


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


async def build_dynamic_prompt(
    db: AsyncSession,
    user_id,
    session_id: int | None,
    *,
    session: ConversationSession | None = None,
    workspace_id: int | None = None,
    subject_type: str = SUBJECT_SESSION,
    subject_id: int | str | None = None,
) -> str | None:
    """按本轮有效策略生成 Shell 状态提示。

    这段文字只应追加到本轮 system prompt，不得进入 snapshot 或 canonical history。
    ``evaluate`` 仍是唯一权限事实源；危险探针只用于分类和判权，从不交给执行器。
    未通过安全命令探测时返回 ``None``，调用方也不应注册 Shell 工具。
    """
    safe = await evaluate(
        db,
        user_id,
        session_id,
        "pwd",
        session=session,
        workspace_id=workspace_id,
        subject_type=subject_type,
        subject_id=subject_id,
    )
    if not safe.allowed or safe.needs_confirmation:
        return None

    dangerous = await evaluate(
        db,
        user_id,
        session_id,
        "rm -rf __gugu_shell_policy_probe__",
        session=session,
        workspace_id=workspace_id,
        subject_type=subject_type,
        subject_id=subject_id,
    )
    dangerous_enabled = dangerous.allowed
    lines = [
        "## 本轮 Shell 权限状态（动态）",
        "以下状态只代表本轮执行器返回的有效权限，下一轮必须重新读取，不能从历史消息推断。",
        "- Shell：已授权；本轮已注册 Shell 工具。",
    ]
    if dangerous_enabled:
        lines.append(
            "- 危险 Shell：已开启，但不是预授权；删除、覆盖、移动、提权、服务控制、"
            "网络下载等危险操作仍必须经过执行器确认。"
        )
    else:
        lines.append(
            "- 危险 Shell：未开启；只允许读取、检查和普通安全命令，禁止删除、覆盖、移动、"
            "提权、服务控制、网络下载等危险操作，也不要向用户索要确认后继续。"
        )
    if safe.autopilot_enabled:
        lines.append(
            "- Autopilot：已开启；仅当执行器明确判定满足条件时才可能跳过确认门，"
            "仍受沙盒、范围、配额和审计限制，不能视为无限权限。"
        )
    else:
        lines.append(
            "- Autopilot：未开启；危险操作不能跳过执行器确认门。"
        )
    if subject_type == SUBJECT_SCHEDULED_TASK:
        lines.append("- 当前是定时任务；不支持交互式确认，需要确认的危险操作不得执行。")
    return "\n".join(lines)
