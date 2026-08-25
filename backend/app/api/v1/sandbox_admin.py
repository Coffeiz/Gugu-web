"""Admin Shell 容器沙盒管理接口。"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from agent.sandbox.docker_runtime import (
    DockerRuntimeStatus,
    cleanup_running_sandboxes,
    cleanup_sandboxes_for_root,
    image_available,
    probe_docker,
    valid_image_digest,
)
from app.core.config import get_settings, invalidate_settings_cache, write_override_json
from agent.sandbox.quota import clear_sandbox_directory
from agent.security.logsafe import fingerprint

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/sandbox", tags=["admin"])


class SandboxLifecycleRequest(BaseModel):
    user_ids: list[str] = Field(default_factory=list, max_length=100)
    confirm_text: str = ""


def _require_lifecycle_confirmation(body: SandboxLifecycleRequest, operation: str) -> None:
    expected = f"确认{operation}沙盒"
    if body.confirm_text != expected:
        raise HTTPException(status_code=409, detail=f"{operation}沙盒需要输入确认文字：{expected}")


def _sandbox_root(user_id: str) -> Path:
    settings = get_settings()
    if settings.storage.backend not in {"local", "oss"}:
        raise HTTPException(status_code=409, detail="当前存储后端没有可用的本地 Shell 沙盒根目录")
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    root = (storage_root / str(user_id) / "shell").resolve()
    if root.parent.parent != storage_root or root.name != "shell":
        raise HTTPException(status_code=500, detail="Shell 沙盒根目录配置无效")
    root.mkdir(parents=True, exist_ok=True)
    return root


def _state(
    status: DockerRuntimeStatus,
    *,
    enabled: bool,
    rootless_required: bool,
    image_ready: bool,
) -> tuple[str, str]:
    if not status.installed:
        return "docker_missing", status.message
    if not status.daemon_ready:
        return "docker_unavailable", status.message
    if rootless_required and status.rootless is not True:
        return "rootless_required", "当前 Docker 不是 Rootless 模式"
    if not enabled:
        return "disabled", "沙盒已关闭"
    if not image_ready:
        return "image_unavailable", "固定 Shell 沙盒镜像尚未加载到当前 Docker daemon"
    return "ready", "Docker 沙盒运行时已就绪"


def _response():
    cfg = get_settings().sandbox
    runtime = probe_docker()
    image_ready = (
        runtime.daemon_ready
        and valid_image_digest(cfg.image_digest)
        and image_available(cfg.image, cfg.image_digest)
    )
    state, message = _state(
        runtime,
        enabled=cfg.enabled,
        rootless_required=cfg.rootless_required,
        image_ready=image_ready,
    )
    return {
        "enabled": bool(cfg.enabled),
        "docker_installed": runtime.installed,
        "docker_daemon_ready": runtime.daemon_ready,
        "rootless": runtime.rootless,
        "image_ready": image_ready,
        # 执行器前置条件与全局开关分开显示：关闭沙盒时仍应显示 Docker
        # 执行器是否已经准备好，否则 Admin 无法判断为什么可以/不能开启。
        "executor_ready": bool(
            runtime.executor_ready
            and (not cfg.rootless_required or runtime.rootless is True)
            and image_ready
        ),
        "state": state,
        "message": message,
        "image": cfg.image,
        "image_digest": cfg.image_digest,
        "persistent_quota_bytes": cfg.persistent_quota_bytes,
        "ephemeral_quota_bytes": cfg.ephemeral_quota_bytes,
        "network_profile": cfg.network_profile,
        "lifecycle_mode": "ephemeral",
        "rootless_required": cfg.rootless_required,
        "updated_at": None,
    }


@router.get("/status")
async def sandbox_status():
    return _response()


@router.post("/enable")
async def enable_sandbox():
    cfg = get_settings().sandbox
    runtime = probe_docker()
    image_ready = (
        runtime.daemon_ready
        and valid_image_digest(cfg.image_digest)
        and image_available(cfg.image, cfg.image_digest)
    )
    state, message = _state(
        runtime,
        enabled=True,
        rootless_required=cfg.rootless_required,
        image_ready=image_ready,
    )
    if state != "ready":
        raise HTTPException(status_code=409, detail=message)
    if not valid_image_digest(cfg.image_digest):
        raise HTTPException(status_code=409, detail="尚未配置有效的固定镜像 digest，不能开启生产沙盒")
    override = _read_override()
    sandbox = override.setdefault("sandbox", {})
    sandbox["enabled"] = True
    write_override_json(override)
    invalidate_settings_cache()
    return _response()


@router.post("/disable")
async def disable_sandbox():
    override = _read_override()
    sandbox = override.setdefault("sandbox", {})
    sandbox["enabled"] = False
    write_override_json(override)
    invalidate_settings_cache()
    reclaimed = cleanup_running_sandboxes()
    response = _response()
    response["reclaimed_containers"] = reclaimed
    return response


@router.post("/restart")
async def restart_sandbox():
    """回收当前运行态临时容器；下一条命令会使用最新固定配置创建容器。"""
    reclaimed = cleanup_running_sandboxes()
    logger.info("sandbox_admin_restart reclaimed=%d", reclaimed)
    response = _response()
    response.update({"operation": "restart", "reclaimed_containers": reclaimed})
    return response


@router.post("/rebuild")
async def rebuild_sandbox():
    """重新建立临时执行基线，不删除用户数据、镜像或配额记录。"""
    reclaimed = cleanup_running_sandboxes()
    response = _response()
    response.update({"operation": "rebuild", "reclaimed_containers": reclaimed})
    return response


@router.post("/users/restart")
async def restart_user_sandboxes(body: SandboxLifecycleRequest):
    _require_lifecycle_confirmation(body, "重启")
    results = []
    for user_id in dict.fromkeys(body.user_ids):
        root = _sandbox_root(user_id)
        results.append({"user_id": fingerprint(user_id), "reclaimed_containers": cleanup_sandboxes_for_root(str(root))})
    return {"operation": "restart", "results": results}


@router.post("/users/rebuild")
async def rebuild_user_sandboxes(body: SandboxLifecycleRequest):
    _require_lifecycle_confirmation(body, "重建")
    results = []
    for user_id in dict.fromkeys(body.user_ids):
        root = _sandbox_root(user_id)
        reclaimed = cleanup_sandboxes_for_root(str(root))
        results.append({"user_id": fingerprint(user_id), "reclaimed_containers": reclaimed, "root_ready": root.is_dir()})
    return {"operation": "rebuild", "results": results}


@router.post("/users/clear")
async def clear_user_sandboxes(body: SandboxLifecycleRequest):
    if body.confirm_text != "清空沙盒":
        raise HTTPException(status_code=409, detail="清空沙盒需要输入确认文字：清空沙盒")
    results = []
    for user_id in dict.fromkeys(body.user_ids):
        root = _sandbox_root(user_id)
        reclaimed = cleanup_sandboxes_for_root(str(root))
        removed = clear_sandbox_directory(root)
        results.append({"user_id": fingerprint(user_id), "removed_entries": removed, "reclaimed_containers": reclaimed})
    return {"operation": "clear", "results": results}


def _read_override() -> dict:
    from app.core.config import OVERRIDE_FILE
    import json

    if not OVERRIDE_FILE.exists():
        return {}
    try:
        value = json.loads(OVERRIDE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="配置文件不可读") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=500, detail="配置文件格式无效")
    return value
