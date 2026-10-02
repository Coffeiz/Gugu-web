"""用户端站内通知：拉取自己可见的通知（含离线时漏掉的）+ 标已读。

- 通知本体存在 `site_notifications`（admin 广播写入，target="all" 或具体 user_id）。
- 已读状态按用户存在 `notification_reads`（无记录=未读）。
- 实时推送（SSE 气泡）仍走 events 广播；这里是「持久态」——关浏览器重开还在。
"""
from __future__ import annotations
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.security import get_current_user
from app.models import User
from app.services.notifications import (
    dismiss_persisted_notifications,
    latest_unread_bubble,
    list_persisted_notifications,
    mark_notifications_read,
)

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
async def list_notifications(
    limit: int = 30,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """通知中心：该用户近期【持久】通知（倒序）+ 每条是否未读。仅气泡（persist=false）不在此列。"""
    rows, read_ids = await list_persisted_notifications(db, current_user, limit=limit)
    return [
        {
            "id": n.id, "title": n.title, "content": n.content, "color": n.color,
            "time": n.created_at.isoformat(), "unread": n.id not in read_ids,
        }
        for n in rows
    ]


@router.get("/bubble")
async def latest_bubble(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """上线补弹：返回最近一条「该弹气泡、且未过期」的通知（只一条）。
    前端用 localStorage 记已弹过的 id，比它新才弹一次——所以这里只管"最新且有效"，"只一次"在前端。"""
    row = await latest_unread_bubble(db, current_user)
    if not row:
        return {"bubble": None}
    return {"bubble": {"id": row.id, "title": row.title, "content": row.content, "color": row.color}}


class ReadRequest(BaseModel):
    ids: list[int] | None = None   # 给定则只标这些；None/空 = 全部可见通知标已读


@router.post("/read")
async def mark_read(
    body: ReadRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """标已读（落库）。无 ids = 全部已读。已读的跳过，避免唯一约束冲突。"""
    added = await mark_notifications_read(db, current_user, body.ids)
    return {"ok": True, "marked": added}


@router.delete("")
async def clear_notifications(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """清空当前用户的持久通知视图，不删除其他用户可见的通知本体。"""
    added = await dismiss_persisted_notifications(db, current_user)
    return {"ok": True, "dismissed": added}
