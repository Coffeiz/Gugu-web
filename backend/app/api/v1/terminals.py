"""共享协作终端 API。"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import account_is_active, decode_user_token, get_current_user, is_user_active
from app.core.tz import now_utc
from app.core import events
from app.db.session import get_db
from app.models import User
from app.services.terminals import (
    create_terminal, delete_terminal, get_terminal, list_terminals,
    terminate_terminal as terminate_terminal_record,
    prune_terminals, reopen_terminal, reset_terminal, rename_terminal, serialize_event, serialize_terminal, terminal_events, terminal_metrics,
    append_shell_result, append_terminal_status,
)
from agent.terminal.access import TerminalOperation, authorize_operation, page_access
from agent.terminal.contracts import TerminalMode
from agent.terminal.contracts import TerminalStatus
from agent.terminal.protocol import PtyClientMessage
from agent.terminal.pty_manager import PtyLaunchSpec
from agent.terminal.runtime import get_pty_manager
from app.services.workspaces import resolve_shell_root
from agent.tools.shell import _shell
from agent.sandbox.client import SandboxdClient
from app.core.config import get_settings
import app.db.session as db_session

router = APIRouter(prefix="/terminals", tags=["terminals"])
logger = logging.getLogger(__name__)
_terminal_tasks: dict[str, asyncio.Task] = {}
_terminal_event_locks: dict[str, asyncio.Lock] = {}


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
    manager = None
    queue = None
    attached = False
    try:
        user_id = decode_user_token(_websocket_token(websocket))
        from app.security.risk_policy import enforce_user_throttle
        await enforce_user_throttle(user_id)
        user = await db.get(User, user_id)
        row = await get_terminal(db, user_id, terminal_id) if account_is_active(user) else None
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
        # 先完成 WebSocket 握手，再启动 PTY/发布状态事件，避免慢沙盒或事件总线让
        # 浏览器/Nginx 在握手阶段超时后，服务端仍尝试 accept 已断开的连接。
        await websocket.accept(subprotocol=_websocket_auth_protocol(websocket))
        manager = get_pty_manager()
        spec = PtyLaunchSpec(
            terminal_id=row.id, root=str(root), shell_mode=row.shell_mode,
            network_profile=row.network_profile, cols=120, rows=32,
        )
        session = manager.get(row.id)
        if session is None:
            session, queue = await manager.start_with_subscription(spec)
        else:
            await manager.attach(row.id)
            attached = True
            queue = await manager.subscribe(row.id)
        if not attached:
            await manager.attach(row.id)
            attached = True
        row.status = TerminalStatus.RUNNING.value
        row.pty_pid = session.handle.pid
        row.pty_sandbox_id = session.handle.sandbox_id
        row.pty_cols, row.pty_rows = session.cols, session.rows
        row.updated_at = now_utc()
        await db.commit()
        await events.publish(user_id, "terminals", operation="update", entity_id=row.id,
                             event_payload=serialize_terminal(row))
        logger.info("terminal_pty websocket_open terminal=%s user=%s", row.id, str(user_id)[:8])
        await websocket.send_json({
            "type": "ready", "terminalId": row.id, "mode": "interactive-pty",
            "cols": session.cols, "rows": session.rows,
        })
    except WebSocketDisconnect:
        logger.info("terminal_pty websocket_disconnected_during_setup")
        if manager is not None:
            try:
                if queue is not None:
                    await manager.unsubscribe(row.id, queue)
                if attached:
                    await manager.detach(row.id)
            except (LookupError, RuntimeError):
                logger.info("terminal_pty setup_cleanup_skipped")
        return
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
    status_task = asyncio.create_task(_wait_for_account_suspend(user_id))
    try:
        while True:
            done, _ = await asyncio.wait(
                {receive_task, output_task, status_task}, return_when=asyncio.FIRST_COMPLETED,
            )
            if status_task in done:
                if not status_task.result():
                    await websocket.close(code=4403, reason="账号暂时不可用")
                break
            if output_task in done:
                chunk = output_task.result()
                if chunk is None:
                    # 用户主动停止时，记录的 terminated 优先于 PTY 的退出回调，
                    # 避免停止后又被异步队列结束事件改写成 exited。
                    if row.status != TerminalStatus.TERMINATED.value:
                        row.status = TerminalStatus.EXITED.value
                        row.closed_at = now_utc()
                        row.updated_at = row.closed_at
                        await db.commit()
                        await events.publish(user_id, "terminals", operation="update", entity_id=row.id,
                                             event_payload=serialize_terminal(row))
                    try:
                        await websocket.send_json({"type": "exit"})
                    except (RuntimeError, WebSocketDisconnect):
                        # 客户端可能已在 PTY 退出前主动断开，不能向已关闭连接补发消息。
                        pass
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
        try:
            await websocket.send_json({"type": "error", "errorCode": "pty_request_rejected", "message": str(exc)[:120]})
        except (RuntimeError, WebSocketDisconnect):
            pass
    finally:
        receive_task.cancel()
        output_task.cancel()
        status_task.cancel()
        await asyncio.gather(receive_task, output_task, status_task, return_exceptions=True)
        await manager.unsubscribe(row.id, queue)
        try:
            await manager.detach(row.id)
        except LookupError:
            pass


async def _wait_for_account_suspend(user_id):
    """轮询账户安全状态，避免已建立的终端连接绕过冻结。"""
    while True:
        await asyncio.sleep(5)
        try:
            active = await is_user_active(user_id)
        except Exception:
            # 已建立连接遇到一次数据库抖动时保留连接，下一轮继续检查。
            logger.warning("terminal_pty account_status_check_failed")
            continue
        if not active:
            return False


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
    request_id = uuid4().hex
    status_event = await append_terminal_status(db, row, command=body.command, status="running", run_id=request_id)
    await db.commit()
    await events.publish(user.id, "terminals", operation="append", entity_id=row.id,
                         event_payload={"terminal_id": row.id, "event": serialize_event(status_event),
                                        "terminal": serialize_terminal(row)})
    task = asyncio.create_task(_run_terminal_command(user.id, row.id, request_id, body))
    _terminal_tasks[request_id] = task
    task.add_done_callback(lambda finished: _terminal_tasks.pop(request_id, None))
    return {"terminal": serialize_terminal(row), "requestId": request_id, "event": serialize_event(status_event)}


async def _run_terminal_command(user_id, terminal_id: str, request_id: str, body: TerminalInput) -> None:
    """在独立数据库会话中执行用户命令，避免占用 HTTP 请求生命周期。"""
    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        row = await get_terminal(db, user_id, terminal_id)
        if row is None or row.closed_at is not None:
            return
        before_sequence = row.last_sequence

        async def publish_output(stream: str, data: str) -> None:
            await events.publish(user_id, "terminals", operation="append", entity_id=terminal_id,
                                 event_payload={
                                     "terminal_id": terminal_id,
                                     "event": {
                                         "sequence": 0, "type": "output", "source": "user",
                                         "runId": request_id, "command": body.command,
                                         "stdout": data if stream == "stdout" else "",
                                         "stderr": data if stream == "stderr" else "",
                                         "exitCode": None, "occurredAt": now_utc().isoformat(),
                                     },
                                 })

        try:
            result = await _shell(db, user_id, {
                "_session_id": row.session_id, "_workspace_id": row.workspace_id,
                "_terminal_id": row.id, "_terminal_source": "user", "_run_id": request_id,
                "_terminal_parallel": True, "_defer_terminal_event": True,
                "command": body.command, "cwd": body.cwd, "timeout": body.timeout,
                "max_output_chars": body.maxOutputChars, "network": body.network,
                "confirm": body.confirm, "confirm_token": body.confirmToken,
                "_on_output": publish_output,
            })
        except asyncio.CancelledError:
            await db.rollback()
            lock = _terminal_event_locks.setdefault(terminal_id, asyncio.Lock())
            async with lock:
                row = await get_terminal(db, user_id, terminal_id)
                if row is not None and row.closed_at is None:
                    before_sequence = row.last_sequence
                    await append_shell_result(db, row, command=body.command, stdout="", stderr="命令已取消",
                                              exit_code=None, ok=False, source="user", run_id=request_id)
                    cancelled_event = (await terminal_events(db, row, before_sequence))[-1]
                    await db.commit()
                    await events.publish(user_id, "terminals", operation="append", entity_id=row.id,
                                         event_payload={"terminal_id": row.id, "event": serialize_event(cancelled_event),
                                                        "terminal": serialize_terminal(row)})
            raise
        except Exception:
            await db.rollback()
            row = await get_terminal(db, user_id, terminal_id)
            result = {"ok": False, "error": "命令执行失败"}
        await db.commit()
        lock = _terminal_event_locks.setdefault(terminal_id, asyncio.Lock())
        async with lock:
            row = await get_terminal(db, user_id, terminal_id)
            if row is None or row.closed_at is not None:
                return
            before_sequence = row.last_sequence
            if isinstance(result, dict) and result.get("ok") is not None:
                stdout = str(result.get("stdout") or "")
                stderr = str(result.get("stderr") or "")
                exit_code = result.get("exit_code")
                ok = bool(result.get("ok"))
            else:
                stdout, stderr, exit_code, ok = "", str(result.get("error") or "命令执行失败"), 1, False
            await append_shell_result(db, row, command=body.command, stdout=stdout, stderr=stderr,
                                      exit_code=exit_code, ok=ok, source="user", run_id=request_id)
            new_events = await terminal_events(db, row, before_sequence)
            await db.commit()
        await events.publish(user_id, "terminals", operation="append", entity_id=row.id,
                             event_payload={"terminal_id": row.id, "event": serialize_event(new_events[-1]),
                             "terminal": serialize_terminal(row)})


@router.post("/{terminal_id}/cancel/{request_id}")
async def cancel_terminal_command(terminal_id: str, request_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = _require(await get_terminal(db, user.id, terminal_id))
    access = await authorize_operation(db, user.id, owner_id=row.owner_id, session_id=row.session_id,
                                       workspace_id=row.workspace_id, operation=TerminalOperation.INPUT)
    if not access.allowed:
        raise HTTPException(status_code=403, detail=access.reason)
    task = _terminal_tasks.get(request_id)
    if task is None or task.done():
        return {"cancelled": False}
    if row.shell_mode == "sandbox":
        socket_path = get_settings().sandbox.sandboxd_socket
        if socket_path:
            await SandboxdClient(socket_path).cancel(request_id)
    task.cancel()
    return {"cancelled": True, "requestId": request_id}


@router.post("/{terminal_id}/terminate")
async def terminate_terminal_view(terminal_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = _require(await get_terminal(db, user.id, terminal_id))
    access = await authorize_operation(db, user.id, owner_id=row.owner_id, session_id=row.session_id, operation=TerminalOperation.TERMINATE)
    if not access.allowed:
        raise HTTPException(status_code=403, detail=access.reason)
    await terminate_terminal_record(db, row)
    await db.commit()
    # 先提交 terminated 再关 PTY，WebSocket 的异步退出回调才能保留用户的
    # 主动停止状态，不会把它覆盖成 exited。
    if row.mode == TerminalMode.INTERACTIVE_PTY.value:
        manager = get_pty_manager()
        if manager.get(row.id) is not None:
            try:
                await manager.terminate(row.id, force=True)
            except LookupError:
                pass
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
