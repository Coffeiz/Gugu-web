"""安全出站代理的 Admin 配置与连通性测试。"""
from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import get_settings, save_override
from app.core.safe_egress import SafeEgressClient, SafeEgressError, validate_proxy_url

router = APIRouter(prefix="/admin/safe-egress", tags=["admin-safe-egress"])


class SafeEgressPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool | None = None
    proxy_url: str | None = None
    proxy_username: str | None = None
    proxy_password: str | None = None
    clear_credentials: bool = False


class SafeEgressTestRequest(SafeEgressPatch):
    enabled: bool = True


def _has_auth(value: str) -> bool:
    return bool(value)


@router.get("")
async def get_safe_egress_config() -> dict[str, Any]:
    current = get_settings().safe_egress
    return {
        "enabled": current.enabled,
        "proxy_url": current.proxy_url,
        "has_auth": _has_auth(current.proxy_auth_secret),
    }


def _encrypted_auth(username: str, password: str) -> str:
    from app.core.crypto import encrypt_secret

    return encrypt_secret(json.dumps({"username": username, "password": password}, ensure_ascii=False))


def _current_auth() -> tuple[str, str]:
    from app.core.crypto import decrypt_secret

    token = get_settings().safe_egress.proxy_auth_secret
    if not token:
        return "", ""
    try:
        value = json.loads(decrypt_secret(token))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="代理认证配置不可读取，请重新保存") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=500, detail="代理认证配置无效，请重新保存")
    return str(value.get("username") or ""), str(value.get("password") or "")


def _make_settings(
    *, enabled: bool, proxy_url: str, username: str = "", password: str = "",
):
    from app.core.config import SafeEgressSettings

    auth_secret = _encrypted_auth(username, password) if username or password else ""
    return SafeEgressSettings(
        enabled=enabled,
        proxy_url=proxy_url,
        proxy_auth_secret=auth_secret,
    )


@router.patch("")
async def patch_safe_egress_config(body: SafeEgressPatch) -> dict[str, Any]:
    current = get_settings().safe_egress
    enabled = body.enabled if body.enabled is not None else current.enabled
    proxy_url = body.proxy_url if body.proxy_url is not None else current.proxy_url
    if enabled:
        try:
            proxy_url = validate_proxy_url(proxy_url)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    elif proxy_url:
        try:
            proxy_url = validate_proxy_url(proxy_url)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    username, password = _current_auth()
    if body.clear_credentials:
        username, password = "", ""
    else:
        if body.proxy_username is not None:
            username = body.proxy_username
        if body.proxy_password is not None:
            password = body.proxy_password
    settings = _make_settings(enabled=enabled, proxy_url=proxy_url, username=username, password=password)
    try:
        await save_override({"safe_egress": settings.model_dump()})
    except Exception as exc:
        # 配置写入错误可能包含本机路径，不外发原始异常文本。
        from app.core.redaction import diag_log

        diag_log("admin.safe_egress.save", exc)
        raise HTTPException(status_code=500, detail="代理配置保存失败") from exc
    return {
        "enabled": settings.enabled,
        "proxy_url": settings.proxy_url,
        "has_auth": bool(settings.proxy_auth_secret),
    }


@router.post("/test")
async def test_safe_egress(body: SafeEgressTestRequest) -> dict[str, Any]:
    current = get_settings().safe_egress
    proxy_url = body.proxy_url if body.proxy_url is not None else current.proxy_url
    try:
        proxy_url = validate_proxy_url(proxy_url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    username, password = _current_auth()
    if body.clear_credentials:
        username, password = "", ""
    else:
        if body.proxy_username is not None:
            username = body.proxy_username
        if body.proxy_password is not None:
            password = body.proxy_password
    candidate = _make_settings(enabled=True, proxy_url=proxy_url, username=username, password=password)
    started = time.monotonic()
    try:
        # 固定目标只验证代理、DoH、IP 钉扎和 TLS 身份，不接受调用方传入任意 URL。
        async with SafeEgressClient(candidate).stream(
            "https://ja.wikipedia.org/wiki/Muque", timeout=15.0,
            headers={"User-Agent": "Gugu-web/1.0"},
        ) as response:
            status = response.status_code
    except SafeEgressError as exc:
        return {
            "ok": False,
            "stage": exc.code,
            "message": exc.message,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("admin.safe_egress.test", exc)
        return {
            "ok": False,
            "stage": "proxy_unavailable",
            "message": "代理连接或安全 TLS 握手失败",
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }
    return {
        "ok": 200 <= status < 500,
        "stage": "connected" if 200 <= status < 500 else "upstream_http_error",
        "message": "代理、DNS、IP 钉扎和 TLS 验证均已通过" if 200 <= status < 500 else "已连通代理，但上游返回错误状态",
        "status_code": status,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
    }
