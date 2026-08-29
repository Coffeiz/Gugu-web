"""用户级实时事件流：Redis pub/sub -> FastAPI StreamingResponse。

业务事件由 ``app.core.events`` 发布；本模块只负责 JWT 鉴权、订阅用户和广播频道，
以及把 canonical live-event-v1 envelope 转成 SSE。长连接不依赖数据库 session。
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app.core.redis import get_redis
from app.core.security import get_current_user_id, is_user_active

router = APIRouter(prefix="/live", tags=["live"])

BROADCAST_CHANNEL = "events:__broadcast__"
LIVE_RESOURCES = {
    "projects", "calendar", "files", "mind", "scheduled_tasks", "sessions",
    "clients", "im_channels", "terminals",
}
LIVE_OPERATIONS = {"create", "update", "delete", "move", "append", "refresh"}


def _is_live_event(value: Any) -> bool:
    """只校验事件 envelope；payload 由前端具体资源处理。"""
    if not isinstance(value, dict):
        return False
    return (
        value.get("protocol_version") == "live-event-v1"
        and isinstance(value.get("event_id"), str)
        and bool(value["event_id"])
        and value.get("type") == "resource.changed"
        and value.get("resource") in LIVE_RESOURCES
        and value.get("operation") in LIVE_OPERATIONS
        and isinstance(value.get("revision"), int)
        and not isinstance(value.get("revision"), bool)
        and isinstance(value.get("created_at"), str)
    )


def _serialize_message(raw: Any) -> str | None:
    """过滤 Redis 中的非业务消息，返回一条完整 SSE data frame。"""
    if not isinstance(raw, str):
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not (_is_live_event(value) or (
        isinstance(value, dict)
        and isinstance(value.get("notification"), dict)
    )):
        return None
    return f"data: {json.dumps(value, ensure_ascii=False, separators=(',', ':'))}\n\n"


async def _event_stream(request: Request, user_id: Any, active_check=None) -> AsyncIterator[str]:
    redis = get_redis()
    pubsub = redis.pubsub()
    channels = (f"events:{user_id}", BROADCAST_CHANNEL)
    await pubsub.subscribe(*channels)
    try:
        yield ": connected\n\n"
        while not await request.is_disconnected():
            if active_check is not None and not await active_check(user_id):
                yield "event: account_suspended\ndata: {\"message\":\"账号暂时不可用\"}\n\n"
                return
            message = await pubsub.get_message(
                ignore_subscribe_messages=True,
                timeout=5.0,
            )
            if message:
                frame = _serialize_message(message.get("data"))
                if frame:
                    yield frame
            else:
                yield ": ping\n\n"
    finally:
        try:
            await pubsub.unsubscribe(*channels)
        finally:
            close = getattr(pubsub, "aclose", None)
            if close is not None:
                await close()


@router.get("/stream")
async def stream_live_events(
    request: Request,
    user_id=Depends(get_current_user_id),
) -> StreamingResponse:
    """订阅当前用户的资源事件和全局通知，不创建或持有数据库连接。"""
    return StreamingResponse(
        _event_stream(request, user_id, active_check=is_user_active),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
