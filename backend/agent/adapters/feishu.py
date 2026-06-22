"""飞书网关：WebSocket 长连接收消息 → 规范化 → 入队 im:inbound。

不需要公网 URL（lark-oapi WebSocket 长连）。凭据从 settings.feishu 读
（env `FEISHU__APP_ID` / `FEISHU__APP_SECRET`，或 config.override.json）。
lark 的 `ws.Client.start()` 同步阻塞、事件 handler 同步，故用 `produce_sync` 入队。

启动（从 backend/ 跑，加载 .env）：
    .venv/bin/python -m agent.adapters.feishu

收到文本消息 → 打印 + 入队（确认鉴权/事件格式）。
回复发回飞书在后续步骤接，平台用户→咕咕用户映射在后续步骤。
"""
from __future__ import annotations

import json

import lark_oapi as lark
from lark_oapi.api.im.v1 import P2ImMessageReceiveV1

from app.core import redis as R
from app.core.config import get_settings

STREAM = R.IM_INBOUND_STREAM


def _on_message(data: P2ImMessageReceiveV1) -> None:
    """飞书消息事件回调（同步，由 lark 内部 loop 调用）。"""
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
        "platform_user_id": open_id,
        "chat_id": msg.chat_id,
        "chat_type": msg.chat_type,
        "message_id": msg.message_id,
        "text": text,
    }
    print(f"[feishu] 收到 {open_id} @ {msg.chat_id}: {text!r}", flush=True)
    try:
        R.produce_sync(STREAM, payload)
    except Exception as e:
        print(f"[feishu] 入队失败: {type(e).__name__}: {e}", flush=True)


_api_client = None


def _client():
    """普通 API client（发消息用），懒加载。"""
    global _api_client
    if _api_client is None:
        cfg = get_settings().feishu
        _api_client = lark.Client.builder().app_id(cfg.app_id).app_secret(cfg.app_secret).build()
    return _api_client


def send_text(chat_id: str, text: str) -> bool:
    """给指定会话发文本（worker 处理完回复时调用，同步）。"""
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
    resp = _client().im.v1.message.create(req)
    if not resp.success():
        print(f"[feishu] 发送失败: code={resp.code} msg={resp.msg}", flush=True)
        return False
    return True


def serve() -> None:
    cfg = get_settings().feishu
    if not cfg.app_id or not cfg.app_secret:
        raise SystemExit(
            "未配置飞书凭据：设 env FEISHU__APP_ID / FEISHU__APP_SECRET，"
            "或写入 config.override.json 的 feishu 段。"
        )
    handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(_on_message)
        .build()
    )
    client = lark.ws.Client(
        cfg.app_id, cfg.app_secret,
        event_handler=handler,
        log_level=lark.LogLevel.INFO,
    )
    print("[feishu] 网关启动，WebSocket 长连接中…（Ctrl+C 退出）", flush=True)
    client.start()  # 同步阻塞，SDK 自带断线重连


if __name__ == "__main__":
    serve()
