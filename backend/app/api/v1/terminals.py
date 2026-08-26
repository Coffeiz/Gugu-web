"""共享协作终端 API。"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.core import events
from app.db.session import get_db
from app.models import User
from app.services.terminals import (
    create_terminal, delete_terminal, get_terminal, list_terminals,
    terminate_terminal as terminate_terminal_record,
    prune_terminals, reopen_terminal, rename_terminal, serialize_event, serialize_terminal, terminal_events, terminal_metrics,
)
from agent.terminal.access import TerminalOperation, authorize_operation, page_access
from agent.tools.shell import _shell

router = APIRouter(prefix="/terminals", tags=["terminals"])


class TerminalCreate(BaseModel):
    name: str = Field(default="终端", min_length=1, max_length=200)
    sessionId: int | None = None
    workspaceId: int | None = None


class TerminalUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class TerminalInput(BaseModel):
    command: str = Field(min_length=1, max_length=12000)
    cwd: str = Field(default=".", max_length=1000)
    timeout: float = Field(default=30, ge=0.1, le=300)
    maxOutputChars: int = Field(default=12000, ge=1, le=120000)
    network: str = Field(default="none", pattern="^(none|egress)$")
    confirm: bool = False
    confirmToken: str | None = None


def _require(row):
    if row is None:
        raise HTTPException(status_code=404, detail="终端不存在")
    return row


@router.get("")
async def get_terminals(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    access = await page_access(db, user.id)
    if not access.allowed:
        raise HTTPException(status_code=403, detail=access.reason)
    await prune_terminals(db, user.id)
    await db.commit()
    rows = await list_terminals(db, user.id)
    return {"enabled": True, "items": [serialize_terminal(row) for row in rows]}


@router.get("/metrics")
async def get_terminal_metrics(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    access = await page_access(db, user.id)
    if not access.allowed:
        raise HTTPException(status_code=403, detail=access.reason)
    return await terminal_metrics(db, user.id)


@router.post("")
async def add_terminal(body: TerminalCreate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        row = await create_terminal(db, user.id, name=body.name, session_id=body.sessionId, workspace_id=body.workspaceId)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await db.commit()
    await events.publish(user.id, "terminals", operation="create", entity_id=row.id,
                         event_payload=serialize_terminal(row))
    return serialize_terminal(row)


@router.get("/{terminal_id}")
async def get_terminal_detail(terminal_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = _require(await get_terminal(db, user.id, terminal_id))
    access = await authorize_operation(db, user.id, owner_id=row.owner_id, session_id=row.session_id, operation=TerminalOperation.VIEW)
    if not access.allowed:
        raise HTTPException(status_code=403, detail=access.reason)
    return serialize_terminal(row)


@router.get("/{terminal_id}/events")
async def stream_terminal_events(terminal_id: str, after: int = Query(default=0, ge=0), user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = _require(await get_terminal(db, user.id, terminal_id))
    access = await authorize_operation(db, user.id, owner_id=row.owner_id, session_id=row.session_id, operation=TerminalOperation.VIEW)
    if not access.allowed:
        raise HTTPException(status_code=403, detail=access.reason)

    async def generate():
        cursor = after
        for _ in range(30):
            events = await terminal_events(db, row, cursor)
            for event in events:
                cursor = event.sequence
                yield f"data: {json.dumps({'event': serialize_event(event)}, ensure_ascii=False)}\n\n"
            if row.closed_at and cursor >= row.last_sequence:
                break
            await asyncio.sleep(0.5)
        yield "event: end\ndata: {}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.patch("/{terminal_id}")
async def rename_terminal_route(terminal_id: str, body: TerminalUpdate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = _require(await get_terminal(db, user.id, terminal_id))
    access = await authorize_operation(db, user.id, owner_id=row.owner_id, session_id=row.session_id, operation=TerminalOperation.VIEW)
    if not access.allowed:
        raise HTTPException(status_code=403, detail=access.reason)
    try:
        await rename_terminal(db, row, body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await db.commit()
    await events.publish(user.id, "terminals", operation="update", entity_id=row.id,
                         event_payload=serialize_terminal(row))
    return serialize_terminal(row)


@router.post("/{terminal_id}/input")
async def terminal_input(terminal_id: str, body: TerminalInput, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = _require(await get_terminal(db, user.id, terminal_id))
    access = await authorize_operation(db, user.id, owner_id=row.owner_id, session_id=row.session_id, workspace_id=row.workspace_id, operation=TerminalOperation.INPUT)
    if not access.allowed:
        raise HTTPException(status_code=403, detail=access.reason)
    before_sequence = row.last_sequence
    result = await _shell(db, user.id, {
        "_session_id": row.session_id, "_workspace_id": row.workspace_id, "_terminal_id": row.id, "_terminal_source": "user",
        "command": body.command, "cwd": body.cwd, "timeout": body.timeout,
        "max_output_chars": body.maxOutputChars, "network": body.network,
        "confirm": body.confirm, "confirm_token": body.confirmToken,
    })
    await db.commit()
    new_events = await terminal_events(db, row, before_sequence)
    if new_events:
        await events.publish(user.id, "terminals", operation="append", entity_id=row.id,
                             event_payload={"terminal_id": row.id, "event": serialize_event(new_events[-1]),
                                            "terminal": serialize_terminal(row)})
    return {"terminal": serialize_terminal(row), "result": result}


@router.post("/{terminal_id}/terminate")
async def terminate_terminal_view(terminal_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = _require(await get_terminal(db, user.id, terminal_id))
    access = await authorize_operation(db, user.id, owner_id=row.owner_id, session_id=row.session_id, operation=TerminalOperation.TERMINATE)
    if not access.allowed:
        raise HTTPException(status_code=403, detail=access.reason)
    await terminate_terminal_record(db, row)
    await db.commit()
    await events.publish(user.id, "terminals", operation="append", entity_id=row.id,
                         event_payload={"terminal_id": row.id, "terminal": serialize_terminal(row)})
    return serialize_terminal(row)


@router.delete("/{terminal_id}")
async def delete_terminal_view(terminal_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = _require(await get_terminal(db, user.id, terminal_id))
    access = await authorize_operation(db, user.id, owner_id=row.owner_id, session_id=row.session_id, operation=TerminalOperation.DELETE)
    if not access.allowed:
        raise HTTPException(status_code=403, detail=access.reason)
    await delete_terminal(db, row)
    await db.commit()
    await events.publish(user.id, "terminals", operation="delete", entity_id=terminal_id)
    return {"deleted": True, "terminalId": terminal_id}


@router.post("/{terminal_id}/reopen")
async def reopen_terminal_view(terminal_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = _require(await get_terminal(db, user.id, terminal_id))
    access = await authorize_operation(db, user.id, owner_id=row.owner_id, session_id=row.session_id,
                                       workspace_id=row.workspace_id, operation=TerminalOperation.REOPEN)
    if not access.allowed:
        raise HTTPException(status_code=403, detail=access.reason)
    try:
        await reopen_terminal(db, row)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await db.commit()
    await events.publish(user.id, "terminals", operation="update", entity_id=row.id,
                         event_payload=serialize_terminal(row))
    return serialize_terminal(row)
