"""飞书事件订阅 Webhook（「请求地址」模式，长连接的另一条收消息链路）。

飞书后台事件订阅选「请求地址」时，会把事件 POST 到这里。本端点用 lark-oapi 的
`EventDispatcherHandler.do()` 一把梭：用频道的 Encrypt Key 解密 → 校验
Verification Token → 处理 `url_verification` 直接回 `{"challenge": ...}` →
其余事件验签后派发到 `_make_on_message`（与长连接网关同一个回调，入队 payload 完全一致）。

回调地址按频道区分：`https://你的域名/api/v1/feishu/event/{channel_id}`，
每个频道（飞书应用）在其后台填自己的地址 + Encrypt Key + Verification Token。

与长连接的关系：二选一即可。长连接（supervisor）不需要公网；本 Webhook 需公网可达。
别对同一个 app 同时开两条，否则消息会被处理两次。
"""
from __future__ import annotations

import asyncio

import lark_oapi as lark
from fastapi import APIRouter, Request, Response

from agent.adapters.feishu import _make_on_message
from app.core.config import active_im_bots, get_settings

router = APIRouter(prefix="/feishu", tags=["feishu-event"])

# 频道 → (handler, creds 快照)；creds 变了就重建
_handlers: dict[str, tuple] = {}


def _creds_for_event(channel_id: str) -> tuple[str, str]:
    """取该频道的 (encrypt_key, verification_token)；频道没有则兜底 .env。"""
    b = next((x for x in active_im_bots("feishu") if x["id"] == channel_id), None)
    if b:
        return b.get("encrypt_key", ""), b.get("verification_token", "")
    cfg = get_settings().feishu
    return cfg.encrypt_key, cfg.verification_token


def _handler_for(channel_id: str):
    """按频道构建并缓存 lark 事件处理器（Encrypt Key/Token 变更后自动重建）。"""
    ek, vt = _creds_for_event(channel_id)
    cached = _handlers.get(channel_id)
    if cached and cached[1] == (ek, vt):
        return cached[0]
    handler = (
        lark.EventDispatcherHandler.builder(ek, vt)
        .register_p2_im_message_receive_v1(_make_on_message(channel_id))
        .build()
    )
    _handlers[channel_id] = (handler, (ek, vt))
    return handler


@router.post("/event/{channel_id}")
async def feishu_event(channel_id: str, request: Request):
    """飞书事件回调入口。lark `do()` 负责解密/验签/回 challenge/派发，全程同步丢线程跑。"""
    body = await request.body()
    req = lark.RawRequest()
    req.uri = str(request.url.path)
    # lark 验签按精确大小写取 X-Lark-* 头，而 Starlette items() 会转小写 → 用大小写无关查找补齐
    headers = {k: v for k, v in request.headers.items()}
    for name in ("X-Lark-Request-Timestamp", "X-Lark-Request-Nonce", "X-Lark-Signature"):
        val = request.headers.get(name)
        if val is not None:
            headers[name] = val
    req.headers = headers
    req.body = body

    handler = _handler_for(channel_id)
    resp = await asyncio.to_thread(handler.do, req)
    return Response(
        content=resp.content or b"",
        status_code=resp.status_code or 200,
        media_type=resp.headers.get("Content-Type", "application/json"),
    )
