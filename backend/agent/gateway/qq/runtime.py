"""QQ raw WebSocket 连接、心跳、重连与平台进程入口。"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import suppress

import aiohttp

from .client import (
    _qq_access_token,
    _qq_gateway_url,
    close_qq_http_session,
    start_qq_http_session,
)
from .events import _handle_qq_interaction, _handle_raw_qq_message

_log = logging.getLogger("agent.gateway.qq")

_OP_DISPATCH = 0

_OP_HEARTBEAT = 1

_OP_IDENTIFY = 2

_OP_RESUME = 6

_OP_RECONNECT = 7

_OP_INVALID_SESSION = 9

_OP_HELLO = 10

_OP_HEARTBEAT_ACK = 11

_INTENT_GROUP_AND_C2C = 1 << 25

_INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30

_INTENT_DIRECT_MESSAGE = 1 << 12

_INTENT_INTERACTION = 1 << 26

_INTENTS = (
    _INTENT_GROUP_AND_C2C
    | _INTENT_PUBLIC_GUILD_MESSAGES
    | _INTENT_DIRECT_MESSAGE
    | _INTENT_INTERACTION
)

_RECONNECT_DELAYS = [1, 2, 5, 10, 30, 60]

_HEARTBEAT_ACK_TIMEOUT_MULTIPLIER = 2.5

def _heartbeat_ack_expired(last_ack_at: float, interval: float, now: float) -> bool:
    """连续超过两个心跳周期未获确认时，认为网关连接已失效。"""
    return now - last_ack_at >= interval * _HEARTBEAT_ACK_TIMEOUT_MULTIPLIER

async def _run_raw_ws(app_id: str, secret: str, sandbox: bool, channel_id: str, owner: str) -> None:
    from agent.security import logsafe

    channel_fp = logsafe.fingerprint(channel_id)
    session_id = None
    last_seq = None
    reconnect_attempt = 0
    last_ack: dict = {}
    while True:
        try:
            token = await _qq_access_token(app_id, secret)
            gateway = await _qq_gateway_url(token, sandbox)
            async with aiohttp.ClientSession() as sess:
                async with sess.ws_connect(gateway, heartbeat=None, receive_timeout=None) as ws:
                    print(f"[qq:{logsafe.fingerprint(channel_id)}] raw WebSocket 已连接（owner={logsafe.fingerprint(owner)}, sandbox={sandbox}）", flush=True)
                    reconnect_attempt = 0
                    heartbeat_task = None
                    last_heartbeat_ack_at = time.monotonic()
                    try:
                        async for msg in ws:
                            if msg.type != aiohttp.WSMsgType.TEXT:
                                continue
                            packet = json.loads(msg.data)
                            op = packet.get("op")
                            seq = packet.get("s")
                            event_type = packet.get("t")
                            data = packet.get("d") or {}
                            if seq is not None:
                                last_seq = seq
                            if op == _OP_HELLO:
                                interval = ((data or {}).get("heartbeat_interval") or 45000) / 1000
                                last_heartbeat_ack_at = time.monotonic()

                                async def _heartbeat():
                                    while not ws.closed:
                                        await asyncio.sleep(interval)
                                        now = time.monotonic()
                                        if _heartbeat_ack_expired(last_heartbeat_ack_at, interval, now):
                                            _log.warning(
                                                "[qq:%s] 心跳确认超时，关闭连接后按退避策略重连",
                                                channel_id,
                                            )
                                            await ws.close()
                                            return
                                        try:
                                            await ws.send_json({"op": _OP_HEARTBEAT, "d": last_seq})
                                        except asyncio.CancelledError:
                                            raise
                                        except Exception as e:
                                            diag_log("agent.gateway.qq.heartbeat", e)
                                            _log.warning(
                                                "[qq:%s] 心跳发送失败，关闭连接后按退避策略重连: %s",
                                                channel_id,
                                                redact(f"{type(e).__name__}: {e}"),
                                            )
                                            await ws.close()
                                            return

                                heartbeat_task = asyncio.create_task(_heartbeat())
                                if session_id and last_seq is not None:
                                    await ws.send_json({"op": _OP_RESUME, "d": {
                                        "token": f"QQBot {token}",
                                        "session_id": session_id,
                                        "seq": last_seq,
                                    }})
                                else:
                                    await ws.send_json({"op": _OP_IDENTIFY, "d": {
                                        "token": f"QQBot {token}",
                                        "intents": _INTENTS,
                                        "shard": [0, 1],
                                    }})
                            elif op == _OP_HEARTBEAT_ACK:
                                last_heartbeat_ack_at = time.monotonic()
                            elif op == _OP_DISPATCH:
                                if event_type == "READY":
                                    session_id = data.get("session_id")
                                    print(f"[qq:{channel_fp}] raw WebSocket READY", flush=True)
                                elif event_type == "RESUMED":
                                    print(f"[qq:{channel_fp}] raw WebSocket RESUMED", flush=True)
                                elif event_type in ("C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"):
                                    await _handle_raw_qq_message(event_type, data, channel_id, owner, last_ack)
                                elif event_type == "INTERACTION_CREATE":
                                    await _handle_qq_interaction(data, channel_id, owner)
                            elif op == _OP_RECONNECT:
                                print(f"[qq:{channel_fp}] QQ 要求重连", flush=True)
                                break
                            elif op == _OP_INVALID_SESSION:
                                print(f"[qq:{channel_fp}] QQ session 失效", flush=True)
                                session_id = None
                                last_seq = None
                                break
                    finally:
                        if heartbeat_task:
                            heartbeat_task.cancel()
                            with suppress(asyncio.CancelledError):
                                await heartbeat_task
        except Exception as e:
            # 网关连接的最外层兜底：token/gateway 获取、WS 握手、消息处理里任何没被内层捕获的异常
            # 都汇聚到这——包括编程错误（不新增分类，交给下面统一记录）。协议本身要求"断了就重连"，
            # 所以这里不改变"无条件重连"的行为，只把原始异常和可见日志的出口按 P2-b §3 分开：
            # 原始 traceback 只进受限诊断出口，gugu.log/Debug 面板只看到脱敏摘要 + 异常类型名。
            diag_log(f"agent.gateway.qq._run_raw_ws.{channel_id}", e)
            _log.error("[qq:%s] raw WebSocket 异常: %s", channel_fp, redact(f"{type(e).__name__}: {e}"))
        delay = _RECONNECT_DELAYS[min(reconnect_attempt, len(_RECONNECT_DELAYS) - 1)]
        reconnect_attempt += 1
        await asyncio.sleep(delay)

async def _serve() -> None:
    app_id = os.environ.get("QQ_APP_ID", "")
    secret = os.environ.get("QQ_APP_SECRET", "")
    sandbox = os.environ.get("QQ_SANDBOX", "0") in ("1", "true", "True")
    channel_id = os.environ.get("QQ_BOT_ID", "")
    owner = os.environ.get("QQ_OWNER", "")
    if not app_id or not secret:
        raise SystemExit("缺少 QQ_APP_ID / QQ_APP_SECRET 环境变量（应由 gateway 注入）。")
    from agent.security import logsafe
    print(f"[qq:{logsafe.fingerprint(channel_id)}] 网关启动（raw WebSocket, sandbox={sandbox}）…", flush=True)
    await start_qq_http_session()
    try:
        await _run_raw_ws(app_id, secret, sandbox, channel_id, owner)
    finally:
        await close_qq_http_session()

def serve() -> None:
    asyncio.run(_serve())


if __name__ == "__main__":
    from app.core.logging import setup_process_output

    setup_process_output()
    serve()
