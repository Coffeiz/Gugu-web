"""工作区 Shell 工具：只在权限已满足的当前会话工作区内执行。"""
from __future__ import annotations

import json
import logging
import re
import time

import app.db.session as _db_session

from agent.security import confirm
from agent.security.logsafe import fingerprint
from agent.security.shell_policy import evaluate, session_shell_lock
from agent.tools.base import current_dispatch_run_id, current_dispatch_session
from agent.sandbox import LocalWorkspaceExecutor
from agent.sandbox.docker_runtime import sandbox_readiness, valid_egress_network_name, valid_egress_proxy
from agent.sandbox.quota import measure_directory, snapshot_quota
from agent.sandbox.client import SandboxdClient, SandboxdUnavailable
from agent.sandbox.protocol import ExecuteRequest
from app.core.config import get_settings
from agent.tools.base import BaseSkill, Tool
from app.services.workspaces import resolve_shell_root
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
    requested_workspace_id = args.get("_workspace_id")
    network_profile = str(args.get("network") or "none").strip().lower()
    if network_profile not in {"none", "egress"}:
        return {"error": "network 只能是 none 或 egress", "_audit_event": "rejected"}
    decision = await evaluate(
        db, user_id, session_id, command, confirm=bool(args.get("confirm")),
        session=current_dispatch_session(),
        workspace_id=requested_workspace_id,
        requested_scope=args.get("scope"),
    )
    if not decision.allowed:
        return {"error": decision.reason, "_risk": decision.risk.value, "_audit_event": "denied"}
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
        blocked = confirm.needs_confirmation(
            args,
            "允许当前会话在沙盒内临时访问公网（仅通过受控代理，有效期10分钟）",
            user_id,
            identity=f"shell:egress:{session_id}:{decision.workspace_id or 'user'}",
            ttl_minutes=max(1, (egress_ttl + 59) // 60),
            instruction=(
                "这是当前会话的临时沙盒联网授权，只允许通过受控代理访问公网，"
                "有效期10分钟；请把授权范围告知用户，用户明确同意后带 confirm=true 和本次 confirm_token 再次调用。"
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
                "请把授权范围告知用户，用户明确同意后带 confirm=true 和本次 confirm_token 再次调用。"
                if shell_lease else None
            ),
        )
        if blocked is not None:
            return {"error": blocked, "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_audit_event": "confirmation_required"}

    root = await resolve_shell_root(db, user_id, decision.scope.value, decision.workspace_id)
    if root is None:
        return {"error": "当前 Shell 范围没有可用的本地目录，未执行命令", "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "denied"}
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
                )
                return (
                    current.allowed
                    and current.workspace_id == decision.workspace_id
                    and current.scope == decision.scope
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
                    root=str(root), command=command, cwd=str(args.get("cwd", ".")),
                    timeout=float(args.get("timeout", 30)),
                    max_output_chars=int(args.get("max_output_chars", 12_000)),
                    quota_root=str(quota_root) if quota_root else None,
                    quota_bytes=quota_bytes,
                    network_profile=network_profile,
                    egress_expires_at=egress_expires_at,
                    request_id=str(args.get("_run_id") or "") or None,
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
                command, cwd=args.get("cwd", "."), timeout=args.get("timeout", 30),
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
    }


class ShellSkill(BaseSkill):
    name = "shell"
    tools = [
        Tool(
            name="shell",
            label="执行 Shell 命令",
            description_short='受控执行 Shell；默认 sandbox/network=none；system 或 egress 需显式选择并确认，禁止管道和重定向',
            description="在授权 Shell 范围执行一条受控命令；默认 sandbox，危险命令需确认，不支持管道和重定向。",
            input_schema={
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string"},
                    "timeout": {"type": "number", "minimum": 0.1, "maximum": 300},
                    "max_output_chars": {"type": "integer", "minimum": 1, "maximum": 120000},
                    "network": {"type": "string", "enum": ["none", "egress"]},
                    "scope": {"type": "string", "enum": ["sandbox", "system"]},
                    "confirm": {"type": "boolean"},
                    "confirm_token": {"type": "string"},
                },
                "required": ["command"],
            },
            handler=_shell,
            mutates=True,
            # destructive 才会桥接到网页/IM 确认按钮（create_tool_confirmation），
            # 由用户点击后服务端注入 confirm 凭证；缺了它确认只能靠模型复述
            # 长 token，复制坏一个字符就死循环重签。
            destructive=True,
        ),
    ]


ShellSkill().register()
