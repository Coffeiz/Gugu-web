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


_DEFAULT_HINT = "你好，我是咕咕 🐦\n这个机器人还没和咕咕账号关联好，去咕咕「个人设置 → 接入咕咕」重新扫码连接一下吧。"


async def _resolve_user(payload: dict):
    """平台用户 → 咕咕 user_id。飞书/QQ 都是 BYO：bot 即归属，payload 自带
    owner_user_id，直接用（查昵称即可）。返回 (user_id, display_name)；认不出 (None, "")。"""
    owner = payload.get("owner_user_id")
    if not owner:
        return None, ""
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import User
    async with _sess._SessionLocal() as db:
        u = await db.get(User, owner)
    return (owner, (u.display_name or "")) if u else (None, "")


async def _send(payload: dict, text: str):
    """按平台把文本发回。"""
    platform = payload.get("platform")
    if platform == "feishu" and payload.get("chat_id"):
        from agent.adapters import feishu
        await feishu.send_text(payload["chat_id"], text, payload.get("channel_id"))
    elif platform == "qqbot" and payload.get("platform_user_id"):
        from agent.adapters import qq
        await qq.send_c2c(payload["platform_user_id"], text,
                          payload.get("message_id"), payload.get("channel_id"))
    else:
        print(f"[worker] (无发送通道) {platform}: {text!r}", flush=True)


# IM 会话映射：按 (platform, 平台用户) 记一个稳定 session_id，续聊不断。
# 滑动 TTL：每条消息刷新，空闲超 IM_SESSION_TTL 自动起新会话。
IM_SESSION_TTL = 12 * 3600  # 12 小时


def _im_sess_key(platform: str, puid: str) -> str:
    return f"imsession:{platform}:{puid}"


async def _im_session_get(platform: str, puid: str):
    if not platform or not puid:
        return None
    raw = await R.get_redis().get(_im_sess_key(platform, puid))
    try:
        return int(raw) if raw else None
    except (TypeError, ValueError):
        return None


async def _im_session_set(platform: str, puid: str, session_id):
    if platform and puid and session_id:
        await R.get_redis().set(_im_sess_key(platform, puid), str(session_id), ex=IM_SESSION_TTL)


async def handle(msg_id: str, payload: dict):
    """处理一条：解析用户 → 未绑定回提示 / 已绑定跑 agent（带会话历史）→ 发回平台。"""
    user_id, user_name = await _resolve_user(payload)
    if not user_id:
        # 认不出（bot 没 owner，理论上不该发生）：回提示，不跑大脑
        await _send(payload, _DEFAULT_HINT)
        print(f"[worker] 未绑定用户 {payload.get('platform_user_id')}，已回提示", flush=True)
        return None

    platform = payload.get("platform", "worker")
    puid = payload.get("platform_user_id")
    sid = payload.get("session_id") or await _im_session_get(platform, puid)

    req = AgentRequest(
        message=payload.get("text", ""),
        user_id=user_id, user_name=user_name,
        session_id=sid,
        source=platform,
    )
    resp = await run_collect(req)
    await _im_session_set(platform, puid, resp.session_id)   # 续上同一会话
    await _send(payload, resp.text)
    print(f"[worker] {platform} 回复(session={resp.session_id}) → {resp.text!r}", flush=True)
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


async def _heartbeat():
    from app.core import health
    while not _stop.is_set():
        await health.beat("worker", {"consumer": CONSUMER})
        for _ in range(health.INTERVAL):
            if _stop.is_set():
                break
            await asyncio.sleep(1)


async def serve():
    await R.ensure_group(STREAM, GROUP)
    print(f"[worker] started · consumer={CONSUMER} · stream={STREAM}", flush=True)
    hb = asyncio.create_task(_heartbeat())
    while not _stop.is_set():
        try:
            await run_once()
        except Exception as e:
            print(f"[worker] loop 出错，2s 后重试: {type(e).__name__}: {e}", flush=True)
            await asyncio.sleep(2)
    hb.cancel()
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
