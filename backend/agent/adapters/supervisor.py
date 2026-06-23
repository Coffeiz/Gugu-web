"""频道管家：为每个启用的 bot 起一个网关子进程，增删启停约 POLL_SEC 秒内生效。

两类 bot 两个来源：
  - 飞书（共享）：Admin 频道面板 → config.override.json，凭据走 argv（channel_id）
  - QQ（BYO 每用户自带）：user_bots 表，凭据走环境变量注入（避免 ps 泄漏 secret）

lark / botpy 的连接都没有 stop()、单连接断不掉 → 用进程级管理：启用 spawn、停用/删除 kill、
崩溃下轮自动重启。

运行（从 backend/ 跑加载 .env）：
    .venv/bin/python -m agent.adapters.supervisor
"""
from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
import time

from app.core.config import active_im_bots

POLL_SEC = 5
_procs: dict[str, subprocess.Popen] = {}
_stop = False
# 给 DB 查询用的常驻事件循环（复用同一 loop，保持 asyncpg engine 有效）
_loop = asyncio.new_event_loop()


async def _fetch_qq() -> list[dict]:
    import app.db.session as S
    if S._engine is None:
        S._build_engine()
    from sqlalchemy import select
    from app.models import UserBot
    async with S._SessionLocal() as db:
        rows = (await db.execute(
            select(UserBot).where(UserBot.platform == "qqbot", UserBot.enabled.is_(True))
        )).scalars().all()
        return [{
            "id": str(b.id), "app_id": b.app_id, "app_secret": b.app_secret,
            "sandbox": b.sandbox, "owner": str(b.user_id),
        } for b in rows]


def _desired() -> dict[str, dict]:
    """key → spawn spec。key 用 平台:id 命名空间，避免跨源撞 id。"""
    desired: dict[str, dict] = {}
    for b in active_im_bots("feishu"):
        desired[f"feishu:{b['id']}"] = {"kind": "feishu", "id": b["id"]}
    try:
        for b in _loop.run_until_complete(_fetch_qq()):
            desired[f"qq:{b['id']}"] = {"kind": "qq", **b}
    except Exception as e:
        print(f"[supervisor] 读取 QQ user_bots 失败（保持现状）: {type(e).__name__}: {e}", flush=True)
        for k in _procs:                       # DB 抖动时别误杀已在跑的 QQ 网关
            if k.startswith("qq:"):
                desired[k] = _procs_spec.get(k, {"kind": "qq"})
    return desired


# 记住每个 key 当初的 spec，DB 读失败时用于保活
_procs_spec: dict[str, dict] = {}


def _spawn(key: str, spec: dict) -> subprocess.Popen:
    print(f"[supervisor] ▶ 启动 {key}", flush=True)
    if spec["kind"] == "feishu":
        return subprocess.Popen([sys.executable, "-m", "agent.adapters.feishu", spec["id"]])
    # qq：凭据走环境变量
    env = {
        **os.environ,
        "QQ_BOT_ID": spec["id"], "QQ_APP_ID": spec["app_id"],
        "QQ_APP_SECRET": spec["app_secret"],
        "QQ_SANDBOX": "1" if spec["sandbox"] else "0",
        "QQ_OWNER": spec["owner"],
    }
    return subprocess.Popen([sys.executable, "-m", "agent.adapters.qq"], env=env)


def _kill(key: str, proc: subprocess.Popen) -> None:
    print(f"[supervisor] ■ 停止 {key}", flush=True)
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def reconcile() -> None:
    desired = _desired()
    for key, spec in desired.items():
        p = _procs.get(key)
        if p is None or p.poll() is not None:
            _procs[key] = _spawn(key, spec)
            _procs_spec[key] = spec
    for key in list(_procs):
        if key not in desired:
            _kill(key, _procs.pop(key))
            _procs_spec.pop(key, None)


def main() -> None:
    def _sig(*_a):
        global _stop
        _stop = True
    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)

    print(f"[supervisor] 频道管家启动（每 {POLL_SEC}s 同步一次配置）", flush=True)
    while not _stop:
        try:
            reconcile()
        except Exception as e:
            print(f"[supervisor] reconcile 出错: {type(e).__name__}: {e}", flush=True)
        for _ in range(POLL_SEC):
            if _stop:
                break
            time.sleep(1)

    for key, p in list(_procs.items()):
        _kill(key, p)
    print("[supervisor] 已停止", flush=True)


if __name__ == "__main__":
    main()
