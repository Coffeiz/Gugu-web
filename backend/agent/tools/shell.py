"""工作区 Shell 工具：只在权限已满足的当前会话工作区内执行。"""
from __future__ import annotations

import json
import logging
import time

import app.db.session as _db_session

from agent.security import confirm
from agent.security.logsafe import fingerprint
from agent.security.shell_policy import ShellRisk, classify_command, evaluate, session_shell_lock
from agent.security.shell_policy import shell_cwd_mapping
from agent.tools.base import (
    current_dispatch_filesystem_subject,
    current_dispatch_run_id,
    current_dispatch_session,
)
from agent.sandbox import LocalWorkspaceExecutor
from agent.sandbox.local_executor import ShellResult
from agent.sandbox.docker_runtime import sandbox_readiness, valid_egress_network_name, valid_egress_proxy
from agent.sandbox.client import SandboxdClient, SandboxdUnavailable
from agent.sandbox.protocol import ExecuteRequest, WorkspaceMount
from app.core.config import get_settings
from agent.tools.base import BaseSkill, Tool
from app.services.workspaces import (
    resolve_project_root,
    resolve_shell_root,
    resolve_shell_workspace_mounts,
    resolve_user_personal_root,
    workspace_shell_supported,
)
from app.services.storage.quota_ledger import (
    FILE_LIBRARY,
    SHELL_PERSISTENT,
    get_quota,
    measure_shell_persistent_usage,
    record_usage,
    reconcile_user_storage,
)

logger = logging.getLogger(__name__)


def _storage_backend() -> str:
    settings = get_settings()
    storage = getattr(settings, "storage", None)
    # 轻量单测可能只提供 sandbox 设置；实际 AppSettings 总会显式声明后端。
    return str(getattr(storage, "backend", "oss"))


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
        audit_result = result if isinstance(result, dict) else {}
        risk = audit_result.pop("_risk", risk)
        workspace_id = audit_result.pop("_workspace_id", None)
        scope = audit_result.pop("_scope", None)
        terminal_id = audit_result.pop("_terminal_id", None)
        event = audit_result.pop("_audit_event", event)
        if isinstance(result, dict):
            # Shell 工具同时覆盖安全与危险命令；把实际风险传给 dispatch，
            # 不能仅依据 Tool.destructive=True 判断。
            result["_dispatch_risk"] = risk
        _audit(
            event=event,
            user_id=fingerprint(str(user_id)),
            session_id=session_id,
            workspace_id=workspace_id,
            scope=scope,
            risk=risk,
            ok=audit_result.get("ok", False),
            exit_code=audit_result.get("exit_code"),
            timed_out=audit_result.get("timed_out", False),
            permission_revoked=audit_result.get("permission_revoked", False),
            truncated=audit_result.get("truncated", False),
            network_access=audit_result.get("network_access"),
            cwd_fingerprint=fingerprint(audit_result["cwd"]) if audit_result.get("cwd") else None,
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
    sandbox_settings = get_settings().sandbox
    # 网络是后台沙盒策略，不是 Agent 每次调用时可选择的参数。sandbox 只按
    # 管理员配置决定是否接入受控 egress；system 使用宿主机自身网络策略。
    network_profile = (
        str(getattr(sandbox_settings, "network_profile", "none") or "none").strip().lower()
        if decision.scope.value == "sandbox" else "none"
    )
    if network_profile not in {"none", "egress"}:
        return {"error": "后台沙盒网络策略无效", "_audit_event": "denied"}
    # 只有通过共享确认门后才标记；自动模式同样先经过该门并由门注入 confirm。
    confirm_gate_authorized = False
    if subject_type == "scheduled_task" and decision.needs_confirmation:
        return {
            "error": "定时任务只能执行无需交互确认的 sandbox 命令",
            "_risk": decision.risk.value,
            "_workspace_id": decision.workspace_id,
            "_scope": decision.scope.value,
            "_audit_event": "denied",
        }
    if network_profile == "egress":
        if decision.scope.value != "sandbox":
            return {"error": "后台 egress 只支持沙盒范围，system 使用宿主机自身网络策略", "_risk": decision.risk.value, "_scope": decision.scope.value, "_audit_event": "denied"}
        if not valid_egress_proxy(getattr(sandbox_settings, "egress_proxy_url", "")):
            return {"error": "后台 egress 尚未配置受控 HTTP(S) 代理", "_risk": decision.risk.value, "_scope": decision.scope.value, "_audit_event": "denied"}
        if not getattr(sandbox_settings, "egress_isolation_enabled", False):
            return {"error": "受控 egress 网络尚未启用，当前沙盒保持断网", "_risk": decision.risk.value, "_scope": decision.scope.value, "_audit_event": "denied"}
        if not valid_egress_network_name(getattr(sandbox_settings, "egress_network_name", "")):
            return {"error": "受控 egress Docker 网络名无效，当前沙盒保持断网", "_risk": decision.risk.value, "_scope": decision.scope.value, "_audit_event": "denied"}
    egress_expires_at = None
    if network_profile == "egress":
        egress_ttl = int(getattr(get_settings().sandbox, "egress_ttl_seconds", 600))
        egress_expires_at = time.time() + egress_ttl
    if decision.needs_confirmation:
        # 解释器、构建与管道均可能执行任意代码，不能用会话级 lease 推断影响范围。
        # 服务端授权绑定完整命令与执行上下文，并原子消费；脚本原地变更后的重跑也须再确认。
        blocked = confirm.needs_target_confirmation(
            args,
            f"将在 {decision.scope.value} 范围执行危险命令：{command}",
            user_id,
            action="shell.execute",
            targets={"command": [command]},
            context={
                "session_id": session_id, "scope": decision.scope.value,
                "workspace_id": decision.workspace_id, "cwd": str(requested_cwd),
                "subject_type": subject_type, "subject_id": subject_id,
            },
            purpose=confirm.ACTION,
            consume_grant=True,
            instruction="请转达本次命令的影响并等待用户确认；授权仅用于本次执行，不覆盖后续命令。",
        )
        if blocked is not None:
            return {"error": blocked, "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_audit_event": "confirmation_required"}
        confirm_gate_authorized = True

    personal_root = await resolve_user_personal_root(db, user_id) if decision.scope.value == "sandbox" else None
    project_root = await resolve_project_root(db, user_id) if decision.scope.value == "sandbox" else None
    workspace_mounts: tuple[WorkspaceMount, ...] = ()
    primary_workspace = None
    root = None
    if decision.scope.value == "sandbox":
        resolved_mounts = await resolve_shell_workspace_mounts(
            db, user_id, decision.workspace_id,
            include_all=decision.full_user_sandbox_write,
        )
        if resolved_mounts is None and workspace_shell_supported():
            return {"error": "当前工作区挂载无法安全解析，未执行命令", "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_audit_event": "denied"}
        if resolved_mounts is not None:
            mount_values, primary_workspace = resolved_mounts
            workspace_mounts = tuple(
                WorkspaceMount(target=target, root=str(path)) for target, path in mount_values
            )
            root = dict(mount_values).get(primary_workspace)
        else:
            # OSS 模式没有可枚举的本地工作区，保留独立 Shell 根目录路径。
            root = await resolve_shell_root(db, user_id, decision.scope.value, decision.workspace_id)
    else:
        root = await resolve_shell_root(db, user_id, decision.scope.value, decision.workspace_id)
    if root is None:
        return {"error": "当前 Shell 范围没有可用的本地目录，未执行命令", "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "denied"}
    quota_root = None
    quota_roots = ()
    quota_bytes = None
    quota_before = None
    result = None
    execution_error = None
    if decision.scope.value == "sandbox":
        sandbox_settings = get_settings().sandbox
        ready, reason = sandbox_readiness(sandbox_settings)
        if not ready:
            return {"error": reason, "_risk": decision.risk.value, "_workspace_id": decision.workspace_id, "_scope": decision.scope.value, "_audit_event": "denied"}
        if _storage_backend() == "local":
            shared_quota = await get_quota(db, user_id, FILE_LIBRARY)
            if shared_quota.used_bytes > shared_quota.limit_bytes:
                return {
                    "error": "用户存储空间已超过配额，请先清理文件或工作区后再执行命令",
                    "_risk": decision.risk.value,
                    "_scope": decision.scope.value,
                    "_audit_event": "quota_exceeded",
                }
            # Local 共用配额以账本为执行前事实；全量校准由独立修复/周期任务
            # 承担，不放在单次 Shell 请求中。
        elif decision.workspace_id is None:
            # OSS 没有本地 Workspace 根，Shell 持久空间继续使用独立上限。
            measured = await reconcile_user_storage(db, user_id)
            quota_before = measured[SHELL_PERSISTENT]
            if quota_before > sandbox_settings.persistent_quota_bytes:
                return {
                    "error": "Shell 持久空间已超过配额，请先清理文件后再执行命令",
                    "_risk": decision.risk.value,
                    "_scope": decision.scope.value,
                    "_audit_event": "quota_exceeded",
                }
            quota_root = root
            quota_bytes = sandbox_settings.persistent_quota_bytes
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
    # 进程执行可能持续数分钟；不要让工具 dispatcher 的事务和数据库连接
    # 在等待 sandboxd/宿主机进程期间保持打开。工具 dispatcher 为每次调用创建
    # 独立 session，因此这里提交的是本次 Shell 的预检状态（如终端 running
    # 状态和配额对账）；执行完成后的用量与结果事件会开启新的短事务。
    if db is not None:
        await db.commit()
    try:
        sandbox_settings = get_settings().sandbox
        if decision.scope.value == "sandbox":
            # sandbox 生产链路必须经过 sandboxd；客户端失败不得回退 Docker CLI
            # 或本机执行器，否则 Docker/ACL/审计边界会被静默绕过。
            if not sandbox_settings.sandboxd_socket:
                execution_error = "sandboxd 未配置，未执行命令"
            else:
                result_data = await SandboxdClient(sandbox_settings.sandboxd_socket).execute_stream(
                    ExecuteRequest(
                        root=str(root), command=command, cwd=str(requested_cwd),
                        timeout=float(args.get("timeout", 30)),
                        max_output_chars=int(args.get("max_output_chars", 12_000)),
                        quota_root=str(quota_root) if quota_root else None,
                        quota_roots=tuple(str(path) for path in quota_roots),
                        quota_bytes=quota_bytes,
                        network_profile=network_profile,
                        egress_expires_at=egress_expires_at,
                        request_id=str(args.get("_run_id") or "") or None,
                        personal_root=str(personal_root) if personal_root else None,
                        project_root=str(project_root) if project_root else None,
                        personal_read_only=not decision.full_user_sandbox_write,
                        project_read_only=not decision.full_user_sandbox_write,
                        workspace_mounts=workspace_mounts,
                        primary_workspace=primary_workspace,
                    ), on_output=on_output,
                )
                if result_data.get("error"):
                    execution_error = result_data["error"]
                else:
                    result = type("SandboxdResult", (), result_data)()
        else:
            executor = LocalWorkspaceExecutor(root)
            result = await executor.execute(
                command, cwd=requested_cwd, timeout=args.get("timeout", 30),
                max_output_chars=args.get("max_output_chars", 12_000),
                authorization_check=authorization_check,
                on_output=on_output,
            )
    except SandboxdUnavailable as exc:
        execution_error = str(exc)
    except ValueError as exc:
        execution_error = str(exc)
    if result is None:
        result = ShellResult(
            ok=False, exit_code=None, stdout="", stderr=execution_error or "Shell 执行失败",
            timed_out=False, cwd=str(requested_cwd),
        )
    if decision.scope.value == "sandbox" and quota_before is not None:
        operation = (
            "build" if any(token in command for token in ("npm ", "pnpm ", "yarn ", "cargo ", "make ", "gradle ", "build"))
            else "shell_exec"
        )
        quota_after = await measure_shell_persistent_usage(db, user_id)
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
        # 把执行器实际采用的网络能力回传给模型，避免它根据配置默认值或
        # 某次脚本/命令错误臆测为“无网络”。不返回代理地址等敏感配置。
        "network_profile": network_profile,
        "network_access": (
            "egress" if network_profile == "egress"
            else "host" if decision.scope.value == "system"
            else "none"
        ),
        "cwd": result.cwd,
        "cwd_display": await shell_cwd_mapping(
            db, user_id, session=current_dispatch_session(),
            workspace_id=decision.workspace_id,
        ),
        "permission_revoked": result.permission_revoked,
        "quota_exceeded": getattr(result, "quota_exceeded", False),
        "_terminal_id": terminal_row.id if terminal_row is not None else None,
        **({"error": execution_error} if execution_error else {}),
        **({"error": "Shell 持久空间达到配额，命令已终止"} if getattr(result, "quota_exceeded", False) else {}),
        "_risk": decision.risk.value,
        "_workspace_id": decision.workspace_id,
        "_scope": decision.scope.value,
        "_audit_event": "permission_revoked" if result.permission_revoked else "completed",
        **({"_confirm_gate_authorized": "confirmation_gate"}
           if confirm_gate_authorized else {}),
    }


class ShellSkill(BaseSkill):
    name = "shell"
    tools = [
        Tool(
            name="shell",
            label="执行 Shell 命令",
            description_short='在当前授权范围内受控执行 Shell；目录挂载和网络能力由后台策略决定',
            description="在当前授权 Shell 范围执行受控命令。省略 scope 默认使用隔离的 sandbox 容器；scope=system 在 Gugu 后端服务进程所在的操作系统环境中直接执行，使用服务进程权限（不自动是 root），原生部署时是服务器主机，Docker 部署时是 Gugu 应用容器而非 Docker 宿主机。用户任务明确针对 Gugu 服务环境时才选择 system；目录、网络和危险操作仍由服务端策略决定。网络由后台策略自动决定，结果会返回 network_access（none=断网沙盒、egress=受控代理公网、host=system 网络）。支持 &&、||、;、| 等复合命令与管道；重定向（> >>）和命令替换属于危险操作，需用户确认。",
            input_schema={
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string"},
                    "timeout": {"type": "number", "minimum": 0.1, "maximum": 300},
                    "max_output_chars": {"type": "integer", "minimum": 1, "maximum": 120000},
                    "scope": {
                        "type": "string",
                        "enum": ["sandbox", "system"],
                        "description": "省略时默认为 sandbox 隔离容器。system 在 Gugu 后端服务进程所在操作系统环境执行：原生部署为服务器主机，Docker 部署为应用容器（不是 Docker 宿主机），权限与服务进程相同。仅当任务目标是 Gugu 服务环境时指定 system。",
                    },
                },
                "required": ["command"],
            },
            handler=_shell,
            mutates=True,
            parallel_safe_for_input=lambda args: (
                isinstance(args.get("command"), str)
                and classify_command(args["command"]) is not ShellRisk.DANGEROUS
            ),
        # 需要确认的工具才会桥接到网页/IM 确认按钮（create_tool_confirmation），
            # 用户点击后服务端记录 Redis 授权；schema 不暴露 confirm 参数，
            # 确认状态只由服务端 grant 决定，模型无法自行声明已确认。
            destructive=True,
        ),
    ]


ShellSkill().register()
