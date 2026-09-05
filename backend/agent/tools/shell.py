"""工作区 Shell 工具：只在权限已满足的当前会话工作区内执行。"""
from __future__ import annotations

import json
import logging
import re
import shlex
import time
from pathlib import Path, PurePosixPath

import app.db.session as _db_session

from agent.security import confirm
from agent.security.logsafe import fingerprint
from agent.security.shell_policy import evaluate, session_shell_lock
from agent.tools.base import (
    current_dispatch_filesystem_subject,
    current_dispatch_run_id,
    current_dispatch_session,
    current_dispatch_session_id,
)
from agent.tools.filesystem_policy import current_filesystem_policy
from agent.sandbox import LocalWorkspaceExecutor
from agent.sandbox.docker_runtime import sandbox_readiness, valid_egress_network_name, valid_egress_proxy
from agent.sandbox.quota import measure_directory, snapshot_quota
from agent.sandbox.client import SandboxdClient, SandboxdUnavailable
from agent.sandbox.protocol import ExecuteRequest
from app.core.config import get_settings
from agent.tools.base import BaseSkill, Tool
from app.services.workspaces import resolve_project_root, resolve_shell_root, resolve_user_personal_root
from app.services.storage.quota_ledger import SHELL_PERSISTENT, record_usage, reconcile_user_storage

logger = logging.getLogger(__name__)


_SHELL_LEASE_OPERATION = re.compile(
    r"\b(?:curl|wget|python|pytest|node|npm|pnpm|yarn|pip|git|make|sh|bash|zsh|"
    r"perl|ruby)\b|[|><]",
    re.IGNORECASE,
)
_SHELL_LEASE_BLOCKERS = re.compile(
    r"\b(?:rm|mv|chmod|chown|kill|pkill|dd|mkfs|shutdown|reboot|sudo|doas)\b"
    r"|\bgit\s+(?:reset|clean)\b|\b(?:drop|delete|truncate)\b",
    re.IGNORECASE,
)


def _can_use_shell_lease(command: str) -> bool:
    """给受限 Shell 操作复用短期授权，但保留不可逆操作的单次确认。"""
    text = (command or "").strip()
    return bool(_SHELL_LEASE_OPERATION.search(text)) and not _SHELL_LEASE_BLOCKERS.search(text)


def _audit(**fields) -> None:
    logger.info("shell_audit %s", json.dumps(fields, ensure_ascii=False, sort_keys=True))


async def _shell(db, user_id, args: dict):
    session_id = args.get("_session_id")
    started = time.monotonic()
    risk = "unknown"
    workspace_id = None
    scope = None
    terminal_id = None
    result = None
    event = "completed"
    try:
        if args.get("_terminal_parallel"):
            result = await _run_shell(db, user_id, args)
        else:
            async with session_shell_lock(session_id):
                result = await _run_shell(db, user_id, args)
    except Exception:
        event = "failed"
        raise
    finally:
        if isinstance(result, dict):
            risk = result.pop("_risk", risk)
            workspace_id = result.pop("_workspace_id", None)
            scope = result.pop("_scope", None)
            terminal_id = result.pop("_terminal_id", None)
            event = result.pop("_audit_event", event)
        _audit(
            event=event,
            user_id=fingerprint(str(user_id)),
            session_id=session_id,
            workspace_id=workspace_id,
            scope=scope,
            risk=risk,
            ok=result.get("ok") if isinstance(result, dict) else False,
            exit_code=result.get("exit_code") if isinstance(result, dict) else None,
            timed_out=result.get("timed_out", False) if isinstance(result, dict) else False,
            permission_revoked=result.get("permission_revoked", False) if isinstance(result, dict) else False,
            truncated=result.get("truncated", False) if isinstance(result, dict) else False,
            cwd_fingerprint=fingerprint(result.get("cwd", "")) if isinstance(result, dict) and result.get("cwd") else None,
            duration_ms=round((time.monotonic() - started) * 1000, 2),
            terminal_id=terminal_id,
        )
    return result


async def _run_shell(db, user_id, args: dict):
    command = str(args.get("command") or "").strip()
    on_output = args.get("_on_output")
    session_id = args.get("_session_id")
    filesystem_subject = current_dispatch_filesystem_subject() or {}
    subject_type = str(filesystem_subject.get("subject_type") or "session")
    subject_id = filesystem_subject.get("subject_id")
    requested_workspace_id = (
        filesystem_subject.get("workspace_id")
        if subject_type == "scheduled_task"
        else args.get("_workspace_id")
    )
    requested_cwd = (
        args.get("cwd")
        if args.get("cwd") not in (None, "")
        else filesystem_subject.get("cwd") or "."
    )
    network_profile = str(args.get("network") or "none").strip().lower()
    if network_profile not in {"none", "egress"}:
        return {"error": "network 只能是 none 或 egress", "_audit_event": "rejected"}
    # 模型传入的 confirm 一律不采信：policy 判定永远按未确认进行，
    # 只有服务端 grant 命中（confirm.needs_confirmation 内部检查）才视为已确认。
    decision = await evaluate(
        db, user_id, session_id, command, confirm=False,
        session=current_dispatch_session(),
        workspace_id=requested_workspace_id,
        requested_scope=args.get("scope"),
        subject_type=subject_type,
        subject_id=subject_id,
    )
    if not decision.allowed:
        return {"error": decision.reason, "_risk": decision.risk.value, "_audit_event": "denied"}
    if subject_type == "scheduled_task" and (network_profile == "egress" or decision.needs_confirmation):
        return {
            "error": "定时任务只能执行无需交互确认的 sandbox 命令",
            "_risk": decision.risk.value,
            "_workspace_id": decision.workspace_id,
            "_scope": decision.scope.value,
            "_audit_event": "denied",
        }
    if network_profile == "egress":
        if decision.scope.value != "sandbox":
            return {"error": "临时 egress 只支持沙盒范围，system 请使用宿主机自身网络策略", "_risk": decision.risk.value, "_scope": decision.scope.value, "_audit_event": "denied"}
        sandbox_settings = get_settings().sandbox
        if not valid_egress_proxy(getattr(sandbox_settings, "egress_proxy_url", "")):
            return {"error": "临时 egress 尚未配置受控 HTTP(S) 代理", "_risk": decision.risk.value, "_scope": decision.scope.value, "_audit_event": "denied"}
        if not getattr(sandbox_settings, "egress_isolation_enabled", False):
            return {"error": "受控 egress 网络尚未启用，当前沙盒保持断网", "_risk": decision.risk.value, "_scope": decision.scope.value, "_audit_event": "denied"}
        if not valid_egress_network_name(getattr(sandbox_settings, "egress_network_name", "")):
            return {"error": "受控 egress Docker 网络名无效，当前沙盒保持断网", "_risk": decision.risk.value, "_scope": decision.scope.value, "_audit_event": "denied"}
    egress_authorized = False
    egress_expires_at = None
    if network_profile == "egress":
        egress_ttl = int(getattr(get_settings().sandbox, "egress_ttl_seconds", 600))
        if not decision.autopilot_enabled:
            blocked = confirm.needs_confirmation(
                args,
                "允许当前会话在沙盒内临时访问公网（仅通过受控代理，有效期10分钟）",
                user_id,
                identity=f"shell:egress:{session_id}:{decision.workspace_id or 'user'}",
                ttl_minutes=max(1, (egress_ttl + 59) // 60),
                instruction=(
                    "这是当前会话的临时沙盒联网授权，只允许通过受控代理访问公网，"
                    "有效期10分钟；请把授权范围告知用户，用户在界面确认后直接再次调用即可，无需携带凭证。"
                ),
            )
            if blocked is not None:
                return {"error": blocked, "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "confirmation_required"}
        egress_authorized = True
        egress_expires_at = time.time() + egress_ttl
    if decision.needs_confirmation and not (egress_authorized and _can_use_shell_lease(command)):
        shell_lease = _can_use_shell_lease(command)
        confirmation_summary = (
            f"允许当前会话在 {decision.scope.value} 范围执行受限 Shell 操作（30分钟）"
            if shell_lease
            else f"将在当前工作区执行危险命令：{command}"
        )
        confirmation_identity = (
            f"shell:operation:{session_id}:{decision.scope.value}"
            if shell_lease else None
        )
        blocked = confirm.needs_confirmation(
            args,
            confirmation_summary,
            user_id,
            identity=confirmation_identity,
            ttl_minutes=30 if shell_lease else 5,
            instruction=(
                "这是当前会话的受限 Shell 操作授权，有效期 30 分钟；"
                "请把授权范围告知用户，用户在界面确认后直接再次调用即可，无需携带凭证。"
                if shell_lease else None
            ),
        )
        if blocked is not None:
            return {"error": blocked, "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_audit_event": "confirmation_required"}

    root = await resolve_shell_root(db, user_id, decision.scope.value, decision.workspace_id)
    if root is None:
        return {"error": "当前 Shell 范围没有可用的本地目录，未执行命令", "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "denied"}
    personal_root = await resolve_user_personal_root(db, user_id) if decision.scope.value == "sandbox" else None
    project_root = await resolve_project_root(db, user_id) if decision.scope.value == "sandbox" else None
    quota_root = None
    quota_bytes = None
    quota_before = None
    if decision.scope.value == "sandbox":
        sandbox_settings = get_settings().sandbox
        ready, reason = sandbox_readiness(sandbox_settings)
        if not ready:
            return {"error": reason, "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "denied"}
        # 文件库/项目工作区沿用文件服务自己的存储配额；只有未绑定 workspace
        # 时才检查独立 Shell 持久目录，避免把项目文件误计入 Shell 配额。
        if decision.workspace_id is None:
            await reconcile_user_storage(db, user_id)
            quota = snapshot_quota(root, sandbox_settings.persistent_quota_bytes)
            quota_before = quota.used_bytes
            if quota.exceeded:
                return {
                    "error": "Shell 持久空间已超过配额，请先清理文件后再执行命令",
                    "_risk": decision.risk.value,
                    "_scope": decision.scope.value,
                    "_audit_event": "quota_exceeded",
                }
        quota_root = root if decision.workspace_id is None else None
        quota_bytes = sandbox_settings.persistent_quota_bytes if decision.workspace_id is None else None
    terminal_row = None
    from app.services.terminals import ensure_agent_terminal, get_terminal
    requested_terminal_id = str(args.get("_terminal_id") or "").strip()
    if requested_terminal_id:
        terminal_row = await get_terminal(db, user_id, requested_terminal_id)
        if (
            terminal_row is None
            or terminal_row.closed_at is not None
            or (session_id is not None and terminal_row.session_id != int(session_id))
            or (session_id is None and terminal_row.session_id is not None)
            or terminal_row.workspace_id != decision.workspace_id
        ):
            return {"error": "终端不存在、未关联当前会话或已停止", "_risk": decision.risk.value, "_scope": decision.scope.value, "_audit_event": "denied"}
        terminal_row.status = "running"
        terminal_row.shell_mode = decision.scope.value
        terminal_row.network_profile = network_profile
        terminal_row.updated_at = __import__("app.core.tz", fromlist=["now_utc"]).now_utc()
    elif session_id:
            terminal_row = await ensure_agent_terminal(
                db, user_id, session_id=int(session_id), workspace_id=decision.workspace_id,
                shell_mode=decision.scope.value, network_profile=network_profile,
                run_id=str(args.get("_run_id") or current_dispatch_run_id() or "") or None,
            )
    async def authorization_check() -> bool:
        """在独立事务中复核权限。

        沙盒会在命令执行期间并发调用这个回调；不能复用外层 handler 的
        AsyncSession。AsyncSession 不是并发安全对象，共用它会让一次查询的失败
        事务污染下一次复核，最终把正常命令误报为 PendingRollbackError。
        """
        _db_session.ensure_engine()
        async with _db_session._SessionLocal() as auth_db:
            try:
                current = await evaluate(
                    auth_db,
                    user_id,
                    session_id,
                    command,
                    confirm=True,
                    session=current_dispatch_session(),
                    workspace_id=requested_workspace_id,
                    requested_scope=decision.scope,
                    subject_type=subject_type,
                    subject_id=subject_id,
                )
                return (
                    current.allowed
                    and current.workspace_id == decision.workspace_id
                    and current.scope == decision.scope
                    and current.full_user_sandbox_write == decision.full_user_sandbox_write
                )
            except Exception:
                await auth_db.rollback()
                return False
    try:
        sandbox_settings = get_settings().sandbox
        if decision.scope.value == "sandbox":
            # sandbox 生产链路必须经过 sandboxd；客户端失败不得回退 Docker CLI
            # 或本机执行器，否则 Docker/ACL/审计边界会被静默绕过。
            if not sandbox_settings.sandboxd_socket:
                return {"error": "sandboxd 未配置，未执行命令", "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "sandboxd_unavailable"}
            result_data = await SandboxdClient(sandbox_settings.sandboxd_socket).execute_stream(
                ExecuteRequest(
                    root=str(root), command=command, cwd=str(requested_cwd),
                    timeout=float(args.get("timeout", 30)),
                    max_output_chars=int(args.get("max_output_chars", 12_000)),
                    quota_root=str(quota_root) if quota_root else None,
                    quota_bytes=quota_bytes,
                    network_profile=network_profile,
                    egress_expires_at=egress_expires_at,
                    request_id=str(args.get("_run_id") or "") or None,
                    personal_root=str(personal_root) if personal_root else None,
                    project_root=str(project_root) if project_root else None,
                    personal_read_only=not decision.full_user_sandbox_write,
                    project_read_only=not decision.full_user_sandbox_write,
                ), on_output=on_output,
            )
            if result_data.get("error"):
                return {"error": result_data["error"], "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "sandboxd_rejected"}
            result = type("SandboxdResult", (), result_data)()
        else:
            executor = (
                LocalWorkspaceExecutor(
                    root,
                    # system 是用户显式开启的宿主机范围，允许执行本机已有脚本；
                    # sandbox 才需要阻止不受信 workspace 文件进入解释器。
                    restrict_interpreter_inputs=decision.scope.value != "system",
                )
            )
            result = await executor.execute(
                command, cwd=requested_cwd, timeout=args.get("timeout", 30),
                max_output_chars=args.get("max_output_chars", 12_000),
                authorization_check=authorization_check,
                on_output=on_output,
            )
    except SandboxdUnavailable as exc:
        return {"error": str(exc), "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "sandboxd_unavailable"}
    except ValueError as exc:
        return {"error": str(exc), "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "rejected"}
    if decision.scope.value == "sandbox" and decision.workspace_id is None and quota_before is not None:
        quota_after = measure_directory(root)
        operation = (
            "build" if any(token in command for token in ("npm ", "pnpm ", "yarn ", "cargo ", "make ", "gradle ", "build"))
            else "shell_exec"
        )
        await record_usage(
            db, user_id, category=SHELL_PERSISTENT,
            delta_bytes=quota_after - quota_before,
            operation=operation, resource_type="shell", resource_id=session_id or "none",
            idempotency_key=f"shell:{session_id or 'none'}:{time.monotonic_ns()}",
            metadata={"command_fingerprint": fingerprint(command), "measured_bytes": quota_after},
        )
    if terminal_row is not None and not args.get("_defer_terminal_event"):
        from app.services.terminals import append_shell_result
        await append_shell_result(
            db, terminal_row, command=command, stdout=result.stdout, stderr=result.stderr,
            exit_code=result.exit_code, ok=result.ok,
            source=str(args.get("_terminal_source") or "agent"),
            run_id=str(args.get("_run_id") or current_dispatch_run_id() or "") or None,
        )
    return {
        "ok": result.ok,
        "exit_code": result.exit_code,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "timed_out": result.timed_out,
        "truncated": result.truncated,
        "workspace_id": decision.workspace_id,
        "scope": decision.scope.value,
        "cwd": result.cwd,
        "permission_revoked": result.permission_revoked,
        "quota_exceeded": getattr(result, "quota_exceeded", False),
        "_terminal_id": terminal_row.id if terminal_row is not None else None,
        **({"error": "Shell 持久空间达到配额，命令已终止"} if getattr(result, "quota_exceeded", False) else {}),
        "_risk": decision.risk.value,
        "_workspace_id": decision.workspace_id,
        "_scope": decision.scope.value,
        "_audit_event": "permission_revoked" if result.permission_revoked else "completed",
        **({"_confirm_gate_authorized": "shell_autopilot"}
           if decision.autopilot_enabled and decision.risk.value == "dangerous" else {}),
    }


_SCRIPT_INTERPRETERS = {
    "python": ("python3", {"py"}),
    "python3": ("python3", {"py"}),
    "node": ("node", {"js", "mjs", "cjs"}),
    "bash": ("bash", {"sh", "bash"}),
}
_SCRIPT_ROOT_PREFIX = {"workspace": "/workspace", "personal": "/personal", "project": "/project"}
_SCRIPT_META = set(";&|<>$`()\n\r")


def _normalize_script_path(value: str) -> PurePosixPath:
    """只接受沙盒挂载根下的相对脚本路径，不跟随软链接或 ``..``。"""
    text = str(value or "").strip()
    if not text or "\x00" in text or "\\" in text or any(char in _SCRIPT_META for char in text):
        raise ValueError("script_path 必须是沙盒内的相对路径")
    path = PurePosixPath(text)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("script_path 必须是沙盒内的相对路径")
    return path


def _validate_script_file(root: Path, relative: PurePosixPath) -> Path:
    cursor = root
    for part in relative.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError("script_path 不能经过软链接")
    candidate = cursor.resolve(strict=True)
    try:
        candidate.relative_to(root.resolve(strict=True))
    except ValueError as exc:
        raise ValueError("script_path 超出沙盒范围") from exc
    if not candidate.is_file():
        raise ValueError("script_path 必须指向已存在的脚本文件")
    if candidate.stat().st_nlink > 1:
        raise ValueError("script_path 不能使用硬链接文件")
    return candidate


async def _run_script(db, user_id, args: dict):
    """运行用户明确指定的沙盒脚本；不接受任意 command 或解释器 eval 参数。"""
    policy = await current_filesystem_policy(db, user_id)
    if policy is None:
        return {"error": "脚本只能在有效的 Agent Session 或定时任务上下文中执行"}

    root_name = str(args.get("root") or "workspace").strip().lower()
    if root_name not in _SCRIPT_ROOT_PREFIX:
        return {"error": "root 只能是 workspace、personal 或 project"}
    interpreter_name = str(args.get("interpreter") or "python3").strip().lower()
    interpreter_spec = _SCRIPT_INTERPRETERS.get(interpreter_name)
    if interpreter_spec is None:
        return {"error": "仅支持 python3、node 和 bash 脚本"}
    interpreter, extensions = interpreter_spec
    try:
        relative = _normalize_script_path(args.get("script_path"))
    except ValueError as exc:
        return {"error": str(exc)}
    if relative.suffix.lower().lstrip(".") not in extensions:
        return {"error": f"{interpreter_name} 只能运行对应脚本后缀：{', '.join(sorted(extensions))}"}

    if root_name == "workspace":
        root = await resolve_shell_root(db, user_id, "sandbox", policy.workspace_id)
    elif not policy.full_user_sandbox:
        return {"error": "personal/project 脚本需要先显式授权完整用户沙箱读写权限"}
    elif root_name == "personal":
        root = await resolve_user_personal_root(db, user_id)
    else:
        root = await resolve_project_root(db, user_id)
    if root is None:
        return {"error": "当前脚本根目录不可用，未执行脚本"}
    try:
        _validate_script_file(root, relative)
    except (OSError, ValueError) as exc:
        return {"error": str(exc)}

    script_arg = f"{_SCRIPT_ROOT_PREFIX[root_name]}/{relative.as_posix()}"
    raw_args = args.get("args") or []
    if not isinstance(raw_args, list) or len(raw_args) > 32:
        return {"error": "args 必须是最多 32 个字符串的数组"}
    if any(not isinstance(value, str) or any(char in _SCRIPT_META for char in value) for value in raw_args):
        return {"error": "脚本参数不得包含 Shell 控制字符"}
    command = " ".join([interpreter, shlex.quote(script_arg), *(shlex.quote(value) for value in raw_args)])
    return await _run_shell(db, user_id, {
        "command": command,
        "cwd": policy.cwd or ".",
        "timeout": args.get("timeout", 30),
        "max_output_chars": args.get("max_output_chars", 12_000),
        "network": "none",
        "_session_id": args.get("_session_id") or current_dispatch_session_id(),
    })


class ShellSkill(BaseSkill):
    name = "shell"
    tools = [
        Tool(
            name="shell",
            label="执行 Shell 命令",
            description_short='受控执行 Shell；沙盒挂载可写 /workspace、只读项目目录 /project 和个人文件库 /personal；system 或 egress 需显式选择并确认',
            description="在授权 Shell 范围执行一条受控命令；沙盒当前目录为 /workspace，/project 是当前用户完整项目文件库（只读，含年月和项目目录），/personal 是当前用户个人文件库（只读）；危险命令需确认，不支持管道和重定向。",
            input_schema={
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string"},
                    "timeout": {"type": "number", "minimum": 0.1, "maximum": 300},
                    "max_output_chars": {"type": "integer", "minimum": 1, "maximum": 120000},
                    "network": {"type": "string", "enum": ["none", "egress"]},
                    "scope": {"type": "string", "enum": ["sandbox", "system"]},
                },
                "required": ["command"],
            },
            handler=_shell,
            mutates=True,
            # destructive 才会桥接到网页/IM 确认按钮（create_tool_confirmation），
            # 用户点击后服务端记录 Redis 授权；schema 不暴露 confirm 参数，
            # 确认状态只由服务端 grant 决定，模型无法自行声明已确认。
            destructive=True,
        ),
        Tool(
            name="run_script",
            label="运行沙盒脚本",
            description_short="运行用户明确指定的沙盒内 Python、Node 或 Bash 脚本。",
            description=(
                "运行一个已存在且由用户明确指定的沙盒脚本。script_path 必须是相对路径，"
                "不能经过软链接或硬链接；root 可选 workspace/personal/project。默认使用 python3，"
                "脚本仍复用 Shell 的沙盒、workspace/cwd、超时、输出、网络隔离和进程清理边界；"
                "personal/project 需要完整用户沙箱授权，不能传任意 Shell command 或 eval 参数。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "script_path": {"type": "string", "minLength": 1, "maxLength": 1000},
                    "root": {"type": "string", "enum": ["workspace", "personal", "project"]},
                    "interpreter": {"type": "string", "enum": ["python3", "node", "bash"]},
                    "args": {"type": "array", "items": {"type": "string", "maxLength": 1000}, "maxItems": 32},
                    "timeout": {"type": "number", "minimum": 0.1, "maximum": 300},
                    "max_output_chars": {"type": "integer", "minimum": 1, "maximum": 120000},
                },
                "required": ["script_path"],
                "additionalProperties": False,
            },
            handler=_run_script,
            mutates=True,
            destructive=True,
        ),
    ]


ShellSkill().register()
