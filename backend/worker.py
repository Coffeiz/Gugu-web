"""IM 消息 worker：独立进程，消费队列 → 跑非流式 agent →（暂打印）→ ack。

独立于 web 进程运行（避免多 uvicorn worker 各自重复消费长连接/队列）。
启动（从 backend/ 跑，加载 .env）：
    .venv/bin/python -m worker      # 或 python worker.py

消息体（由网关 produce，step 6 补平台用户→咕咕用户映射）：
    {platform, platform_user_id, user_id, user_name, text, session_id?}

step 3 阶段只打印回复、不发平台；发送在 step 5 接平台时补。
"""
from __future__ import annotations

import asyncio
import os
import signal
import socket

from app.core import redis as R
from agent.models import AgentRequest
from agent.runner import run_collect

STREAM = R.IM_INBOUND_STREAM
GROUP = "agent-workers"
CONSUMER = f"{socket.gethostname()}-{os.getpid()}"

_stop = asyncio.Event()


async def _resolve_user(payload: dict):
    """平台用户 → 咕咕 user_id。
    TODO: 用绑定表 (platform, platform_user_id)→user_id 替换。
    当前临时取数据库首个用户，仅供"试效果"，绑定流程做好后改掉。
    """
    if payload.get("user_id"):
        return payload["user_id"], payload.get("user_name", "")
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from sqlalchemy import select
    from app.models import User
    async with _sess._SessionLocal() as db:
        u = (await db.execute(select(User).limit(1))).scalars().first()
    return (str(u.id), u.username) if u else (None, "")


async def handle(msg_id: str, payload: dict):
    """处理一条：解析用户 → 跑非流式 agent → 发回平台。"""
    user_id, user_name = await _resolve_user(payload)
    if not user_id:
        print("[worker] 无法解析用户，跳过", flush=True)
        return None
    req = AgentRequest(
        message=payload.get("text", ""),
        user_id=user_id, user_name=user_name,
        session_id=payload.get("session_id"),
        source=payload.get("platform", "worker"),
    )
    resp = await run_collect(req)

    # 发回平台
    platform = payload.get("platform")
    if platform == "feishu" and payload.get("chat_id"):
        from agent.adapters import feishu
        await asyncio.to_thread(feishu.send_text, payload["chat_id"], resp.text)
        print(f"[worker] feishu 回复 → {resp.text!r}", flush=True)
    else:
        who = f"{platform}/{payload.get('platform_user_id')}"
        print(f"[worker] {who} {req.message!r} → {resp.text!r}", flush=True)
    return resp


async def run_once(block_ms: int = 5000) -> int:
    """消费一批并处理。返回处理条数。先回收崩溃 worker 的遗留，再收新消息。"""
    handled = 0
    # 回收待处理超 60s 的（崩溃 worker 遗留），与新消息一并处理
    stale = await R.claim_stale(STREAM, GROUP, CONSUMER, min_idle_ms=60000, count=10)
    msgs = stale + await R.consume(STREAM, GROUP, CONSUMER, count=10, block_ms=block_ms)
    for msg_id, payload in msgs:
        try:
            await handle(msg_id, payload)
        except Exception as e:
            print(f"[worker] handle 出错（已 ack 丢弃，避免毒消息循环）: {type(e).__name__}: {e}", flush=True)
        finally:
            await R.ack(STREAM, GROUP, msg_id)
            handled += 1
    return handled


async def serve():
    await R.ensure_group(STREAM, GROUP)
    print(f"[worker] started · consumer={CONSUMER} · stream={STREAM}", flush=True)
    while not _stop.is_set():
        try:
            await run_once()
        except Exception as e:
            print(f"[worker] loop 出错，2s 后重试: {type(e).__name__}: {e}", flush=True)
            await asyncio.sleep(2)
    await R.reset()
    print("[worker] stopped", flush=True)


def _install_signals(loop):
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _stop.set)
        except NotImplementedError:
            pass  # 某些平台不支持


def main():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _install_signals(loop)
    try:
        loop.run_until_complete(serve())
    finally:
        loop.close()


if __name__ == "__main__":
    main()
