"""站点通知广播：管理员向所有/指定用户推送通知气泡。"""
from __future__ import annotations
from app.core.tz import now_utc

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events as ev
from app.db.session import get_db
from app.models import SiteNotification

router = APIRouter(prefix="/admin/notifications", tags=["admin-notifications"])


class BroadcastRequest(BaseModel):
    title:   str = ""      # 标题可选：允许「无标题、仅内容」的通知
    content: str = ""
    color:   str = "#7b7fb2"
    target:  str = "all"   # "all" 或具体 user_id（字符串）
    bubble:  bool = True   # 是否弹气泡（实时 + 上线补弹最近一条）
    persist: bool = True   # 是否进通知中心（持久列表、未读追踪、重开还在）
    bubble_ttl_hours: Optional[int] = None   # 气泡时限（小时），null=永久；过期后再登录不补弹


@router.post("/broadcast")
async def broadcast(req: BroadcastRequest, db: AsyncSession = Depends(get_db)):
    """推送通知，气泡 / 通知中心两渠道独立：
    - bubble：弹气泡（实时在线立即弹；离线者上线时补弹最近一条、只一次、在 bubble_ttl_hours 内）
    - persist：进通知中心（持久列表、未读追踪、重开还在）
    通知本体都落库（气泡也要落库才能上线补弹）；bubble/persist 记录各自渠道。"""
    if not req.title.strip() and not req.content.strip():
        raise HTTPException(status_code=400, detail="标题和内容不能同时为空")
    if not req.bubble and not req.persist:
        raise HTTPException(status_code=400, detail="气泡 / 通知中心至少选一个")

    bubble_expire_at = None
    if req.bubble and req.bubble_ttl_hours:
        bubble_expire_at = now_utc() + timedelta(hours=req.bubble_ttl_hours)

    rec = SiteNotification(
        title=req.title, content=req.content, color=req.color, target=req.target,
        bubble=req.bubble, persist=req.persist, bubble_expire_at=bubble_expire_at,
    )
    db.add(rec)
    await db.commit()
    await db.refresh(rec)
    nid = rec.id

    note = {"id": nid, "title": req.title, "content": req.content, "color": req.color,
            "bubble": req.bubble, "persist": req.persist}
    if req.target == "all":
        await ev.broadcast(req.title, req.content, req.color, nid=nid, bubble=req.bubble, persist=req.persist)
    else:
        try:
            await ev.publish(req.target, notification=note)
        except (ValueError, TypeError):
            pass

    return {"ok": True, "id": nid}


@router.get("/history")
async def history(limit: int = 50, db: AsyncSession = Depends(get_db)):
    """最近发送的通知记录。"""
    rows = (await db.execute(
        select(SiteNotification).order_by(desc(SiteNotification.created_at)).limit(limit)
    )).scalars().all()
    return [
        {
            "id": r.id,
            "title": r.title,
            "content": r.content,
            "color": r.color,
            "target": r.target,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@router.delete("/history/{nid}")
async def delete_record(nid: int, db: AsyncSession = Depends(get_db)):
    rec = await db.get(SiteNotification, nid)
    if rec:
        await db.delete(rec)
        await db.commit()
    return {"ok": True}
