"""Web 统一撤销/重做 API。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User
from app.services.undo import UndoService
from app.services.undo.service import UndoError


router = APIRouter(prefix="/undo", tags=["undo"])


class UndoRequest(BaseModel):
    operation_id: str
    context_id: str


def _error(error: UndoError) -> HTTPException:
    return HTTPException(
        error.status_code,
        detail={"code": error.code, "message": error.message},
    )


@router.get("/preview")
async def preview_undo(
    context_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await UndoService.preview(db, user_id=current_user.id, context_id=context_id)


async def _apply(body: UndoRequest, mode: str, current_user: User, db: AsyncSession) -> dict:
    try:
        result = await UndoService.apply(
            db,
            user_id=current_user.id,
            context_id=body.context_id,
            operation_id=body.operation_id,
            mode=mode,
        )
    except UndoError as error:
        # 冲突/失败也要落下不可重试的状态，避免前端反复点击制造同一错误。
        await db.commit()
        raise _error(error) from error

    await db.commit()
    for event in result.get("events", []):
        await events.publish(
            current_user.id,
            event["resource"],
            origin=event["origin"],
            operation=event["operation"],
            entity_ids=event["entity_ids"],
        )
    return result


@router.post("")
async def undo(
    body: UndoRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _apply(body, "undo", current_user, db)


@router.post("/redo")
async def redo(
    body: UndoRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _apply(body, "redo", current_user, db)
