"""共享协作终端的持久化服务。"""

from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from agent.terminal.access import TerminalAccessDecision, TerminalOperation, page_access, pty_access
from agent.terminal.contracts import TerminalMode, TerminalShellMode, TerminalSource, TerminalStatus
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import ConversationSession, TerminalEventRecord, TerminalSessionRecord, Workspace
from app.services.workspaces import workspace_shell_supported

TERMINAL_RETENTION_DAYS = 30
TERMINAL_OUTPUT_RETENTION_CHARS = 500_000


def _terminal_id() -> str:
    return f"term-{uuid4().hex}"


def serialize_terminal(row: TerminalSessionRecord) -> dict:
    workspace_id = row.workspace_id if workspace_shell_supported() else None
    return {
        "id": row.id, "name": row.name, "sessionId": row.session_id, "runId": row.run_id,
        "workspaceId": workspace_id, "source": row.source,
        "mode": row.mode or TerminalMode.AGENT_EVENTS.value, "status": row.status,
        "shellMode": row.shell_mode, "networkProfile": row.network_profile,
        "lastSequence": row.last_sequence, "outputChars": row.output_chars,
        "ptyPid": row.pty_pid, "ptySandboxId": row.pty_sandbox_id,
        "ptyCols": row.pty_cols, "ptyRows": row.pty_rows,
        "createdAt": row.created_at.isoformat(), "updatedAt": row.updated_at.isoformat(),
        "closedAt": row.closed_at.isoformat() if row.closed_at else None,
    }


async def list_terminals(db: AsyncSession, user_id) -> list[TerminalSessionRecord]:
    result = await db.execute(
        select(TerminalSessionRecord)
        .where(TerminalSessionRecord.owner_id == user_id)
        .order_by(TerminalSessionRecord.updated_at.desc(), TerminalSessionRecord.id.desc())
    )
    return list(result.scalars().all())


async def get_terminal(db: AsyncSession, user_id, terminal_id: str) -> TerminalSessionRecord | None:
    result = await db.execute(select(TerminalSessionRecord).where(
        TerminalSessionRecord.id == terminal_id,
        TerminalSessionRecord.owner_id == user_id,
    ))
    return result.scalar_one_or_none()


async def create_terminal(
    db: AsyncSession, user_id, *, name: str | None = None,
    session_id: int | None = None, workspace_id: int | None = None,
    mode: str = TerminalMode.INTERACTIVE_PTY.value,
) -> TerminalSessionRecord:
    access = await page_access(db, user_id)
    if not access.allowed:
        raise PermissionError(access.reason)
    if mode == TerminalMode.INTERACTIVE_PTY.value:
        pty_decision = await pty_access(db, user_id)
        if not pty_decision.allowed:
            raise PermissionError(pty_decision.reason)
    if session_id is not None and await get_owned(db, ConversationSession, session_id, user_id) is None:
        raise LookupError("会话不存在")
    if workspace_id is not None:
        if not workspace_shell_supported():
            raise ValueError("OSS 存储模式不支持 workspace，请使用独立 Shell 沙盒")
        workspace = await get_owned(db, Workspace, workspace_id, user_id)
        if workspace is None or not workspace.enabled:
            raise LookupError("工作区不存在或已停用")
    if mode not in {item.value for item in TerminalMode}:
        raise ValueError("终端模式无效")
    row = TerminalSessionRecord(
        id=_terminal_id(), owner_id=user_id, session_id=session_id,
        workspace_id=workspace_id, name=(name or "终端").strip() or "终端",
        source=TerminalSource.USER.value, mode=mode, status=TerminalStatus.IDLE.value,
        shell_mode=TerminalShellMode.SANDBOX.value, network_profile="none",
    )
    db.add(row)
    await db.flush()
    return row


async def ensure_agent_terminal(db: AsyncSession, user_id, *, session_id: int, workspace_id: int | None,
                                shell_mode: str, network_profile: str, run_id: str | None = None) -> TerminalSessionRecord:
    if workspace_id is not None and not workspace_shell_supported():
        raise ValueError("OSS 存储模式不支持 workspace，请使用独立 Shell 沙盒")
    result = await db.execute(select(TerminalSessionRecord).where(
        TerminalSessionRecord.owner_id == user_id,
        TerminalSessionRecord.session_id == session_id,
        TerminalSessionRecord.source == TerminalSource.AGENT.value,
        TerminalSessionRecord.closed_at.is_(None),
    ).order_by(TerminalSessionRecord.updated_at.desc()))
    row = result.scalars().first()
    if row is None:
        row = TerminalSessionRecord(
            id=_terminal_id(), owner_id=user_id, session_id=session_id,
            run_id=run_id,
            workspace_id=workspace_id, name="咕咕终端", source=TerminalSource.AGENT.value,
            mode=TerminalMode.AGENT_EVENTS.value,
            status=TerminalStatus.RUNNING.value, shell_mode=shell_mode,
            network_profile=network_profile,
        )
        db.add(row)
        await db.flush()
    else:
        if not workspace_shell_supported():
            row.workspace_id = None
        row.status = TerminalStatus.RUNNING.value
        row.run_id = run_id or row.run_id
        row.updated_at = now_utc()
    return row


async def _enforce_output_retention(db: AsyncSession, row: TerminalSessionRecord) -> None:
    """输出累计超过保留上限时滚动删除最老事件，保证单终端体积有界。

    只保留最新一条事件不删：保证回放游标（sequence > after）永远有落点，
    也避免计数漂移时把终端清空。sequence 只增不减，裁剪不影响增量回放。
    """
    if row.output_chars <= TERMINAL_OUTPUT_RETENTION_CHARS:
        return
    result = await db.execute(
        select(TerminalEventRecord).where(TerminalEventRecord.terminal_id == row.id)
        .order_by(TerminalEventRecord.sequence.asc())
    )
    stale_ids: list[int] = []
    removed_chars = 0
    for event in result.scalars():
        if row.output_chars - removed_chars <= TERMINAL_OUTPUT_RETENTION_CHARS:
            break
        if event.sequence == row.last_sequence:
            break
        stale_ids.append(event.id)
        removed_chars += len(event.stdout or "") + len(event.stderr or "")
    if stale_ids:
        await db.execute(delete(TerminalEventRecord).where(TerminalEventRecord.id.in_(stale_ids)))
        row.output_chars -= removed_chars


async def append_shell_result(db: AsyncSession, row: TerminalSessionRecord, *, command: str,
                              stdout: str, stderr: str, exit_code: int | None,
                              ok: bool, source: str = TerminalSource.AGENT.value,
                              run_id: str | None = None) -> None:
    sequence = row.last_sequence + 1
    event = TerminalEventRecord(
        terminal_id=row.id, run_id=run_id or row.run_id, sequence=sequence, event_type="command",
        source=source, command=command, stdout=stdout or "", stderr=stderr or "",
        exit_code=exit_code,
    )
    db.add(event)
    row.last_sequence = sequence
    row.output_chars += len(stdout or "") + len(stderr or "")
    row.status = TerminalStatus.IDLE.value if ok else TerminalStatus.FAILED.value
    row.updated_at = now_utc()
    await db.flush()
    await _enforce_output_retention(db, row)


async def append_terminal_status(db: AsyncSession, row: TerminalSessionRecord, *, command: str,
                                 status: str, run_id: str | None = None) -> TerminalEventRecord:
    """记录命令生命周期状态，供执行记录和 SSE 重放使用。"""
    sequence = row.last_sequence + 1
    event = TerminalEventRecord(
        terminal_id=row.id, run_id=run_id or row.run_id, sequence=sequence,
        event_type="status", source=TerminalSource.USER.value, command=command,
        stdout=status, stderr="", exit_code=None,
    )
    db.add(event)
    row.last_sequence = sequence
    row.status = "running" if status == "running" else row.status
    row.updated_at = now_utc()
    await db.flush()
    return event


async def terminate_terminal(db: AsyncSession, row: TerminalSessionRecord) -> None:
    sequence = row.last_sequence + 1
    db.add(TerminalEventRecord(
        terminal_id=row.id, run_id=row.run_id, sequence=sequence, event_type="status",
        source=TerminalSource.USER.value, command=None, stdout="", stderr="", exit_code=None,
    ))
    row.last_sequence = sequence
    row.status = TerminalStatus.TERMINATED.value
    row.closed_at = now_utc()
    row.updated_at = row.closed_at
    await db.flush()


async def reopen_terminal(db: AsyncSession, row: TerminalSessionRecord) -> TerminalSessionRecord:
    """重新开启已停止终端，保留原有输出事件。"""
    row.status = TerminalStatus.IDLE.value
    row.closed_at = None
    row.updated_at = now_utc()
    await db.flush()
    return row


async def reset_terminal(db: AsyncSession, row: TerminalSessionRecord) -> TerminalSessionRecord:
    """重置终端运行态；保留终端记录、输出历史和用户工作区文件。"""
    row.status = TerminalStatus.IDLE.value
    row.closed_at = None
    row.pty_pid = None
    row.pty_sandbox_id = None
    row.pty_cols = None
    row.pty_rows = None
    row.updated_at = now_utc()
    await db.flush()
    return row


async def delete_terminal(db: AsyncSession, row: TerminalSessionRecord) -> None:
    """永久删除终端及其事件；调用方已完成 owner/权限校验。"""
    await db.execute(delete(TerminalEventRecord).where(TerminalEventRecord.terminal_id == row.id))
    await db.delete(row)
    await db.flush()


async def prune_terminals(db: AsyncSession, user_id, *, older_than_days: int = TERMINAL_RETENTION_DAYS) -> int:
    """清理超过保留期的终端，避免历史输出无限增长。

    两类目标：① 已关闭且超过保留期的终端；② 孤儿 agent 终端——会话删除后
    `session_id` 被 SET NULL 置空，`closed_at` 永远不会有人设置，若只按关闭
    时间清理，这类终端和它的输出事件会永久残留。用户自建终端（source=user）
    不受孤儿规则影响，生命周期仍由用户在终端页手动管理。
    """
    cutoff = now_utc() - timedelta(days=max(1, older_than_days))
    result = await db.execute(select(TerminalSessionRecord).where(
        TerminalSessionRecord.owner_id == user_id,
        TerminalSessionRecord.updated_at < cutoff,
        or_(
            TerminalSessionRecord.closed_at.is_not(None),
            and_(
                TerminalSessionRecord.source == TerminalSource.AGENT.value,
                TerminalSessionRecord.session_id.is_(None),
            ),
        ),
    ))
    rows = list(result.scalars().all())
    for row in rows:
        await delete_terminal(db, row)
    return len(rows)


async def terminal_metrics(db: AsyncSession, user_id) -> dict:
    result = await db.execute(select(
        func.count(TerminalSessionRecord.id),
        func.coalesce(func.sum(TerminalSessionRecord.output_chars), 0),
    ).where(TerminalSessionRecord.owner_id == user_id))
    total, output_chars = result.one()
    running = await db.scalar(select(func.count(TerminalSessionRecord.id)).where(
        TerminalSessionRecord.owner_id == user_id,
        TerminalSessionRecord.status == TerminalStatus.RUNNING.value,
        TerminalSessionRecord.closed_at.is_(None),
    ))
    return {
        "total": int(total or 0), "running": int(running or 0),
        "outputChars": int(output_chars or 0),
        "retentionDays": TERMINAL_RETENTION_DAYS,
        "outputRetentionChars": TERMINAL_OUTPUT_RETENTION_CHARS,
    }


async def rename_terminal(db: AsyncSession, row: TerminalSessionRecord, name: str) -> TerminalSessionRecord:
    normalized = (name or "").strip()
    if not normalized:
        raise ValueError("终端名称不能为空")
    row.name = normalized[:200]
    row.updated_at = now_utc()
    await db.flush()
    return row


async def terminal_events(db: AsyncSession, row: TerminalSessionRecord, after: int = 0) -> list[TerminalEventRecord]:
    result = await db.execute(select(TerminalEventRecord).where(
        TerminalEventRecord.terminal_id == row.id,
        TerminalEventRecord.sequence > max(0, after),
    ).order_by(TerminalEventRecord.sequence.asc()))
    return list(result.scalars().all())


def serialize_event(row: TerminalEventRecord) -> dict:
    return {
        "sequence": row.sequence, "type": row.event_type, "source": row.source,
        "runId": row.run_id,
        "command": row.command, "stdout": row.stdout, "stderr": row.stderr,
        "exitCode": row.exit_code, "occurredAt": row.occurred_at.isoformat(),
    }
