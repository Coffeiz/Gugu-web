from fastapi import APIRouter, Depends, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import Feedback, User
from app.core.security import get_current_user
from app.services.email import notify_feedback

router = APIRouter(prefix="/feedback", tags=["feedback"])
admin_router = APIRouter(prefix="/admin/feedback", tags=["admin"])

VALID_CATEGORIES = {"bug", "suggestion", "other"}


class FeedbackCreate(BaseModel):
    category: str
    content: str


@router.post("", status_code=201)
async def submit_feedback(
    body: FeedbackCreate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.category not in VALID_CATEGORIES:
        from fastapi import HTTPException
        raise HTTPException(400, "无效分类")
    if not body.content.strip():
        from fastapi import HTTPException
        raise HTTPException(400, "反馈内容不能为空")

    fb = Feedback(
        user_id=current_user.id,
        username=current_user.display_name or current_user.username,
        category=body.category,
        content=body.content.strip(),
    )
    db.add(fb)
    await db.commit()

    background_tasks.add_task(
        notify_feedback,
        username=fb.username,
        category=fb.category,
        content=fb.content,
    )
    return {"ok": True}


@admin_router.get("")
async def list_feedback(
    page: int = 1,
    page_size: int = 30,
    category: str = "",
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Feedback).order_by(Feedback.created_at.desc())
    if category:
        stmt = stmt.where(Feedback.category == category)

    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar() or 0
    rows = (await db.execute(stmt.offset((page - 1) * page_size).limit(page_size))).scalars().all()

    return {
        "total": total,
        "items": [
            {
                "id": r.id,
                "username": r.username,
                "category": r.category,
                "content": r.content,
                "createdAt": r.created_at.isoformat(),   # 原始 UTC ISO，前端按浏览器 tz 显示
            }
            for r in rows
        ],
    }
