from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import CalendarEvent, User
from app.schemas import EventCreate, EventUpdate, EventResponse
from app.core.security import get_current_user

router = APIRouter(prefix="/events", tags=["events"])


def _to_resp(e: CalendarEvent) -> EventResponse:
    return EventResponse(
        id=e.id,
        title=e.title,
        date=e.date,
        type=e.type,
        client=e.client,
        project_id=e.project_id,
        description=e.description,
    )


@router.get("", response_model=list[EventResponse])
async def list_events(
    year: Optional[int] = None,
    month: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(CalendarEvent)
        .where(CalendarEvent.user_id == current_user.id)
        .order_by(CalendarEvent.date)
    )
    if year and month:
        prefix = f"{year}-{month:02d}"
        stmt = stmt.where(CalendarEvent.date.startswith(prefix))
    result = await db.execute(stmt)
    return [_to_resp(e) for e in result.scalars().all()]


@router.post("", response_model=EventResponse, status_code=201)
async def create_event(
    body: EventCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    e = CalendarEvent(user_id=current_user.id, **body.model_dump(by_alias=False))
    db.add(e)
    await db.commit()
    await db.refresh(e)
    return _to_resp(e)


@router.patch("/{eid}", response_model=EventResponse)
async def update_event(
    eid: int,
    body: EventUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    e = await db.get(CalendarEvent, eid)
    if not e or e.user_id != current_user.id:
        raise HTTPException(404, "事件不存在")
    for k, v in body.model_dump(exclude_unset=True, by_alias=False).items():
        setattr(e, k, v)
    await db.commit()
    await db.refresh(e)
    return _to_resp(e)


@router.delete("/{eid}", status_code=204)
async def delete_event(
    eid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    e = await db.get(CalendarEvent, eid)
    if not e or e.user_id != current_user.id:
        raise HTTPException(404, "事件不存在")
    await db.delete(e)
    await db.commit()
