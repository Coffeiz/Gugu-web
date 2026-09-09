from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import CalendarEvent, Project, User
from app.schemas import EventCreate, EventUpdate, EventResponse
from app.core.security import get_current_user
from app.core.ownership import get_owned
from app.core import events
from app.core.tz import now_utc
from app.services.undo import UndoService
from app.services.undo.domains import domain_ref, domain_state, event_snapshot, task_snapshot

router = APIRouter(prefix="/events", tags=["events"])


def _to_resp(e: CalendarEvent) -> EventResponse:
    return EventResponse(
        id=e.id,
        title=e.title,
        date=e.date,
        time=e.time,
        end_time=e.end_time,
        type=e.type,
        client=e.client,
        project_id=e.project_id,
        description=e.description,
        version=e.version or 1,
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
        .where(CalendarEvent.user_id == current_user.id, CalendarEvent.deleted_at.is_(None))
        .order_by(CalendarEvent.date)
    )
    if year and month:
        prefix = f"{year}-{month:02d}"
        stmt = stmt.where(CalendarEvent.date.startswith(prefix))
    result = await db.execute(stmt)
    return [_to_resp(e) for e in result.scalars().all()]


@router.get("/{eid}", response_model=EventResponse)
async def get_event(
    eid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    e = await get_owned(db, CalendarEvent, eid, current_user.id)
    if not e or e.deleted_at is not None:
        raise HTTPException(404, "事件不存在")
    return _to_resp(e)


@router.post("", response_model=EventResponse, status_code=201)
async def create_event(
    body: EventCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    if body.project_id is not None:
        project = await get_owned(db, Project, body.project_id, current_user.id)
        if project is None or project.deleted_at is not None:
            raise HTTPException(400, "关联的项目不存在")
    e = CalendarEvent(user_id=current_user.id, **body.model_dump(by_alias=False))
    db.add(e)
    await db.flush()
    await UndoService.record_forward(
        db, user_id=current_user.id,
        context_id=request.headers.get("X-Undo-Context-ID") if request else None,
        resource="calendar", action="create",
        target_refs=[{"kind": "event", "id": e.id}], before_state=domain_state({}),
        after_state=domain_state({domain_ref("event", e.id): event_snapshot(e)}),
        base_versions={domain_ref("event", e.id): {"version": 0}},
    )
    await db.commit()
    await db.refresh(e)
    response = _to_resp(e)
    await events.publish(current_user.id, "calendar", origin=request.headers.get("X-Client-Id") if request else None,
                         operation="create", entity_id=e.id,
                         event_payload=response.model_dump(mode="json", by_alias=True))
    return response


@router.patch("/{eid}", response_model=EventResponse)
async def update_event(
    eid: int,
    body: EventUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    e = await get_owned(db, CalendarEvent, eid, current_user.id)
    if not e or e.deleted_at is not None:
        raise HTTPException(404, "事件不存在")
    data = body.model_dump(exclude_unset=True, by_alias=False)
    before = event_snapshot(e)
    client_version = data.pop("version", None)
    if client_version is not None and e.version != client_version:
        raise HTTPException(409, "数据已被其他用户修改，请刷新后重试")
    if data.get("project_id") is not None:
        project = await get_owned(db, Project, data["project_id"], current_user.id)
        if project is None or project.deleted_at is not None:
            raise HTTPException(400, "关联的项目不存在")
    for k, v in data.items():
        setattr(e, k, v)
    e.version = (e.version or 1) + 1
    await UndoService.record_forward(
        db, user_id=current_user.id,
        context_id=request.headers.get("X-Undo-Context-ID") if request else None,
        resource="calendar", action="update",
        target_refs=[{"kind": "event", "id": e.id}],
        before_state=domain_state({domain_ref("event", e.id): before}),
        after_state=domain_state({domain_ref("event", e.id): event_snapshot(e)}),
        base_versions={domain_ref("event", e.id): {"version": before["version"]}},
    )
    await db.commit()
    await db.refresh(e)
    response = _to_resp(e)
    await events.publish(current_user.id, "calendar", origin=request.headers.get("X-Client-Id") if request else None,
                         operation="update", entity_id=e.id,
                         event_payload=response.model_dump(mode="json", by_alias=True))
    return response


@router.delete("/{eid}", status_code=204)
async def delete_event(
    eid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    e = await get_owned(db, CalendarEvent, eid, current_user.id)
    if not e or e.deleted_at is not None:
        raise HTTPException(404, "事件不存在")
    from app.models import ScheduledTask
    tasks = (await db.execute(select(ScheduledTask).where(
        ScheduledTask.user_id == current_user.id, ScheduledTask.event_id == eid,
    ))).scalars().all()
    before_items = {domain_ref("event", e.id): event_snapshot(e)}
    before_items.update({domain_ref("task", t.id): task_snapshot(t) for t in tasks})
    e.deleted_at = now_utc()
    e.version = (e.version or 1) + 1
    for task in tasks:
        task.enabled = False
    await db.flush()
    after_items = {domain_ref("event", e.id): event_snapshot(e)}
    after_items.update({domain_ref("task", t.id): task_snapshot(t) for t in tasks})
    await UndoService.record_forward(
        db, user_id=current_user.id,
        context_id=request.headers.get("X-Undo-Context-ID") if request else None,
        resource="calendar", action="delete",
        target_refs=[{"kind": ref.split(":", 1)[0], "id": int(ref.split(":", 1)[1])}
                     for ref in after_items],
        before_state=domain_state(before_items), after_state=domain_state(after_items),
        base_versions={ref: {"version": snapshot.get("version", 0)}
                       for ref, snapshot in before_items.items()},
    )
    await db.commit()
    await events.publish(current_user.id, "calendar", origin=request.headers.get("X-Client-Id") if request else None,
                         operation="delete", entity_id=eid)
    if tasks:
        await events.publish(current_user.id, "scheduled_tasks", operation="update",
                             entity_ids=[task.id for task in tasks],
                             origin=request.headers.get("X-Client-Id") if request else None)
