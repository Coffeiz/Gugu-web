"""Compose updater 守护进程入口；Docker socket 只存在于此容器。"""

from __future__ import annotations

import asyncio
import os
import signal

from updater.daemon import UpdateDaemon
from updater.rpc import serve_unix


async def _run() -> None:
    if os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") not in {"split_compose", "integrated_compose"}:
        raise RuntimeError("updater RPC server 只允许受支持的 Compose 模式")
    daemon = UpdateDaemon()
    daemon.start_pending_restart_resume()
    socket_path = os.getenv("GUGU_UPDATER_RPC_SOCKET", "/run/gugu-updater/updater.sock")
    server = await serve_unix(socket_path, daemon.dispatch)
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    async with server:
        await stopped.wait()
    daemon_server_path = socket_path
    try:
        os.unlink(daemon_server_path)
    except FileNotFoundError:
        pass


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
