"""
邀请码管理接口（Admin）
POST   /api/v1/admin/invite-codes/generate  → 批量生成邀请码
GET    /api/v1/admin/invite-codes           → 列出所有邀请码
DELETE /api/v1/admin/invite-codes/{id}      → 删除邀请码
"""

import random
import string
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import InviteCode

router = APIRouter(prefix="/admin/invite-codes", tags=["admin"])


def _gen_code() -> str:
    chars = string.ascii_uppercase + string.digits
    seg = lambda n: ''.join(random.choices(chars, k=n))
    return f"GUGU-{seg(4)}-{seg(4)}"


class GenerateRequest(BaseModel):
    count: int = 1
    note: str = ""


@router.post("/generate")
async def generate_codes(body: GenerateRequest, request: Request, db: AsyncSession = Depends(get_db)):
    from app.api.v1.audit_log import write_log
    if not 1 <= body.count <= 50:
        raise HTTPException(400, "单次生成数量 1~50")

    codes = []
    for _ in range(body.count):
        code = None
        for _ in range(20):
            candidate = _gen_code()
            exists = await db.execute(select(InviteCode).where(InviteCode.code == candidate))
            if not exists.scalars().first():
                code = candidate
                break
        if code is None:
            raise HTTPException(500, "生成邀请码失败，请重试")
        inv = InviteCode(code=code, note=body.note or None)
        db.add(inv)
        codes.append(inv)

    await db.commit()
    for c in codes:
        await db.refresh(c)

    username = getattr(request.state, "admin_username", "admin")
    await write_log(db, username, "invite", f"生成 {body.count} 个邀请码", request)
    return {"codes": [_fmt(c) for c in codes]}


@router.get("")
async def list_codes(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(InviteCode).order_by(InviteCode.created_at.desc())
    )
    codes = result.scalars().all()
    return {"codes": [_fmt(c) for c in codes]}


@router.delete("/{code_id}")
async def delete_code(code_id: int, request: Request, db: AsyncSession = Depends(get_db)):
    from app.api.v1.audit_log import write_log
    inv = await db.get(InviteCode, code_id)
    if not inv:
        raise HTTPException(404, "邀请码不存在")
    code_str = inv.code
    await db.delete(inv)
    await db.commit()
    username = getattr(request.state, "admin_username", "admin")
    await write_log(db, username, "invite", f"删除邀请码 {code_str}", request)
    return {"deleted": True}


def _fmt(inv: InviteCode) -> dict:
    return {
        "id":        inv.id,
        "code":      inv.code,
        "note":      inv.note or "",
        "used":      inv.used_at is not None,
        "used_at":   inv.used_at.strftime("%Y-%m-%d %H:%M") if inv.used_at else None,
        "used_by":   str(inv.used_by) if inv.used_by else None,
        "created_at": inv.created_at.strftime("%Y-%m-%d %H:%M"),
    }
