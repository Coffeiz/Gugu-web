"""工作区 Shell 工具：只在权限已满足的当前会话工作区内执行。"""
from __future__ import annotations

import json
import logging
import time

import app.db.session as _db_session

from agent.security import confirm
from agent.security.logsafe import fingerprint
from agent.security.shell_policy import evaluate, session_shell_lock
from agent.tools.base import current_dispatch_session
from agent.sandbox import LocalWorkspaceExecutor
from agent.sandbox.docker_runtime import sandbox_readiness
from agent.sandbox.quota import snapshot_quota
from agent.sandbox.client import SandboxdClient, SandboxdUnavailable
from agent.sandbox.protocol import ExecuteRequest
from app.core.config import get_settings
from agent.tools.base import BaseSkill, Tool
from app.services.workspaces import resolve_shell_root

logger = logging.getLogger(__name__)


def _audit(**fields) -> None:
    logger.info("shell_audit %s", json.dumps(fields, ensure_ascii=False, sort_keys=True))


async def _shell(db, user_id, args: dict):
    session_id = args.get("_session_id")
    started = time.monotonic()
    risk = "unknown"
    workspace_id = None
    scope = None
    result = None
    event = "completed"
    try:
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
        )
    return result


async def _run_shell(db, user_id, args: dict):
    command = str(args.get("command") or "").strip()
    session_id = args.get("_session_id")
    decision = await evaluate(
        db, user_id, session_id, command, confirm=bool(args.get("confirm")),
        session=current_dispatch_session(),
    )
    if not decision.allowed:
        return {"error": decision.reason, "_risk": decision.risk.value, "_audit_event": "denied"}
    if decision.needs_confirmation:
        blocked = confirm.needs_confirmation(
            args,
            f"将在当前工作区执行危险命令：{command}",
            user_id,
        )
        if blocked is not None:
            return {"error": blocked, "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_audit_event": "confirmation_required"}

    root = await resolve_shell_root(db, user_id, decision.scope.value, decision.workspace_id)
    if root is None:
        return {"error": "当前 Shell 范围没有可用的本地目录，未执行命令", "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "denied"}
    quota_root = None
    quota_bytes = None
    if decision.scope.value == "sandbox":
        sandbox_settings = get_settings().sandbox
        ready, reason = sandbox_readiness(sandbox_settings)
        if not ready:
            return {"error": reason, "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "denied"}
        # 文件库/项目工作区沿用文件服务自己的存储配额；只有未绑定 workspace
        # 时才检查独立 Shell 持久目录，避免把项目文件误计入 Shell 配额。
        if decision.workspace_id is None:
            quota = snapshot_quota(root, sandbox_settings.persistent_quota_bytes)
            if quota.exceeded:
                return {
                    "error": "Shell 持久空间已超过配额，请先清理文件后再执行命令",
                    "_risk": decision.risk.value,
                    "_scope": decision.scope.value,
                    "_audit_event": "quota_exceeded",
                }
        quota_root = root if decision.workspace_id is None else None
        quota_bytes = sandbox_settings.persistent_quota_bytes if decision.workspace_id is None else None
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
            result_data = await SandboxdClient(sandbox_settings.sandboxd_socket).execute(
                ExecuteRequest(
                    root=str(root), command=command, cwd=str(args.get("cwd", ".")),
                    timeout=float(args.get("timeout", 30)),
                    max_output_chars=int(args.get("max_output_chars", 12_000)),
                    quota_root=str(quota_root) if quota_root else None,
                    quota_bytes=quota_bytes,
                )
            )
            if result_data.get("error"):
                return {"error": result_data["error"], "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "sandboxd_rejected"}
            result = type("SandboxdResult", (), result_data)()
        else:
            executor = (
                LocalWorkspaceExecutor(root)
            )
            result = await executor.execute(
                command, cwd=args.get("cwd", "."), timeout=args.get("timeout", 30),
                max_output_chars=args.get("max_output_chars", 12_000),
                authorization_check=authorization_check,
            )
    except SandboxdUnavailable as exc:
        return {"error": str(exc), "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "sandboxd_unavailable"}
    except ValueError as exc:
        return {"error": str(exc), "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "rejected"}
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
            description=(
                "在当前会话自动匹配的 Shell 范围内执行一条受控命令。默认使用用户 sandbox；"
                "绑定工作区时只把工作区作为 sandbox 的默认目录；明确开启 system 权限时才使用宿主机执行器；"
                "只能使用相对 cwd，不支持管道、重定向或命令替换。危险命令会先要求用户确认；"
                "没有可用 Shell 权限时不要调用。会话身份由系统注入，不需要传 session_id。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "要执行的单条命令，不要拼接管道或重定向"},
                    "cwd": {"type": "string", "description": "workspace 内相对目录，默认 ."},
                    "timeout": {"type": "number", "minimum": 0.1, "maximum": 300, "description": "超时时间，秒，默认 30"},
                    "max_output_chars": {"type": "integer", "minimum": 1, "maximum": 120000, "description": "输出字符上限，默认 12000"},
                    "confirm": {"type": "boolean", "description": "仅用于携带确认凭证后的二次调用"},
                    "confirm_token": {"type": "string", "description": "危险命令确认凭证"},
                },
                "required": ["command"],
            },
            handler=_shell,
            mutates=True,
        ),
    ]


ShellSkill().register()
