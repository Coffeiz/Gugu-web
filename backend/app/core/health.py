"""服务心跳：常驻进程（worker / supervisor）周期写 Redis，Admin 面板据此看状态 + 重启。

每个进程每 ~5s 写 `health:{name}` = {name, pid, host, ts, cmdline, extra}，TTL 20s：
键在=在线、键过期=掉线、键在但 ts 老=僵死。重启走 kill+systemd 自愈（按 pid 发 SIGTERM，
杀前用 /proc/{pid}/cmdline 核对防误杀），见 app/api/v1/services_admin.py。
"""
from __future__ import annotations

import json
import os
import socket
import time

from app.core import redis as R

PREFIX = "health:"
TTL = 20
INTERVAL = 5


def proc_cmdline(pid: int) -> str:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().decode("utf-8", "replace").replace("\x00", " ").strip()
    except Exception:
        return ""


def _payload(name: str, extra: dict | None) -> str:
    return json.dumps({
        "name": name,
        "pid": os.getpid(),
        "host": socket.gethostname(),
        "ts": int(time.time()),
        "cmdline": proc_cmdline(os.getpid()),
        "extra": extra or {},
    }, ensure_ascii=False)


async def beat(name: str, extra: dict | None = None) -> None:
    try:
        await R.get_redis().set(PREFIX + name, _payload(name, extra), ex=TTL)
    except Exception:
        pass


def beat_sync(name: str, extra: dict | None = None) -> None:
    try:
        R.get_redis_sync().set(PREFIX + name, _payload(name, extra), ex=TTL)
    except Exception:
        pass


async def read_all() -> dict[str, dict]:
    """读所有 health:* → {name: payload}。"""
    r = R.get_redis()
    out: dict[str, dict] = {}
    try:
        async for k in r.scan_iter(match=PREFIX + "*"):
            v = await r.get(k)
            if not v:
                continue
            try:
                out[k[len(PREFIX):]] = json.loads(v)
            except Exception:
                pass
    except Exception:
        pass
    return out
