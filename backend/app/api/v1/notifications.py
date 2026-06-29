"""用户端站内通知：拉取自己可见的通知（含离线时漏掉的）+ 标已读。

- 通知本体存在 `site_notifications`（admin 广播写入，target="all" 或具体 user_id）。
- 已读状态按用户存在 `notification_reads`（无记录=未读）。
- 实时推送（SSE 气泡）仍走 events 广播；这里是「持久态」——关浏览器重开还在。
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.security import get_current_user
from app.models import User, SiteNotification, NotificationRead

router = APIRouter(prefix="/notifications", tags=["notifications"])


def _visible(user) -> "ColumnElement":
    # 目标匹配（全员广播 / 本人专属）+ **只看注册之后产生的通知**：
    # 刚注册的新用户不补看历史广播——否则首登会弹一条旧广播气泡、和新手引导教程气泡撞车。
    return and_(
        or_(SiteNotification.target == "all", SiteNotification.target == str(user.id)),
        SiteNotification.created_at >= user.created_at,
    )


@router.get("")
async def list_notifications(
    limit: int = 30,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """通知中心：该用户近期【持久】通知（倒序）+ 每条是否未读。仅气泡（persist=false）不在此列。"""
    uid = current_user.id
    rows = (await db.execute(
        select(SiteNotification)
        .where(_visible(current_user), SiteNotification.persist == True)
        .order_by(SiteNotification.created_at.desc())
        .limit(max(1, min(limit, 100)))
    )).scalars().all()
    read_ids = set((await db.execute(
        select(NotificationRead.notification_id).where(NotificationRead.user_id == uid)
    )).scalars().all())
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
    uid = current_user.id
    now = datetime.utcnow()
    row = (await db.execute(
        select(SiteNotification)
        .where(
            _visible(current_user),
            SiteNotification.bubble == True,
            or_(SiteNotification.bubble_expire_at.is_(None), SiteNotification.bubble_expire_at > now),
        )
        .order_by(SiteNotification.created_at.desc())
        .limit(1)
    )).scalars().first()
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
    uid = current_user.id
    if body.ids:
        target_ids = list(body.ids)
    else:
        target_ids = (await db.execute(
            select(SiteNotification.id).where(_visible(current_user))
        )).scalars().all()
    existing = set((await db.execute(
        select(NotificationRead.notification_id).where(NotificationRead.user_id == uid)
    )).scalars().all())
    added = 0
    for nid in target_ids:
        if nid not in existing:
            db.add(NotificationRead(user_id=uid, notification_id=nid))
            added += 1
    if added:
        await db.commit()
    return {"ok": True, "marked": added}
