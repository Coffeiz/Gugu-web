"""共享协作终端的数据契约。

这里先定义 Agent、Web 和后续 Terminal API 共用的稳定形状；终端进程、PTY
和持久化实现留在后续阶段，避免在契约阶段绑定具体执行器。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


class TerminalSource(StrEnum):
    USER = "user"
    AGENT = "agent"


class TerminalStatus(StrEnum):
    IDLE = "idle"
    RUNNING = "running"
    WAITING_CONFIRM = "waiting_confirm"
    EXITED = "exited"
    FAILED = "failed"
    TERMINATED = "terminated"


class TerminalShellMode(StrEnum):
    SANDBOX = "sandbox"
    SYSTEM = "system"


class TerminalMode(StrEnum):
    """终端执行协议；两种模式共享记录，但不共享输入通道。"""

    INTERACTIVE_PTY = "interactive-pty"
    AGENT_EVENTS = "agent-events"


@dataclass(frozen=True)
class TerminalSession:
    """终端会话的跨层最小契约，不代表数据库模型。"""

    terminal_id: str
    owner_id: str
    session_id: int | None
    workspace_id: int | None
    source: TerminalSource
    mode: TerminalMode
    status: TerminalStatus
    shell_mode: TerminalShellMode
    network_profile: str
    created_at: datetime
    updated_at: datetime
    closed_at: datetime | None = None
    pty_pid: int | None = None
    pty_sandbox_id: str | None = None
    pty_cols: int | None = None
    pty_rows: int | None = None
    attached_clients: int = 0
    last_attached_at: datetime | None = None
    detached_at: datetime | None = None


@dataclass(frozen=True)
class TerminalCommand:
    """终端命令元数据；命令正文只在受控执行链路内部传递。"""

    terminal_id: str
    command_id: str
    source: TerminalSource
    submitted_at: datetime


@dataclass(frozen=True)
class TerminalEvent:
    """可重放的终端事件契约。"""

    terminal_id: str
    sequence: int
    event_type: str
    occurred_at: datetime
    source: TerminalSource | None = None
    exit_code: int | None = None
