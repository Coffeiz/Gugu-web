"""生产 PTY 运行时构造。

该模块是 Web/API 接入 PTY Manager 的唯一默认入口，确保交互式终端始终通过
sandboxd transport 启动，不因调用方遗漏 bridge 而退回本机 Shell。
"""

from __future__ import annotations

from app.core.config import get_settings

from .pty_manager import PtyManager
from .sandbox_bridge import SandboxPtyBridge

_manager: PtyManager | None = None


def get_pty_manager() -> PtyManager:
    global _manager
    if _manager is None:
        sandbox = get_settings().sandbox
        _manager = PtyManager(
            SandboxPtyBridge.from_socket(sandbox.sandboxd_socket),
            max_output_bytes=sandbox.pty_output_limit_bytes,
            max_output_rate=sandbox.pty_output_rate_bytes,
        )
    return _manager


def start_pty_manager() -> PtyManager:
    manager = get_pty_manager()
    manager.start_reaper()
    return manager


async def close_pty_manager() -> None:
    global _manager
    if _manager is not None:
        await _manager.close_all()
        _manager = None


__all__ = ["close_pty_manager", "get_pty_manager", "start_pty_manager"]
