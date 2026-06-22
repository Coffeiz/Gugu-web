"""飞书网关：WebSocket 长连接收消息 → 规范化 → 入队 im:inbound。

不需要公网 URL（lark-oapi WebSocket 长连）。凭据按频道 id 从 Admin 频道面板
（`config.override.json` 的 bots）取，兜底 `.env` 的 `FEISHU__*`。
lark 的 `ws.Client.start()` 同步阻塞、事件 handler 同步，故用 `produce_sync` 入队。
lark 无 stop()，单连接断不掉 → 用「一个频道一个子进程」由 supervisor 起停（kill）。

启动（一般由 supervisor 拉起，也可单跑调试，从 backend/ 跑加载 .env）：
    .venv/bin/python -m agent.adapters.feishu [channel_id]
"""
from __future__ import annotations

import json
import sys

import lark_oapi as lark
from lark_oapi.api.im.v1 import P2ImMessageReceiveV1

from app.core import redis as R
from app.core.config import active_im_bots, get_settings

STREAM = R.IM_INBOUND_STREAM


def _creds_for(channel_id: str | None) -> tuple[str, str]:
    """按频道 id 取凭据；无 id 则取首个启用频道，再兜底 .env。"""
    bots = active_im_bots("feishu")
    if channel_id:
        b = next((x for x in bots if x["id"] == channel_id), None)
        if b:
            return b["app_id"], b["app_secret"]
    if bots:
        return bots[0]["app_id"], bots[0]["app_secret"]
    cfg = get_settings().feishu
    return cfg.app_id, cfg.app_secret


def _make_on_message(channel_id: str | None):
    """生成消息回调（闭包带上 channel_id，便于 worker 按频道回发）。"""
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
            "platform_user_id": open_id,
            "chat_id": msg.chat_id,
            "chat_type": msg.chat_type,
            "message_id": msg.message_id,
            "text": text,
        }
        print(f"[feishu:{channel_id or '-'}] 收到 {open_id} @ {msg.chat_id}: {text!r}", flush=True)
        try:
            R.produce_sync(STREAM, payload)
        except Exception as e:
            print(f"[feishu] 入队失败: {type(e).__name__}: {e}", flush=True)
    return _on_message


# ── 发送（worker 用，按频道缓存 client）──
_api_clients: dict = {}


def _client(channel_id: str | None):
    key = channel_id or "_default"
    if key not in _api_clients:
        app_id, app_secret = _creds_for(channel_id)
        _api_clients[key] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    return _api_clients[key]


def send_text(chat_id: str, text: str, channel_id: str | None = None) -> bool:
    """给指定会话发文本（用消息所属频道的凭据）。"""
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
    resp = _client(channel_id).im.v1.message.create(req)
    if not resp.success():
        print(f"[feishu] 发送失败: code={resp.code} msg={resp.msg}", flush=True)
        return False
    return True


def serve(channel_id: str | None = None) -> None:
    app_id, app_secret = _creds_for(channel_id)
    if not app_id or not app_secret:
        raise SystemExit(
            "未配置飞书凭据：在 Admin「频道」面板添加飞书频道，"
            "或设 env FEISHU__APP_ID / FEISHU__APP_SECRET。"
        )
    handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(_make_on_message(channel_id))
        .build()
    )
    client = lark.ws.Client(
        app_id, app_secret,
        event_handler=handler,
        log_level=lark.LogLevel.INFO,
    )
    print(f"[feishu:{channel_id or '-'}] 网关启动，WebSocket 长连接中…", flush=True)
    client.start()  # 同步阻塞，SDK 自带断线重连


if __name__ == "__main__":
    serve(sys.argv[1] if len(sys.argv) > 1 else None)
