"""Admin Docker 更新接口。镜像/路径/命令均由 updater sidecar 固定，不接受前端指定。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.audit_log import write_log
from app.db.session import get_db
from app.models import AuditLog
from updater.client import UpdaterClientError, call_updater

router = APIRouter(prefix="/admin/update", tags=["admin"])


class ConfirmationRequest(BaseModel):
    challenge: str = Field(min_length=32, max_length=128)
    manifest_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


def _operator(request: Request) -> str:
    return str(getattr(request.state, "admin_username", "admin"))[:100]


async def _call(method: str, **params) -> dict:
    try:
        return await call_updater(method, **params)
    except UpdaterClientError as exc:
        status = 503 if exc.code == "updater_unavailable" else 502 if exc.code == "update_source_unavailable" else 500 if exc.code == "internal_error" else 409 if exc.code in {
            "busy", "preflight_failed", "challenge_expired", "challenge_invalid",
        } else 409 if exc.code == "operation_failed" else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc


async def _audit(db: AsyncSession, request: Request, action: str, description: str) -> None:
    await write_log(db, _operator(request), action, description, request)


@router.get("/status")
async def update_status(request: Request, db: AsyncSession = Depends(get_db)):
    result = await _call("status")
    task = result.get("task")
    if isinstance(task, dict) and task.get("status") in {"succeeded", "failed", "rollback_required"}:
        task_id = str(task.get("id") or "")
        terminal_status = str(task.get("status"))
        description = f"Docker 更新任务 {task_id} 结束：{terminal_status}，版本 {str(task.get('version') or 'unknown')[:32]}"
        existing = await db.scalar(select(AuditLog.id).where(
            AuditLog.action == "docker_update_result",
            AuditLog.description == description,
        ).limit(1))
        if not existing and task_id:
            await _audit(db, request, "docker_update_result", description)
    return result


@router.post("/check")
async def check_update(request: Request, db: AsyncSession = Depends(get_db)):
    result = await _call("check")
    candidate = result.get("candidate") or {}
    version = str(candidate.get("version") or "unknown")[:32]
    await _audit(db, request, "docker_update_check", f"检查 Docker 更新：{version}")
    return result


@router.post("/preflight")
async def update_preflight(request: Request, db: AsyncSession = Depends(get_db)):
    result = await _call("preflight", operator=_operator(request))
    passed = bool(result.get("ready"))
    version = str((result.get("candidate") or {}).get("version") or "unknown")[:32]
    await _audit(
        db, request, "docker_update_preflight",
        f"Docker 更新预检 {'通过' if passed else '未通过'}：{version}",
    )
    return result


@router.post("/start")
async def start_update(body: ConfirmationRequest, request: Request, db: AsyncSession = Depends(get_db)):
    if not body.manifest_sha256:
        raise HTTPException(status_code=422, detail="缺少 manifest 摘要")
    # 先提交审计，再通知 updater 延迟启动；更新容器可能在几秒后被自己停止重建。
    await _audit(db, request, "docker_update_start", "管理员确认开始 Docker 更新")
    return await _call(
        "start", challenge=body.challenge,
        manifest_sha256=body.manifest_sha256,
        operator=_operator(request),
    )


@router.post("/rollback/preflight")
async def rollback_preflight(request: Request, db: AsyncSession = Depends(get_db)):
    result = await _call("rollback_preflight", operator=_operator(request))
    await _audit(db, request, "docker_rollback_preflight", "检查 Docker 回滚条件")
    return result


@router.post("/rollback")
async def rollback(body: ConfirmationRequest, request: Request, db: AsyncSession = Depends(get_db)):
    await _audit(db, request, "docker_rollback_start", "管理员确认执行 Docker 回滚")
    return await _call(
        "rollback", challenge=body.challenge,
        operator=_operator(request),
    )
