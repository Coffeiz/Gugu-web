from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from datetime import datetime, timedelta
from typing import Optional
import calendar

from app.db.session import get_db
from app.models import User, AgentUsage, File
from app.api.v1.audit_log import write_log

router = APIRouter(prefix="/admin/users", tags=["admin"])


def _month_range():
    now = datetime.utcnow()
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_day = calendar.monthrange(now.year, now.month)[1]
    end = now.replace(day=last_day, hour=23, minute=59, second=59, microsecond=999999)
    return start, end


@router.get("")
async def list_users(
    q: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(User).order_by(User.created_at.desc())
    result = await db.execute(stmt)
    users = result.scalars().all()

    month_start, month_end = _month_range()

    now = datetime.utcnow()

    usage_stmt = (
        select(
            AgentUsage.user_id,
            func.sum(AgentUsage.tokens_in + AgentUsage.tokens_out).label("tokens"),
        )
        .where(and_(AgentUsage.created_at >= month_start, AgentUsage.created_at <= month_end))
        .group_by(AgentUsage.user_id)
    )
    usage_result = await db.execute(usage_stmt)
    usage_map = {str(row.user_id): row.tokens for row in usage_result}

    week_start = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    week_stmt = (
        select(AgentUsage.user_id, func.sum(AgentUsage.tokens_in + AgentUsage.tokens_out).label("tokens"))
        .where(AgentUsage.created_at >= week_start)
        .group_by(AgentUsage.user_id)
    )
    week_result = await db.execute(week_stmt)
    week_map = {str(row.user_id): row.tokens for row in week_result}

    # 固定 6h 窗口（与用户端 /quota 一致）：00/06/12/18 UTC 整点重置
    h6_start = now.replace(hour=(now.hour // 6) * 6, minute=0, second=0, microsecond=0)
    h6_stmt = (
        select(AgentUsage.user_id, func.sum(AgentUsage.tokens_in + AgentUsage.tokens_out).label("tokens"))
        .where(AgentUsage.created_at >= h6_start)
        .group_by(AgentUsage.user_id)
    )
    h6_result = await db.execute(h6_stmt)
    h6_map = {str(row.user_id): row.tokens for row in h6_result}

    storage_stmt = (
        select(File.user_id, func.sum(File.size_bytes).label("storage"))
        .group_by(File.user_id)
    )
    storage_result = await db.execute(storage_stmt)
    storage_map = {str(row.user_id): row.storage for row in storage_result}

    items = []
    for u in users:
        uid = str(u.id)
        if q:
            q_lower = q.lower()
            if q_lower not in (u.username or "").lower() and q_lower not in (u.email or "").lower():
                continue
        items.append({
            "id":                   uid,
            "username":             u.username,
            "email":                u.email,
            "display_name":         u.display_name,
            "is_active":            u.is_active,
            "is_developer":         bool(getattr(u, "is_developer", False)),
            "created_at":           u.created_at.isoformat() if u.created_at else None,
            "tokens_week":         week_map.get(uid, 0),
            "tokens_6h":           h6_map.get(uid, 0),
            "storage_used":        storage_map.get(uid, 0),
            "token_limit_6h":      u.token_limit_6h,
            "token_limit_weekly":  u.token_limit_weekly,
            "storage_limit_bytes": u.storage_limit_bytes,
            "search_limit_daily":  u.search_limit_daily,
        })

    return {"items": items, "total": len(items)}


@router.patch("/{user_id}/ban")
async def toggle_ban(user_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    user.is_active = not user.is_active
    await db.commit()
    action = "封禁" if not user.is_active else "解封"
    username = getattr(request.state, "admin_username", "admin")
    await write_log(db, username, "user", f"{action}用户 {user.username}", request)
    return {"id": user_id, "is_active": user.is_active}


@router.patch("/{user_id}/developer")
async def toggle_developer(user_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    """切换开发者标记（数据面板可一键排除开发者数据）。"""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    user.is_developer = not user.is_developer
    await db.commit()
    action = "标记开发者" if user.is_developer else "取消开发者标记"
    username = getattr(request.state, "admin_username", "admin")
    await write_log(db, username, "user", f"{action} {user.username}", request)
    return {"id": user_id, "is_developer": user.is_developer}


@router.delete("/{user_id}")
async def delete_user(user_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    """删除用户 = 账户注销（管理员代操作）。实际删除逻辑与用户自助注销（DELETE /auth/me）
    共用 app/services/account_deletion.delete_account，避免两处各写一份、后续改动漂移。"""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    uname = user.username

    from app.services.account_deletion import delete_account
    removed = await delete_account(db, user)

    username = getattr(request.state, "admin_username", "admin")
    await write_log(db, username, "user", f"删除用户 {uname}（存储对象清除 {removed} 个）", request)
    return {"deleted": True, "storage_objects_removed": removed}


@router.patch("/{user_id}/quota")
async def update_quota(
    user_id: str,
    body: dict,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    for field in ("token_limit_6h", "token_limit_weekly", "storage_limit_bytes", "search_limit_daily"):
        if field in body:
            v = body[field]
            setattr(user, field, int(v) if v is not None else None)

    await db.commit()
    username = getattr(request.state, "admin_username", "admin")
    await write_log(db, username, "user", f"更新用户 {user.username} 配额", request)
    return {
        "id":                  user_id,
        "token_limit_6h":      user.token_limit_6h,
        "token_limit_weekly":  user.token_limit_weekly,
        "storage_limit_bytes": user.storage_limit_bytes,
        "search_limit_daily":  user.search_limit_daily,
    }
