"""频道管家：按 Admin「频道」面板的启用列表，每个频道起一个网关子进程。

lark 无 stop()、单连接断不掉 → 用进程级管理：启用→spawn 子进程，停用/删除→kill。
轮询配置（active_im_bots 每次现读 override 文件），面板增删约 POLL_SEC 秒内生效；
子进程崩溃下轮自动重启。

运行（从 backend/ 跑加载 .env，取代直接跑 feishu 网关）：
    .venv/bin/python -m agent.adapters.supervisor
"""
from __future__ import annotations

import signal
import subprocess
import sys
import time

from app.core.config import active_im_bots

POLL_SEC = 5
_procs: dict[str, subprocess.Popen] = {}
_stop = False


def _desired_feishu() -> set[str]:
    """当前应在运行的飞书频道 id 集合。"""
    return {b["id"] for b in active_im_bots("feishu")}


def _spawn(channel_id: str) -> subprocess.Popen:
    print(f"[supervisor] ▶ 启动频道 {channel_id}", flush=True)
    return subprocess.Popen([sys.executable, "-m", "agent.adapters.feishu", channel_id])


def _kill(channel_id: str, proc: subprocess.Popen) -> None:
    print(f"[supervisor] ■ 停止频道 {channel_id}", flush=True)
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def reconcile() -> None:
    desired = _desired_feishu()
    # 启动新增的，或重启已崩溃的
    for ch in desired:
        p = _procs.get(ch)
        if p is None or p.poll() is not None:
            _procs[ch] = _spawn(ch)
    # 停止已移除/停用的
    for ch in list(_procs):
        if ch not in desired:
            _kill(ch, _procs.pop(ch))


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

    for ch, p in list(_procs.items()):
        _kill(ch, p)
    print("[supervisor] 已停止", flush=True)


if __name__ == "__main__":
    main()
