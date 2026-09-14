"""Admin 更新端点 → 进程内更新执行器（PRD-ADMIN-2 §1.1）。

执行器与 backend 同进程，无 Unix Socket IPC；GUGU_SELF_UPDATE=off 或 Docker
socket 未挂载时调用抛 self_update_disabled，更新页据此显示「未启用一键更新」。
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

from updater.daemon import UpdateDaemon, self_update_enabled

_executor: UpdateDaemon | None = None
_executor_failed = False


class UpdaterClientError(RuntimeError):
    def __init__(self, code: str, message: str = "更新服务暂不可用") -> None:
        super().__init__(message)
        self.code = code


def _get_executor() -> UpdateDaemon:
    global _executor, _executor_failed
    if _executor is not None:
        return _executor
    if _executor_failed:
        raise UpdaterClientError("self_update_disabled", "此部署未启用一键更新")
    if not self_update_enabled():
        raise UpdaterClientError("self_update_disabled", "此部署未启用一键更新")
    try:
        _executor = UpdateDaemon()
    except Exception as exc:
        # Compose 目录无效 / 状态文件损坏等：按未启用降级，不让 admin 反复 500。
        _executor_failed = True
        raise UpdaterClientError("self_update_disabled", "此部署未启用一键更新") from exc
    return _executor


def _error_code(exc: Exception) -> str:
    message = str(exc)
    if isinstance(exc, RuntimeError) and message.startswith("已有 Docker 更新"):
        return "busy"
    if "过期" in message:
        return "challenge_expired"
    if message.startswith("无法访问 GitHub Release"):
        return "update_source_unavailable"
    if "预检" in message or "空间不足" in message or "未运行" in message:
        return "preflight_failed"
    if "确认" in message:
        return "challenge_invalid"
    if isinstance(exc, ValueError):
        return "invalid_request"
    if isinstance(exc, RuntimeError):
        return "operation_failed"
    return "internal_error"


async def call_updater(method: str, **params: Any) -> dict[str, Any]:
    """进程内直调执行器；错误码语义与旧 sidecar RPC 完全一致。"""
    if method != "status" and not self_update_enabled():
        raise UpdaterClientError("self_update_disabled", "此部署未启用一键更新")
    try:
        executor = _get_executor()
    except UpdaterClientError:
        if method == "status":
            # 未启用时 status 仍返回结构化结果，前端据此渲染「未启用」面板。
            return {"enabled": False, "current": None, "candidate": None,
                    "has_update": False, "task": None, "history": []}
        raise
    try:
        return await asyncio.wait_for(
            executor.dispatch({"method": method, "params": params}), timeout=90
        )
    except UpdaterClientError:
        raise
    except asyncio.TimeoutError as exc:
        raise UpdaterClientError("operation_failed", "更新命令超时") from exc
    except Exception as exc:
        raise UpdaterClientError(_error_code(exc), str(exc)[:240]) from exc
