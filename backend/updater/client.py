"""Admin 更新入口：单容器使用进程内应用包执行器，Compose 仅返回手动更新状态。"""

from __future__ import annotations

from typing import Any

from updater.daemon import self_update_enabled
from updater.deployment import detect_deployment

_app_bundle_executor = None


class UpdaterClientError(RuntimeError):
    def __init__(self, code: str, message: str = "更新服务暂不可用") -> None:
        super().__init__(message)
        self.code = code


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
    """仅为无 Compose 单容器提供签名应用包更新；镜像由部署平台管理。"""
    deployment = detect_deployment()
    if method == "status" and not deployment["enabled"]:
        return {
            **deployment,
            "current": None, "candidate": None, "has_update": False,
            "task": None, "history": [],
        }
    if method != "status" and not deployment["enabled"]:
        raise UpdaterClientError(deployment["reason_code"], deployment["reason"])
    if method != "status" and not self_update_enabled():
        raise UpdaterClientError("self_update_disabled", "此部署未启用一键更新")
    if deployment["mode"] != "standalone_app_bundle":
        raise UpdaterClientError(deployment["reason_code"], deployment["reason"])
    try:
        global _app_bundle_executor
        if _app_bundle_executor is None:
            from updater.app_bundle import AppBundleUpdater

            _app_bundle_executor = AppBundleUpdater()
        return await _app_bundle_executor.dispatch(method, params)
    except Exception as exc:
        if method == "status":
            deployment.update({
                "enabled": False, "capability": "manual",
                "reason_code": "updater_initialization_failed",
                "reason": "应用包更新器初始化失败；请由 Docker 管理器更新整镜像。",
            })
            return {
                **deployment, "current": None, "candidate": None, "has_update": False,
                "task": None, "history": [],
            }
        raise UpdaterClientError(_error_code(exc), str(exc)[:240]) from exc
