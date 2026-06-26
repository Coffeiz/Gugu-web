"""站点通知广播：管理员向所有/指定用户推送通知气泡。"""
from __future__ import annotations

from datetime import datetime
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


@router.post("/broadcast")
async def broadcast(req: BroadcastRequest, db: AsyncSession = Depends(get_db)):
    """向所有在线用户（或指定用户）推送通知气泡，并记录到历史。"""
    if not req.title.strip() and not req.content.strip():
        raise HTTPException(status_code=400, detail="标题和内容不能同时为空")
    rec = SiteNotification(
        title=req.title, content=req.content,
        color=req.color, target=req.target,
    )
    db.add(rec)
    await db.commit()
    await db.refresh(rec)

    if req.target == "all":
        await ev.broadcast(req.title, req.content, req.color)
    else:
        try:
            uid = int(req.target)
            await ev.publish(uid, notification={"title": req.title, "content": req.content, "color": req.color})
        except (ValueError, TypeError):
            pass

    return {"ok": True, "id": rec.id}


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
