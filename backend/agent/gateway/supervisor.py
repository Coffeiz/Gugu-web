"""频道管家：为每个启用的 user_bot 起一个网关子进程，增删启停约 POLL_SEC 秒内生效。

飞书 / QQ 都是 BYO（每用户自带 bot）：凭据存 `user_bots` 表（用户在设置里 device-flow
扫码创建），supervisor 从 DB 读启用列表，每个起一条网关子进程，凭据走**环境变量注入**
（不走 argv，避免 ps 泄漏 secret）。

lark / botpy 的连接都没有 stop()、单连接断不掉 → 进程级管理：启用 spawn、停用/删除 kill、
崩溃下轮自动重启。

运行（从 backend/ 跑加载 .env）：
    .venv/bin/python -m agent.gateway.supervisor
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
    "feishu": "agent.gateway.feishu",
    "qqbot":  "agent.gateway.qq",
    "wechat": "agent.gateway.wechat",
}
_procs: dict[str, subprocess.Popen] = {}
_procs_spec: dict[str, dict] = {}
_spawned_at: dict[str, float] = {}     # key -> 上次启动时刻，判断是否「秒崩」
_fail_count: dict[str, int] = {}       # key -> 连续秒崩次数，驱动指数退避
_next_retry_at: dict[str, float] = {}  # key -> 下次允许重启的时刻（秒崩时才会设）
_stop = False
FAST_CRASH_SEC = 5     # 存活不到这个时长 = 判定「秒崩」（多半是凭据错误等必现问题，不是网络抖动）
BACKOFF_BASE_SEC = 10
BACKOFF_MAX_SEC = 300   # 封顶 5 分钟，仍保留自愈能力（用户改好凭据后最多 5 分钟内自动捡回）
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
    elif spec["platform"] == "wechat":
        # 微信 iLink：bot_token 存在 app_secret、base_url 存在 app_id（复用现有字段）
        env.update({
            "WECHAT_BOT_ID": spec["id"], "WECHAT_BOT_TOKEN": spec["app_secret"],
            "WECHAT_BASE_URL": spec["app_id"], "WECHAT_OWNER": spec["owner"],
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
    now = time.time()
    for key, spec in desired.items():
        p = _procs.get(key)
        if p is None:
            _procs[key] = _spawn(key, spec)
            _procs_spec[key] = spec
            _spawned_at[key] = now
            continue
        if p.poll() is None:
            continue   # 还活着
        # 进程已退出。key 在 _next_retry_at 里 = 已经分类过、正在退避等待中，
        # 不能再用旧的 _spawned_at 重新判断「秒崩」（退避越久，lived 会越长、误判成"不是秒崩"）。
        if key in _next_retry_at:
            if now < _next_retry_at[key]:
                continue   # 还没到重试时间，继续等
            _next_retry_at.pop(key, None)   # 到点了，respawn，退出「等待」状态
        else:
            # 首次发现这次退出：判断是不是「秒崩」（多半凭据错误等必现问题）
            lived = now - _spawned_at.get(key, now)
            if lived < FAST_CRASH_SEC:
                _fail_count[key] = _fail_count.get(key, 0) + 1
                backoff = min(BACKOFF_BASE_SEC * (2 ** (_fail_count[key] - 1)), BACKOFF_MAX_SEC)
                _next_retry_at[key] = now + backoff
                print(f"[supervisor] {key} 启动后 {lived:.1f}s 内退出（第 {_fail_count[key]} 次连续秒崩，"
                      f"疑似凭据错误），退避 {backoff:.0f}s 后再试", flush=True)
                continue   # 这次先不重启，等退避到期的 tick 再重启
            _fail_count[key] = 0   # 跑了一阵子才挂，多半是网络抖动之类，不算秒崩，重置计数、立即重启
        _procs[key] = _spawn(key, spec)
        _procs_spec[key] = spec
        _spawned_at[key] = now
    for key in list(_procs):
        if key not in desired:
            _kill(key, _procs.pop(key))
            _procs_spec.pop(key, None)
            _spawned_at.pop(key, None)
            _fail_count.pop(key, None)
            _next_retry_at.pop(key, None)


def main() -> None:
    def _sig(*_a):
        global _stop
        _stop = True
    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)

    from app.core import health
    print(f"[supervisor] 频道管家启动（每 {POLL_SEC}s 同步一次配置）", flush=True)
    while not _stop:
        try:
            reconcile()
        except Exception as e:
            print(f"[supervisor] reconcile 出错: {type(e).__name__}: {e}", flush=True)
        # 心跳：带上当前在跑的网关列表（给 Admin 服务面板）
        gateways = [
            {"key": k, "platform": _procs_spec.get(k, {}).get("platform", ""),
             "owner": _procs_spec.get(k, {}).get("owner", "")}
            for k in _procs
        ]
        health.beat_sync("supervisor", {"gateways": gateways, "count": len(gateways)})
        for _ in range(POLL_SEC):
            if _stop:
                break
            time.sleep(1)

    for key, p in list(_procs.items()):
        _kill(key, p)
    print("[supervisor] 已停止", flush=True)


if __name__ == "__main__":
    main()
