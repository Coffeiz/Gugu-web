"""频道管家：为每个启用的 user_bot 起一个网关子进程，增删启停约 POLL_SEC 秒内生效。

飞书 / QQ 都是 BYO（每用户自带 bot）：凭据存 `user_bots` 表（用户在设置里 device-flow
扫码创建），supervisor 从 DB 读启用列表，每个起一条网关子进程，凭据走**环境变量注入**
（不走 argv，避免 ps 泄漏 secret）。

lark / botpy 的连接都没有 stop()、单连接断不掉 → 进程级管理：启用 spawn、停用/删除 kill、
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

POLL_SEC = 5
# 平台 → 网关模块
PLATFORM_MODULE = {
    "feishu": "agent.adapters.feishu",
    "qqbot":  "agent.adapters.qq",
}
_procs: dict[str, subprocess.Popen] = {}
_procs_spec: dict[str, dict] = {}
_stop = False
# 给 DB 查询用的常驻事件循环（复用同一 loop，保持 asyncpg engine 有效）
_loop = asyncio.new_event_loop()


async def _fetch_userbots() -> list[dict]:
    import app.db.session as S
    if S._engine is None:
        S._build_engine()
    from sqlalchemy import select
    from app.models import UserBot
    async with S._SessionLocal() as db:
        rows = (await db.execute(
            select(UserBot).where(UserBot.enabled.is_(True))
        )).scalars().all()
        return [{
            "id": str(b.id), "platform": b.platform,
            "app_id": b.app_id, "app_secret": b.app_secret,
            "sandbox": b.sandbox, "owner": str(b.user_id),
        } for b in rows]


def _desired() -> dict[str, dict]:
    """key(platform:id) → spawn spec。DB 抖动时保活已在跑的，不误杀。"""
    try:
        bots = _loop.run_until_complete(_fetch_userbots())
    except Exception as e:
        print(f"[supervisor] 读取 user_bots 失败（保持现状）: {type(e).__name__}: {e}", flush=True)
        return dict(_procs_spec)
    desired: dict[str, dict] = {}
    for b in bots:
        if b["platform"] in PLATFORM_MODULE:
            desired[f"{b['platform']}:{b['id']}"] = b
    return desired


def _spawn(key: str, spec: dict) -> subprocess.Popen:
    print(f"[supervisor] ▶ 启动 {key}", flush=True)
    module = PLATFORM_MODULE[spec["platform"]]
    env = {**os.environ}
    if spec["platform"] == "feishu":
        env.update({
            "FEISHU_BOT_ID": spec["id"], "FEISHU_APP_ID": spec["app_id"],
            "FEISHU_APP_SECRET": spec["app_secret"], "FEISHU_OWNER": spec["owner"],
        })
    else:  # qqbot
        env.update({
            "QQ_BOT_ID": spec["id"], "QQ_APP_ID": spec["app_id"],
            "QQ_APP_SECRET": spec["app_secret"],
            "QQ_SANDBOX": "1" if spec["sandbox"] else "0",
            "QQ_OWNER": spec["owner"],
        })
    return subprocess.Popen([sys.executable, "-m", module], env=env)


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
