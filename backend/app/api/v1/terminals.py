"""共享协作终端 API。"""

from __future__ import annotations

import asyncio
import base64
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decode_user_token, get_current_user
from app.core.tz import now_utc
from app.core import events
from app.db.session import get_db
from app.models import User
from app.services.terminals import (
    create_terminal, delete_terminal, get_terminal, list_terminals,
    terminate_terminal as terminate_terminal_record,
    prune_terminals, reopen_terminal, reset_terminal, rename_terminal, serialize_event, serialize_terminal, terminal_events, terminal_metrics,
)
from agent.terminal.access import TerminalOperation, authorize_operation, page_access
from agent.terminal.contracts import TerminalMode
from agent.terminal.contracts import TerminalStatus
from agent.terminal.protocol import PtyClientMessage
from agent.terminal.pty_manager import PtyLaunchSpec
from agent.terminal.runtime import get_pty_manager
from app.services.workspaces import resolve_shell_root
from agent.tools.shell import _shell

router = APIRouter(prefix="/terminals", tags=["terminals"])
logger = logging.getLogger(__name__)


class TerminalCreate(BaseModel):
    name: str = Field(default="终端", min_length=1, max_length=200)
    sessionId: int | None = None
    workspaceId: int | None = None
    mode: str = Field(default=TerminalMode.INTERACTIVE_PTY.value, pattern="^(agent-events|interactive-pty)$")


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


def _websocket_token(websocket: WebSocket) -> str:
    authorization = websocket.headers.get("authorization", "")
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    # 浏览器 WebSocket 不能设置 Authorization；协议名只用于承载认证令牌，
    # 不把令牌放入 URL，避免出现在访问日志、历史记录和 Referer 中。
    for protocol in websocket.headers.get("sec-websocket-protocol", "").split(","):
        value = protocol.strip()
        if value.startswith("gugu-auth."):
            return value[len("gugu-auth."):]
    return ""


def _websocket_auth_protocol(websocket: WebSocket) -> str | None:
    """返回浏览器认证协议，供握手时回显协商结果。"""
    for protocol in websocket.headers.get("sec-websocket-protocol", "").split(","):
        value = protocol.strip()
        if value.startswith("gugu-auth."):
            return value
    return None


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
        row = await create_terminal(db, user.id, name=body.name, session_id=body.sessionId,
                                    workspace_id=body.workspaceId, mode=body.mode)
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


@router.websocket("/{terminal_id}/ws")
async def terminal_websocket(terminal_id: str, websocket: WebSocket, db: AsyncSession = Depends(get_db)):
    """交互式 PTY 网关；agent-events 终端继续使用原有事件接口。"""
    try:
        user_id = decode_user_token(_websocket_token(websocket))
        user = await db.get(User, user_id)
        row = await get_terminal(db, user_id, terminal_id) if user and user.is_active else None
        if row is None or row.mode != "interactive-pty":
            raise HTTPException(status_code=404, detail="交互式终端不存在")
        access = await authorize_operation(
            db, user_id, owner_id=row.owner_id, session_id=row.session_id,
            workspace_id=row.workspace_id, operation=TerminalOperation.INPUT,
        )
        if not access.allowed:
            raise HTTPException(status_code=403, detail=access.reason)
        root = await resolve_shell_root(db, user_id, row.shell_mode, row.workspace_id)
        if root is None:
            raise HTTPException(status_code=403, detail="终端没有可用的沙盒目录")
        manager = get_pty_manager()
        spec = PtyLaunchSpec(
            terminal_id=row.id, root=str(root), shell_mode=row.shell_mode,
            network_profile=row.network_profile, cols=120, rows=32,
        )
        session = manager.get(row.id)
        if session is None:
            session = await manager.start(spec)
        await manager.attach(row.id)
        queue = await manager.subscribe(row.id)
        row.status = TerminalStatus.RUNNING.value
        row.pty_pid = session.handle.pid
        row.pty_sandbox_id = session.handle.sandbox_id
        row.pty_cols, row.pty_rows = session.cols, session.rows
        row.updated_at = now_utc()
        await db.commit()
        await events.publish(user_id, "terminals", operation="update", entity_id=row.id,
                             event_payload=serialize_terminal(row))
        # 浏览器通过 Sec-WebSocket-Protocol 携带认证令牌时，服务端必须回显
        # 同一个协议名，否则浏览器会在握手后立即以协议错误断开连接。
        await websocket.accept(subprotocol=_websocket_auth_protocol(websocket))
        logger.info("terminal_pty websocket_open terminal=%s user=%s", row.id, str(user_id)[:8])
        await websocket.send_json({
            "type": "ready", "terminalId": row.id, "mode": "interactive-pty",
            "cols": session.cols, "rows": session.rows,
        })
    except HTTPException as exc:
        logger.info("terminal_pty websocket_rejected status=%s", exc.status_code)
        await websocket.close(code=4401 if exc.status_code == 401 else 4403)
        return
    except (LookupError, RuntimeError, ValueError) as exc:
        logger.warning("terminal_pty websocket_setup_failed error=%s", type(exc).__name__)
        await websocket.close(code=4409, reason=str(exc)[:120])
        return

    receive_task = asyncio.create_task(websocket.receive_json())
    output_task = asyncio.create_task(queue.get())
    try:
        while True:
            done, _ = await asyncio.wait(
                {receive_task, output_task}, return_when=asyncio.FIRST_COMPLETED,
            )
            if output_task in done:
                chunk = output_task.result()
                if chunk is None:
                    row.status = TerminalStatus.EXITED.value
                    row.closed_at = now_utc()
                    row.updated_at = row.closed_at
                    await db.commit()
                    await events.publish(user_id, "terminals", operation="update", entity_id=row.id,
                                         event_payload=serialize_terminal(row))
                    await websocket.send_json({"type": "exit"})
                    break
                await websocket.send_json({
                    "type": "output", "data": base64.b64encode(chunk).decode("ascii"),
                })
                output_task = asyncio.create_task(queue.get())
            if receive_task in done:
                value = receive_task.result()
                message = PtyClientMessage.from_dict(value)
                if message.type == "input":
                    await manager.write(row.id, message.data.encode("utf-8"))
                elif message.type == "resize":
                    await manager.resize(row.id, message.cols, message.rows)
                    await websocket.send_json({"type": "status", "cols": message.cols, "rows": message.rows})
                elif message.type == "signal":
                    await manager.signal(row.id, message.signal)
                elif message.type == "detach":
                    break
                receive_task = asyncio.create_task(websocket.receive_json())
    except WebSocketDisconnect:
        logger.info("terminal_pty websocket_disconnected")
    except (ValueError, LookupError, RuntimeError) as exc:
        logger.warning("terminal_pty websocket_message_failed error=%s", type(exc).__name__)
        await websocket.send_json({"type": "error", "errorCode": "pty_request_rejected", "message": str(exc)[:120]})
    finally:
        receive_task.cancel()
        output_task.cancel()
        await asyncio.gather(receive_task, output_task, return_exceptions=True)
        await manager.unsubscribe(row.id, queue)
        try:
            await manager.detach(row.id)
        except LookupError:
            pass


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
                         event_payload={"terminal": serialize_terminal(row), "reset": True})
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


@router.post("/{terminal_id}/reset")
async def reset_terminal_view(terminal_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """重建当前终端的 PTY/沙盒运行态，不删除工作区文件或输出历史。"""
    row = _require(await get_terminal(db, user.id, terminal_id))
    access = await authorize_operation(db, user.id, owner_id=row.owner_id, session_id=row.session_id,
                                       workspace_id=row.workspace_id, operation=TerminalOperation.RESET)
    if not access.allowed:
        raise HTTPException(status_code=403, detail=access.reason)
    if row.mode == TerminalMode.INTERACTIVE_PTY.value:
        manager = get_pty_manager()
        if manager.get(row.id) is not None:
            try:
                await manager.terminate(row.id, force=True)
            except LookupError:
                pass
    await reset_terminal(db, row)
    await db.commit()
    await events.publish(user.id, "terminals", operation="update", entity_id=row.id,
                         event_payload={"terminal": serialize_terminal(row), "reset": True})
    return serialize_terminal(row)
