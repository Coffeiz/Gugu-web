"""实时事件 SSE 端点：网页端订阅，收到「资源变了」就刷新对应 store。

见 `app/core/events.py`。鉴权复用 get_current_user（前端用 fetch streaming 带
Authorization 头订阅，非 EventSource）。
"""
from uuid import UUID

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.core import events
from app.core.security import get_current_user_id

router = APIRouter(prefix="/live", tags=["live"])


@router.get("/stream")
async def stream(user_id: UUID = Depends(get_current_user_id)):
    return StreamingResponse(
        events.stream(user_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # 关 nginx 缓冲，SSE 才能逐条下发
        },
    )
