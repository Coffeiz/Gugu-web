"""Admin 服务面板：看常驻进程状态 + 重启。

状态来自各进程写的 Redis 心跳（app/core/health.py）。web 自身状态本进程直接报。
重启 = 按心跳里的 pid 发 SIGTERM（杀前核对 /proc/{pid}/cmdline + 同主机）。然后**自动适配**：
- 有 systemd 单元（`systemctl is-enabled gugu-{name}`）→ 交给 systemd `Restart=always` 拉起；
- 否则（dev / 手动起）→ 等旧进程退出后由后端自己重新拉起（detached），避免 gateway 双连。
"""
from __future__ import annotations

import asyncio
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.core import health, redis as R

router = APIRouter(prefix="/admin/services", tags=["admin"])

# backend/ 目录（self-respawn 用作 cwd）：本文件在 backend/app/api/v1/
_BACKEND = Path(__file__).resolve().parents[3]
# self-respawn 时的启动命令
_MODULES = {
    "worker": ["-m", "worker"],
    "gateway": ["-m", "agent.gateway.gateway"],
}


def _systemd_managed(name: str) -> bool:
    """该服务是否由 systemd 托管（is-enabled 返回 0）。无 systemctl 视为否。"""
    try:
        r = subprocess.run(["systemctl", "is-enabled", f"gugu-{name}"],
                           capture_output=True, timeout=3)
        return r.returncode == 0
    except Exception:
        return False


async def _wait_dead(pid: int, timeout: float = 8.0) -> bool:
    for _ in range(int(timeout * 2)):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        await asyncio.sleep(0.5)
    return False


def _respawn(name: str) -> int:
    """后端自行拉起一个 detached 进程（dev/无 systemd 时），日志落 logs/gugu-{name}.log。"""
    logs = _BACKEND / "logs"
    logs.mkdir(exist_ok=True)
    out = open(logs / f"gugu-{name}.log", "ab")
    p = subprocess.Popen(
        [sys.executable, *_MODULES[name]],
        cwd=str(_BACKEND), start_new_session=True, stdout=out, stderr=out,
    )
    return p.pid


async def _db_ok() -> bool:
    try:
        import app.db.session as _sess
        if _sess._engine is None:
            _sess._build_engine()
        from sqlalchemy import text
        async with _sess._SessionLocal() as db:
            await db.execute(text("SELECT 1"))
        return True
    except Exception:
        return False

async def _queue_info() -> dict:
    """IM 入站队列积压（给服务面板看 worker 吃不吃得消）。
    lag=已进队列还没被 worker 取走（真积压）；pending=取走了还没 ack（在处理中或卡住）。"""
    try:
        r = R.get_redis()
        stream = R.IM_INBOUND_STREAM
        length = await r.xlen(stream)
        pending, lag, consumers = 0, None, 0
        try:
            for g in await r.xinfo_groups(stream):
                if g.get("name") == "agent-workers":   # = worker.py 的 GROUP
                    pending = g.get("pending", 0)
                    lag = g.get("lag")
                    consumers = g.get("consumers", 0)
        except Exception:
            pass   # 流/组还没建（没来过消息）
        return {"length": length, "pending": pending, "lag": lag, "consumers": consumers}
    except Exception:
        return {"length": None, "pending": None, "lag": None, "consumers": None}


_WEB_START = time.time()
_HOST = socket.gethostname()

# 可重启的常驻进程：name → cmdline 里应出现的标识（防误杀 / pid 复用）
RESTARTABLE = {
    "worker": "worker",
    "gateway": "agent.gateway.gateway",
}


def _status_from(info: dict | None) -> str:
    if not info:
        return "offline"
    age = int(time.time()) - int(info.get("ts", 0))
    return "stale" if age > health.INTERVAL * 3 else "online"


@router.get("")
async def list_services():
    beats = await health.read_all()
    now = int(time.time())

    services = [{
        "name": "web",
        "label": "Web 后端",
        "status": "online",
        "pid": os.getpid(),
        "host": _HOST,
        "uptime_secs": int(time.time() - _WEB_START),
        "restartable": False,        # 重启会断开当前请求，不在面板做
        "extra": {},
    }]

    for name, label in (("gateway", "网关管家"), ("worker", "消息 worker")):
        info = beats.get(name)
        services.append({
            "name": name,
            "label": label,
            "status": _status_from(info),
            "pid": info.get("pid") if info else None,
            "host": info.get("host") if info else None,
            "last_seen_secs": (now - int(info["ts"])) if info else None,
            "restartable": True,
            "extra": info.get("extra", {}) if info else {},
        })

    deps = {"redis": await R.ping(), "db": await _db_ok()}
    return {"services": services, "deps": deps, "queue": await _queue_info()}


@router.post("/{name}/restart")
async def restart_service(name: str):
    if name not in RESTARTABLE:
        raise HTTPException(400, f"不支持重启 {name}")

    info = (await health.read_all()).get(name)
    if not info:
        # 没心跳：进程已挂；若配了 systemd Restart=always 它应自行拉起
        return {"ok": False, "msg": f"{name} 当前无心跳（可能已挂）。若配了 systemd Restart=always，它会自动拉起；否则需手动启动。"}

    if info.get("host") != _HOST:
        return {"ok": False, "msg": f"{name} 在另一台主机（{info.get('host')}）上，本机无法重启。"}

    pid = int(info["pid"])
    marker = RESTARTABLE[name]
    if marker not in health.proc_cmdline(pid):
        return {"ok": False, "msg": f"pid {pid} 命令行不匹配（可能已重启或 pid 复用），已跳过，避免误杀。"}

    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return {"ok": False, "msg": f"进程 {pid} 不存在（可能刚退出）。"}
    except PermissionError:
        return {"ok": False, "msg": f"无权限 kill pid {pid}（web 与 {name} 需同用户运行）。"}

    # systemd 托管 → 交给它拉起；否则后端自己拉（等旧进程退出，避免双实例/双连接）
    if _systemd_managed(name):
        return {"ok": True, "msg": f"已重启 {name}(pid {pid})，systemd 将在几秒内自动拉起。"}

    if not await _wait_dead(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
        await _wait_dead(pid, timeout=3)
    try:
        new_pid = _respawn(name)
    except Exception as e:
        return {"ok": False, "msg": f"已杀掉旧 {name}，但自动拉起失败：{e}"}
    return {"ok": True, "msg": f"已重启 {name}：旧 pid {pid} → 新 pid {new_pid}（后端自管理，非 systemd）。"}
