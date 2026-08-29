"""受控交互式 PTY 的生命周期管理。

本模块只管理 PTY 会话，不负责创建宿主机 Shell。真正的进程必须由
``SandboxPtyBridge`` 在受控沙箱内启动，避免 Web/API 进程绕过 Shell 安全边界。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Protocol


class PtyBridge(Protocol):
    """由 sandboxd 提供的 PTY 进程桥接接口。"""

    async def open(self, spec: "PtyLaunchSpec") -> "PtyHandle": ...


class PtyHandle(Protocol):
    pid: int
    sandbox_id: str

    async def write(self, data: bytes) -> None: ...

    async def resize(self, cols: int, rows: int) -> None: ...

    async def signal(self, signal_name: str) -> None: ...

    async def close(self, *, force: bool = False) -> None: ...

    def output(self) -> "asyncio.AsyncIterator[bytes]": ...


@dataclass(frozen=True)
class PtyLaunchSpec:
    """PTY 启动参数；Shell、用户和容器安全参数由桥接层固定生成。"""

    terminal_id: str
    root: str
    shell_mode: str
    network_profile: str
    cols: int = 120
    rows: int = 32

    def __post_init__(self) -> None:
        if not self.terminal_id:
            raise ValueError("PTY 缺少 terminal_id")
        if not self.root:
            raise ValueError("PTY 缺少沙盒根目录")
        if self.shell_mode not in {"sandbox", "system"}:
            raise ValueError("PTY shell_mode 无效")
        if self.network_profile not in {"none", "egress"}:
            raise ValueError("PTY network_profile 无效")
        if not 20 <= self.cols <= 500:
            raise ValueError("PTY cols 超出范围")
        if not 5 <= self.rows <= 200:
            raise ValueError("PTY rows 超出范围")


@dataclass
class ManagedPty:
    terminal_id: str
    handle: PtyHandle
    cols: int
    rows: int
    attached_clients: int = 0
    detached_at: float | None = None
    output_task: asyncio.Task[None] | None = field(default=None, repr=False)
    output_queues: set[asyncio.Queue[bytes | None]] = field(default_factory=set, repr=False)
    output_bytes: int = 0
    output_window_started: float = field(default_factory=time.monotonic, repr=False)
    output_window_bytes: int = 0

    def snapshot(self) -> dict[str, Any]:
        """导出供持久化层使用的运行快照，不包含输入和输出正文。"""
        return {
            "terminal_id": self.terminal_id,
            "pty_pid": self.handle.pid,
            "pty_sandbox_id": self.handle.sandbox_id,
            "pty_cols": self.cols,
            "pty_rows": self.rows,
            "attached_clients": self.attached_clients,
            "detached_at": self.detached_at,
        }


class PtyManager:
    """管理交互式 PTY 的生命周期和断线回收。"""

    def __init__(
        self,
        bridge: PtyBridge,
        *,
        detached_ttl_seconds: float = 900,
        max_output_bytes: int = 120 * 1024,
        max_output_rate: int = 256 * 1024,
        max_attached_clients: int = 2,
        reap_interval_seconds: float = 30,
    ) -> None:
        if detached_ttl_seconds <= 0:
            raise ValueError("PTY detached TTL 必须大于 0")
        self.bridge = bridge
        self.detached_ttl_seconds = detached_ttl_seconds
        if max_output_bytes < 1 or max_output_rate < 1:
            raise ValueError("PTY 输出限制必须大于 0")
        self.max_output_bytes = max_output_bytes
        self.max_output_rate = max_output_rate
        if max_attached_clients < 1 or reap_interval_seconds <= 0:
            raise ValueError("PTY 连接限制无效")
        self.max_attached_clients = max_attached_clients
        self.reap_interval_seconds = reap_interval_seconds
        self._sessions: dict[str, ManagedPty] = {}
        self._lock = asyncio.Lock()
        self._reaper_task: asyncio.Task[None] | None = None

    async def start(self, spec: PtyLaunchSpec) -> ManagedPty:
        async with self._lock:
            if spec.terminal_id in self._sessions:
                raise ValueError("PTY 终端已经运行")
            handle = await self.bridge.open(spec)
            session = ManagedPty(spec.terminal_id, handle, spec.cols, spec.rows)
            session.output_task = asyncio.create_task(self._pump_output(session))
            self._sessions[spec.terminal_id] = session
            return session

    async def start_with_subscription(
        self, spec: PtyLaunchSpec,
    ) -> tuple[ManagedPty, asyncio.Queue[bytes | None]]:
        """启动 PTY 并在启动输出泵前建立首个订阅，避免首屏提示符丢失。"""
        async with self._lock:
            if spec.terminal_id in self._sessions:
                raise ValueError("PTY 终端已经运行")
            handle = await self.bridge.open(spec)
            session = ManagedPty(spec.terminal_id, handle, spec.cols, spec.rows)
            queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=256)
            session.output_queues.add(queue)
            session.output_task = asyncio.create_task(self._pump_output(session))
            self._sessions[spec.terminal_id] = session
            return session, queue

    async def attach(self, terminal_id: str) -> ManagedPty:
        async with self._lock:
            session = self._require(terminal_id)
            if session.attached_clients >= self.max_attached_clients:
                raise RuntimeError("PTY 活动连接数已达上限")
            session.attached_clients += 1
            session.detached_at = None
            return session

    async def subscribe(self, terminal_id: str) -> asyncio.Queue[bytes | None]:
        async with self._lock:
            session = self._require(terminal_id)
            queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=256)
            session.output_queues.add(queue)
            return queue

    async def unsubscribe(self, terminal_id: str, queue: asyncio.Queue[bytes | None]) -> None:
        """解绑单个连接的输出队列，避免断线连接长期占用内存。"""
        async with self._lock:
            session = self._sessions.get(terminal_id)
            if session is not None:
                session.output_queues.discard(queue)

    async def detach(self, terminal_id: str) -> None:
        async with self._lock:
            session = self._require(terminal_id)
            session.attached_clients = max(0, session.attached_clients - 1)
            if session.attached_clients == 0:
                session.detached_at = time.monotonic()

    async def write(self, terminal_id: str, data: bytes) -> None:
        if not data:
            return
        async with self._lock:
            session = self._require(terminal_id)
            if session.attached_clients < 1:
                raise RuntimeError("PTY 没有活动连接")
            handle = session.handle
        await handle.write(data)

    async def resize(self, terminal_id: str, cols: int, rows: int) -> None:
        PtyLaunchSpec(
            terminal_id=terminal_id, root="pty", shell_mode="sandbox", network_profile="none",
            cols=cols, rows=rows,
        )
        async with self._lock:
            session = self._require(terminal_id)
            handle = session.handle
        await handle.resize(cols, rows)
        async with self._lock:
            session = self._require(terminal_id)
            session.cols, session.rows = cols, rows

    async def signal(self, terminal_id: str, signal_name: str) -> None:
        if signal_name not in {"SIGINT", "SIGTERM", "SIGTSTP"}:
            raise ValueError("PTY signal 不受支持")
        async with self._lock:
            handle = self._require(terminal_id).handle
        await handle.signal(signal_name)

    async def terminate(self, terminal_id: str, *, force: bool = False) -> None:
        async with self._lock:
            session = self._require(terminal_id)
            handle = session.handle
        await handle.close(force=force)
        await self._remove(terminal_id)

    async def reap_detached(self, *, now: float | None = None) -> list[str]:
        current = time.monotonic() if now is None else now
        async with self._lock:
            expired = [
                terminal_id for terminal_id, session in self._sessions.items()
                if session.attached_clients == 0
                and session.detached_at is not None
                and current - session.detached_at >= self.detached_ttl_seconds
            ]
        for terminal_id in expired:
            await self.terminate(terminal_id, force=True)
        return expired

    async def close_all(self) -> None:
        await self.stop_reaper()
        async with self._lock:
            terminal_ids = list(self._sessions)
        for terminal_id in terminal_ids:
            await self.terminate(terminal_id, force=True)

    def start_reaper(self) -> None:
        """启动进程级 TTL 回收；重复调用不会创建多个后台任务。"""
        if self._reaper_task is None or self._reaper_task.done():
            self._reaper_task = asyncio.create_task(self._reap_loop())

    async def stop_reaper(self) -> None:
        task, self._reaper_task = self._reaper_task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _reap_loop(self) -> None:
        while True:
            await asyncio.sleep(self.reap_interval_seconds)
            await self.reap_detached()

    def get(self, terminal_id: str) -> ManagedPty | None:
        return self._sessions.get(terminal_id)

    def snapshots(self) -> list[dict[str, Any]]:
        """返回当前进程快照；调用方只能把它用于状态校正，不能据此恢复假进程。"""
        return [session.snapshot() for session in self._sessions.values()]

    async def _pump_output(self, session: ManagedPty) -> None:
        try:
            async for chunk in session.handle.output():
                if not chunk:
                    continue
                now = time.monotonic()
                if now - session.output_window_started >= 1:
                    session.output_window_started = now
                    session.output_window_bytes = 0
                session.output_bytes += len(chunk)
                session.output_window_bytes += len(chunk)
                if session.output_bytes > self.max_output_bytes or session.output_window_bytes > self.max_output_rate:
                    await session.handle.close(force=True)
                    break
                for queue in tuple(session.output_queues):
                    try:
                        queue.put_nowait(chunk)
                    except asyncio.QueueFull:
                        # 读端落后时终止连接，不能无限制堆积 PTY 输出。
                        session.output_queues.discard(queue)
                        queue.put_nowait(None)
        finally:
            for queue in tuple(session.output_queues):
                session.output_queues.discard(queue)
                try:
                    queue.put_nowait(None)
                except asyncio.QueueFull:
                    pass
            async with self._lock:
                if self._sessions.get(session.terminal_id) is session:
                    self._sessions.pop(session.terminal_id, None)

    async def _remove(self, terminal_id: str) -> None:
        async with self._lock:
            session = self._sessions.pop(terminal_id, None)
        if session and session.output_task and session.output_task is not asyncio.current_task():
            session.output_task.cancel()
            await asyncio.gather(session.output_task, return_exceptions=True)

    def _require(self, terminal_id: str) -> ManagedPty:
        session = self._sessions.get(terminal_id)
        if session is None:
            raise LookupError("PTY 终端不存在")
        return session
