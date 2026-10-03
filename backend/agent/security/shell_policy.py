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
    workspace_shell_supported,
    resolve_workspace_target,
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
    full_user_sandbox_write: bool = False


async def shell_cwd_mapping(db: AsyncSession, user_id, *, session=None, workspace_id=None) -> str:
    """返回容器 cwd 对应的用户可读文件库位置，不暴露宿主机路径。"""
    effective_workspace_id = workspace_id
    if effective_workspace_id is None and session is not None:
        effective_workspace_id = getattr(session, "workspace_id", None)
    if effective_workspace_id is None:
        return "文件库根目录 / 默认 Workspace"
    try:
        target = await resolve_workspace_target(db, user_id, int(effective_workspace_id))
    except (AttributeError, LookupError, ValueError):
        # 组装层的轻量测试/探测上下文可能没有完整 ORM session；映射只是说明性
        # 元数据，不能因此阻断 Shell 权限提示或执行结果。
        return "当前绑定 Workspace"
    if not target:
        return "当前绑定 Workspace（目录暂不可解析）"
    if target.get("space") == "project":
        label = f"项目文件 / {target.get('project_name') or target.get('workspace_name') or '当前项目'}"
    elif target.get("space") == "workspace":
        label = f"Workspace / {target.get('workspace_name') or '当前工作区'}"
    else:
        label = f"个人文件 / {target.get('folder_name') or target.get('workspace_name') or '当前文件夹'}"
    return label


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
    """串行化普通调用的工作区绑定和 Shell 执行；并行 Round 由调度上限控制。"""
    if not session_id:
        yield
        return
    from agent.tools.base import current_dispatch_is_parallel
    if current_dispatch_is_parallel():
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
    if scope is ShellScope.SANDBOX:
        if sandbox is not None and not getattr(sandbox, "enabled", False):
            return ShellDecision(False, "Shell 沙盒未开启", risk)
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
    if scope is ShellScope.SYSTEM:
        if subject_type == SUBJECT_SCHEDULED_TASK:
            return ShellDecision(False, "定时任务只能在 sandbox 范围执行", risk, scope=scope)
        if not (
            getattr(settings.agent, "shell_system_enabled", False)
            and await effective_shell_system_enabled(db, user_id)
        ):
            return ShellDecision(False, "用户未开启 system 范围 Shell", risk, scope=scope)
    elif (
        (session is not None and session.workspace_id is not None or workspace_id is not None)
        and not workspace_shell_supported()
    ):
        return ShellDecision(False, "OSS 存储模式不支持 workspace，只能使用独立 Shell 沙盒", risk, scope=scope)
    elif subject_type == SUBJECT_SCHEDULED_TASK:
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
        if workspace_id is None and not full_user_sandbox_write and settings.storage.backend != "oss":
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
    if risk is ShellRisk.DANGEROUS:
        if not get_settings().agent.shell_dangerous_enabled:
            return ShellDecision(False, "管理员未开放全部 Shell 命令", risk, scope=scope)
        if not await effective_shell_dangerous_enabled(db, user_id):
            return ShellDecision(False, "用户未开放全部 Shell 命令", risk, scope=scope)
        if not confirm:
            return ShellDecision(
                True, "危险命令需要用户确认", risk, True,
                workspace.id if workspace else None, scope,
                full_user_sandbox_write=full_user_sandbox_write,
            )
    return ShellDecision(
        True, f"允许在 {scope.value} 范围执行", risk, False,
        workspace.id if workspace else None, scope, full_user_sandbox_write,
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

    调用方将结果放入本轮 system prompt 的固定位置，不写入 snapshot 或持久化历史。
    ``evaluate`` 仍是唯一权限事实源；提示词不是授权凭据，执行器逐调用复核。
    危险探针只用于分类和判权，从不交给执行器。
    未通过安全命令探测时返回 ``None``，调用方也不应注册 Shell 工具。
    """
    settings = get_settings()
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
        "- 复合命令：`&&`、`||`、`;`、`|` 可直接使用；重定向（`>` `>>`）和命令替换"
        "（`$(...)`、反引号）属于危险操作，必须确认后执行。",
    ]
    lines.append('- 默认范围：省略 scope 时使用 sandbox 容器；开放系统范围不会自动切换执行环境。')
    if subject_type != SUBJECT_SCHEDULED_TASK and settings.agent.shell_system_enabled:
        system = await evaluate(
            db, user_id, session_id, "pwd", session=session,
            requested_scope=ShellScope.SYSTEM,
            subject_type=subject_type, subject_id=subject_id,
        )
        if system.allowed:
            confirmation = "仍需执行器确认" if system.needs_confirmation else "执行器仍会逐调用校验"
            lines.append(
                '- 系统范围：管理员与用户双侧已开放；用户明确要求检查系统环境时，'
                f'显式传 scope="system"，{confirmation}。无需从沙盒逃逸，也不要用 /proc 或 nsenter 绕过隔离。'
            )
        else:
            lines.append('- 系统范围：本轮策略未放行；不得从 sandbox 绕过隔离访问系统环境。')
    else:
        lines.append('- 系统范围：未开放或当前为定时任务；不得从 sandbox 绕过隔离。')
    lines.append(
        '- system 的含义：应用服务所在的本机执行环境；非容器部署通常是服务器，'
        '容器部署仍是应用容器，不保证访问 Docker 宿主机，也不代表 root 权限；实际范围以工具回执为准。'
    )
    cwd_mapping = await shell_cwd_mapping(
        db, user_id, session=session, workspace_id=workspace_id,
    )
    lines.append(f"- 当前工作目录映射：{cwd_mapping}；项目和文件夹沿用 /project 或 /personal 的规范路径，独立工作区位于 /workspace 下。")
    # /personal、/project 的挂载与可写性由完整用户沙箱授权决定；这里必须显式声明，
    # 否则静态 shell.md 要求模型「以本轮权限状态为准」，但状态里从没写过这两件事，
    # 模型只能靠用户的话猜自己有没有写权限（2026-09-11 修复）。
    if getattr(getattr(settings, "storage", None), "backend", "local") != "oss":
        if safe.full_user_sandbox_write:
            lines.append(
                "- /personal、/project：本轮已按可读写挂载（完整用户沙箱授权生效），"
                "可直接在其中创建、修改和删除文件。"
            )
        else:
            lines.append(
                "- /personal、/project：本轮以只读方式挂载。要写入（新建、修改、删除）需先获得"
                "本轮完整用户沙箱授权；未授权时不要反复重试同一写入命令，也不要换路径或换工具绕过只读。"
            )
    if dangerous_enabled:
        lines.append(
            "- 全部 Shell 命令：已开放，但不是预授权；删除、覆盖、移动、提权、服务控制、"
            "网络下载等危险操作仍必须经过执行器确认。"
        )
    else:
        lines.append(
            "- 全部 Shell 命令：未开放；只允许读取、检查和普通安全命令，禁止删除、覆盖、移动、"
            "提权、服务控制、网络下载等危险操作，也不要向用户索要确认后继续。"
        )
    from agent.interactions.automatic_mode import is_automatic_mode_enabled
    if is_automatic_mode_enabled():
        lines.append(
            "- 自动模式：已开启；仅当执行器明确判定满足条件时才可能跳过确认门，"
            "仍受沙盒、范围、配额和审计限制，不能视为无限权限。"
        )
    else:
        lines.append(
            "- 自动模式：未开启；危险操作不能跳过执行器确认门。"
        )
    if subject_type == SUBJECT_SCHEDULED_TASK:
        lines.append("- 当前是定时任务；不支持交互式确认，需要确认的危险操作不得执行。")
    if getattr(getattr(settings, "storage", None), "backend", "local") == "oss":
        lines.extend([
            "- OSS 存储模式：本轮 Shell 只使用独立沙盒 /workspace；/personal、/project 和 workspace 绑定不可用。",
            "- OSS 文件库不会自动挂载、下载、同步或生成 File 记录；需要处理文件时必须走明确的文件库 API 操作。",
        ])
    prompt = "\n".join(lines)
    try:
        from agent.runtime.loopscope_trace.context import record_shell_prompt_sources
        record_shell_prompt_sources(prompt, code_target=build_dynamic_prompt)
    except Exception:
        pass
    return prompt
