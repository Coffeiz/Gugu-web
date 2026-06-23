"""飞书网关：WebSocket 长连接收消息 → 规范化 → 入队 im:inbound（BYO 每用户自带 app）。

不需要公网 URL（lark-oapi WebSocket 长连）。与 QQ 同 BYO 模型：每个用户在「个人设置 →
接入咕咕 → 飞书」用 device flow 扫码创建自己的飞书 app（存 user_bots 表），supervisor 为每个
启用的 user_bot 起一条本网关子进程，凭据走**环境变量注入**。bot 收到的消息天然归属其 owner，
入队 payload 带 owner_user_id，worker 无需再做绑定。

lark 的 `ws.Client.start()` 同步阻塞、事件 handler 同步，故用 `produce_sync` 入队。
lark 无 stop()，单连接断不掉 → 一个 bot 一个子进程，由 supervisor 起停（kill）。

启动（由 supervisor 拉起，注入 FEISHU_* 环境变量）：
    FEISHU_BOT_ID=.. FEISHU_APP_ID=.. FEISHU_APP_SECRET=.. FEISHU_OWNER=.. \
      .venv/bin/python -m agent.adapters.feishu
"""
from __future__ import annotations

import asyncio
import json
import os

import lark_oapi as lark
from lark_oapi.api.im.v1 import P2ImMessageReceiveV1

from app.core import redis as R

STREAM = R.IM_INBOUND_STREAM


# ── 接收（网关子进程，凭据/归属从 env 注入）──
def _make_on_message(channel_id: str, owner: str):
    def _on_message(data: P2ImMessageReceiveV1) -> None:
        ev = data.event
        msg = ev.message
        if not msg or msg.message_type != "text":
            return  # 暂只处理文本
        try:
            text = ((json.loads(msg.content) if msg.content else {}) or {}).get("text", "").strip()
        except Exception:
            text = ""
        if not text:
            return
        open_id = ev.sender.sender_id.open_id if (ev.sender and ev.sender.sender_id) else None
        payload = {
            "platform": "feishu",
            "channel_id": channel_id,
            "owner_user_id": owner,      # BYO：bot 即归属
            "platform_user_id": open_id,
            "chat_id": msg.chat_id,
            "chat_type": msg.chat_type,
            "message_id": msg.message_id,
            "text": text,
        }
        print(f"[feishu:{channel_id}] 收到 {open_id} @ {msg.chat_id}: {text!r}", flush=True)
        try:
            R.produce_sync(STREAM, payload)
        except Exception as e:
            print(f"[feishu] 入队失败: {type(e).__name__}: {e}", flush=True)
    return _on_message


def serve() -> None:
    app_id = os.environ.get("FEISHU_APP_ID", "")
    app_secret = os.environ.get("FEISHU_APP_SECRET", "")
    channel_id = os.environ.get("FEISHU_BOT_ID", "")
    owner = os.environ.get("FEISHU_OWNER", "")
    if not app_id or not app_secret:
        raise SystemExit("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量（应由 supervisor 注入）。")
    handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(_make_on_message(channel_id, owner))
        .build()
    )
    client = lark.ws.Client(app_id, app_secret, event_handler=handler, log_level=lark.LogLevel.INFO)
    print(f"[feishu:{channel_id}] 网关启动（owner={owner}），WebSocket 长连接中…", flush=True)
    client.start()  # 同步阻塞，SDK 自带断线重连


# ── 发送（worker 用，按 bot id 现查 DB 取凭据，缓存 lark.Client）──
_clients: dict = {}


async def _creds_by_id(bot_id: str) -> tuple[str, str]:
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import UserBot
    async with _sess._SessionLocal() as db:
        b = await db.get(UserBot, int(bot_id))
        return (b.app_id, b.app_secret) if b else ("", "")


def _do_send(client, chat_id: str, text: str) -> bool:
    from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody
    req = (
        CreateMessageRequest.builder()
        .receive_id_type("chat_id")
        .request_body(
            CreateMessageRequestBody.builder()
            .receive_id(chat_id).msg_type("text")
            .content(json.dumps({"text": text}, ensure_ascii=False))
            .build()
        ).build()
    )
    resp = client.im.v1.message.create(req)
    if not resp.success():
        print(f"[feishu] 发送失败: code={resp.code} msg={resp.msg}", flush=True)
        return False
    return True


async def send_text(chat_id: str, text: str, channel_id: str | None = None) -> bool:
    """给指定会话发文本（用该 bot 的凭据）。lark API 同步，丢线程跑。"""
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id:
        print(f"[feishu] user_bot {channel_id} 无凭据，发送跳过", flush=True)
        return False
    if channel_id not in _clients:
        _clients[channel_id] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    return await asyncio.to_thread(_do_send, _clients[channel_id], chat_id, text)


if __name__ == "__main__":
    serve()
