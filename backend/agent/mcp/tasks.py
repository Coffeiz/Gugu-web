"""MCP Tasks 扩展的共享轮询与取消收口。"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any


async def wait_for_task(
    task_id: str,
    initial: dict[str, Any],
    *,
    request: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]],
    cancel: Callable[[], Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    """轮询任务终态；取消时 best-effort 发 tasks/cancel，状态仍以远端为准。"""
    current = initial
    try:
        while True:
            status = str(current.get("status") or "working")
            if status == "completed":
                return current.get("result") or {}
            if status == "cancelled":
                return {"error": "MCP 远端任务已取消", "error_kind": "cancelled"}
            if status == "failed":
                error = current.get("error") or {}
                message = error.get("message") if isinstance(error, dict) else str(error)
                return {"error": message or "MCP 远端任务失败", "error_kind": "remote"}
            if status == "input_required":
                try:
                    await cancel()
                except Exception:
                    pass
                return {"error": "MCP 远端任务需要交互输入，当前客户端无法继续", "error_kind": "remote"}
            try:
                delay = min(30.0, max(0.1, float(current.get("pollIntervalMs", 1000)) / 1000))
            except (TypeError, ValueError):
                delay = 1.0
            await asyncio.sleep(delay)
            current = await request("tasks/get", {"taskId": task_id})
    except asyncio.CancelledError:
        from agent.runtime.cancellation import mark_remote_cancel_uncertain

        mark_remote_cancel_uncertain()
        try:
            await asyncio.shield(cancel())
        except Exception:
            pass
        raise
