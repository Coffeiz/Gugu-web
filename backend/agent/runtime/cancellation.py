"""Web、IM 与 Agent 工具循环共用的运行中断策略。"""
from __future__ import annotations

import asyncio
import contextvars
import os
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, TypeVar

_T = TypeVar("_T")
_CANCEL_POLL_INTERVAL = 0.15
_LAST_CHECK_ERROR_LOG_AT = 0.0
_ACTIVE_RUNS: dict[str, "RunRecord"] = {}
_CURRENT_CANCELLATION: contextvars.ContextVar["RunCancellation | None"] = contextvars.ContextVar(
    "agent_run_cancellation", default=None,
)


def set_current_cancellation(cancellation: "RunCancellation") -> None:
    _CURRENT_CANCELLATION.set(cancellation)


def current_cancellation(session_id: int | None = None) -> "RunCancellation":
    cancellation = _CURRENT_CANCELLATION.get()
    if cancellation is not None and cancellation.session_id == session_id:
        return cancellation
    return RunCancellation(session_id)


def mark_remote_cancel_uncertain() -> None:
    """MCP task cancel 是协作式的；记录前端必须说明远端状态未确认。"""
    cancellation = _CURRENT_CANCELLATION.get()
    if cancellation is not None:
        cancellation.remote_status_unknown = True


def current_remote_status_unknown() -> bool:
    cancellation = _CURRENT_CANCELLATION.get()
    return bool(cancellation and cancellation.remote_status_unknown)


@dataclass(frozen=True)
class RunRecord:
    """当前进程中运行的任务索引；跨 worker 的取消仍由共享状态存储传播。"""

    source: str
    session_id: int | None
    run_id: str
    worker_id: str
    task: asyncio.Task


def register_current_run(session_id: int | None, run_id: str) -> RunRecord | None:
    """记录当前 run 来源、会话、worker 与 task，并在 task 结束时移除。"""
    task = asyncio.current_task()
    if task is None:
        return None
    from agent.im import imctx

    source = "im" if imctx.get_im() else "web"
    record = RunRecord(
        source=source,
        session_id=session_id,
        run_id=str(run_id),
        worker_id=os.getenv("WORKER_ID") or f"pid-{os.getpid()}",
        task=task,
    )
    _ACTIVE_RUNS[record.run_id] = record
    task.add_done_callback(lambda _task: _ACTIVE_RUNS.pop(record.run_id, None))
    return record


def active_run(run_id: str) -> RunRecord | None:
    """供本地取消和诊断路径按 run 身份检查当前执行 task。"""
    record = _ACTIVE_RUNS.get(str(run_id))
    return record if record and not record.task.done() else None


def _log_check_error(where: str, exc: Exception) -> None:
    """取消存储故障期间限频记录，避免工具轮询刷屏。"""
    global _LAST_CHECK_ERROR_LOG_AT
    now = time.monotonic()
    if now - _LAST_CHECK_ERROR_LOG_AT < 5:
        return
    _LAST_CHECK_ERROR_LOG_AT = now
    from app.core.redaction import diag_log

    diag_log(where, exc)


class RunCancellationRequested(Exception):
    """当前 Agent run 收到用户中断，loop 应收口而不是继续派发工具。"""


@dataclass
class RunCancellation:
    """把 Web session 标记和 IM 会话标记收敛为同一个取消检查入口。"""

    session_id: int | None
    _last_im_activity_refresh: float = field(default=0.0, init=False, repr=False, compare=False)
    _im_cancel_logged: bool = field(default=False, init=False, repr=False, compare=False)
    remote_status_unknown: bool = field(default=False, init=False)

    async def is_requested(self) -> bool:
        from agent.im import imctx

        im = imctx.get_im()
        if im and im.get("puid"):
            from agent.runtime import runtime_state

            bot_id = str(im.get("channel_id") or "")
            scope_id = str(im.get("chat_id") or im["puid"])
            try:
                now = time.monotonic()
                if now - self._last_im_activity_refresh >= 20:
                    await runtime_state.refresh_activity(
                        str(im["platform"]), bot_id, scope_id, str(im["puid"]),
                    )
                    self._last_im_activity_refresh = now
                if await runtime_state.is_cancelled(
                    str(im["platform"]), bot_id, scope_id, str(im["puid"]),
                ):
                    if not self._im_cancel_logged:
                        self._im_cancel_logged = True
                        from agent.security.logsafe import fingerprint
                        from app.core.redaction import diag_log_raw

                        diag_log_raw(
                            "agent.core.im_cancelled_hit",
                            f"platform={im['platform']} puid={fingerprint(im['puid'])}",
                        )
                    return True
            except Exception as exc:
                _log_check_error("agent.cancellation.im_check", exc)

        if self.session_id is None:
            return False
        from agent.llm import genstream

        try:
            return await genstream.is_cancelled(self.session_id)
        except Exception as exc:
            _log_check_error("agent.cancellation.web_check", exc)
            return False

    async def dispatch(
        self,
        operation: Callable[[], Awaitable[_T]],
        *,
        request_id: str | None,
    ) -> _T:
        """执行工具并监听同一取消信号；中断时尽力终止 sandboxd 当前命令。"""
        if await self.is_requested():
            await self.cancel_sandbox_request(request_id)
            raise RunCancellationRequested

        operation_task = asyncio.create_task(operation())
        cancellation_task = asyncio.create_task(self._wait_until_requested())
        try:
            done, _ = await asyncio.wait(
                (operation_task, cancellation_task),
                return_when=asyncio.FIRST_COMPLETED,
            )
            # 如果两个任务同时完成，优先保留已经完成的工具回执。
            if operation_task in done:
                return operation_task.result()

            await self.cancel_sandbox_request(request_id)
            operation_task.cancel()
            await asyncio.gather(operation_task, return_exceptions=True)
            raise RunCancellationRequested
        except asyncio.CancelledError:
            # Web 同进程取消会直接 cancel run task；先通知 sandboxd，再传播取消，
            # 避免只关闭 socket 而让 Docker 命令继续运行。
            await asyncio.shield(self.cancel_sandbox_request(request_id))
            operation_task.cancel()
            await asyncio.gather(operation_task, return_exceptions=True)
            raise
        finally:
            cancellation_task.cancel()
            await asyncio.gather(cancellation_task, return_exceptions=True)

    async def iterate(self, stream):
        """等待模型流的下一项时同步监听取消，不必等到 token/轮次检查点。"""
        iterator = stream.__aiter__()
        while True:
            next_task = asyncio.create_task(iterator.__anext__())
            cancel_task = asyncio.create_task(self._wait_until_requested())
            try:
                done, _ = await asyncio.wait(
                    (next_task, cancel_task), return_when=asyncio.FIRST_COMPLETED,
                )
                # 完成与取消同时发生时保留已到达的模型结果，和工具竞态一致。
                if next_task in done:
                    try:
                        yield next_task.result()
                    except StopAsyncIteration:
                        return
                else:
                    # 本地停止流和后续轮次，但 Provider 没有通用的远端撤销确认协议。
                    self.remote_status_unknown = True
                    next_task.cancel()
                    await asyncio.gather(next_task, return_exceptions=True)
                    close = getattr(iterator, "aclose", None)
                    if close:
                        await close()
                    raise RunCancellationRequested
            except asyncio.CancelledError:
                self.remote_status_unknown = True
                next_task.cancel()
                await asyncio.gather(next_task, return_exceptions=True)
                close = getattr(iterator, "aclose", None)
                if close:
                    await asyncio.shield(close())
                raise
            finally:
                cancel_task.cancel()
                await asyncio.gather(cancel_task, return_exceptions=True)

    async def _wait_until_requested(self) -> None:
        from agent.im import imctx

        im = imctx.get_im()
        # Web run 由 Gateway 的 Pub/Sub listener 主动 cancel；这里保留低频读标记
        # 作为通知断线时的兜底。IM 暂无对应 worker 唤醒通道，仍用短间隔协作检查。
        poll_interval = _CANCEL_POLL_INTERVAL if im and im.get("puid") else 5.0
        while True:
            try:
                if await self.is_requested():
                    return
            except Exception as exc:
                _log_check_error("agent.cancellation.wait", exc)
            try:
                await asyncio.wait_for(asyncio.Event().wait(), timeout=poll_interval)
            except asyncio.TimeoutError:
                pass

    @staticmethod
    async def cancel_sandbox_request(request_id: str | None) -> bool:
        if not request_id:
            return False
        try:
            from app.core.config import get_settings
            from agent.sandbox.client import SandboxdClient

            socket_path = str(get_settings().sandbox.sandboxd_socket or "").strip()
            if not socket_path:
                return False
            return await SandboxdClient(socket_path, connect_timeout=0.5).cancel(request_id)
        except Exception as exc:
            from app.core.redaction import diag_log

            diag_log("agent.cancellation.sandboxd_cancel", exc)
            return False


async def request_cancel(
    *,
    session_id: int | None = None,
    owner_run_id: str | None = None,
    platform: str | None = None,
    bot_id: str | None = None,
    scope_id: str | None = None,
    puid: str | None = None,
) -> bool:
    """按 Web run 或 IM 会话作用域写入取消信号。"""
    if session_id is not None:
        from agent.llm import genstream

        await genstream.request_cancel(session_id, owner_run_id)
        return True

    from agent.runtime import runtime_state

    return await runtime_state.request_cancel(platform, bot_id, scope_id, puid)


def request_cancel_sync(
    *,
    platform: str,
    bot_id: str,
    scope_id: str,
    puid: str,
) -> bool:
    """同步 Gateway 回调使用的 IM 取消信号入口。"""
    from agent.runtime import runtime_state

    return runtime_state.request_cancel_sync(platform, bot_id, scope_id, puid)
