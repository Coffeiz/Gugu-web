"""Telegram Bot API 客户端。

Telegram 官方 API 要求 Token 位于 HTTPS 路径中。该例外仅存在于本模块的
进程内请求构造阶段：固定官方主机、禁用重定向，且绝不记录完整 URL/响应正文。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from app.core.config import get_settings
from app.core.safe_egress import build_httpx_proxy

_API_BASE = "https://api.telegram.org"
_TOKEN_RE = re.compile(r"^[0-9]{5,20}:[A-Za-z0-9_-]{20,128}$")


@dataclass
class TelegramBotApiError(Exception):
    """不包含 Token、请求 URL 或远端原始正文的安全 API 错误。"""

    operation: str
    status_code: int | None = None
    error_code: int | None = None
    retry_after: int | None = None

    def __post_init__(self):
        Exception.__init__(self, f"Telegram {self.operation} 请求失败")


def validate_bot_token(token: str) -> str:
    value = str(token or "").strip()
    if len(value) > 160 or not _TOKEN_RE.fullmatch(value):
        raise ValueError("Telegram Bot Token 格式无效")
    return value


async def call(token: str, method: str, *, payload: dict[str, Any] | None = None,
               files: dict[str, tuple[str, bytes, str]] | None = None,
               timeout: float = 20.0) -> Any:
    """调用固定 Telegram API 主机；错误对象不携带可能泄露 Token 的 httpx 异常。"""
    safe_token = validate_bot_token(token)
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,63}", method):
        raise ValueError("Telegram API 方法名无效")
    client_options = {
        "base_url": _API_BASE,
        "timeout": timeout,
        "follow_redirects": False,
        "trust_env": True,
    }
    try:
        egress = get_settings().safe_egress
        if egress.enabled:
            client_options["proxy"] = build_httpx_proxy(egress)
            client_options["trust_env"] = False
    except Exception:
        # 配置异常也不能泄露 Token 所在请求路径。
        raise TelegramBotApiError(method) from None
    try:
        async with httpx.AsyncClient(**client_options) as client:
            if files:
                form_data = {
                    key: str(value).lower() if isinstance(value, bool) else str(value)
                    for key, value in (payload or {}).items()
                }
                response = await client.post(
                    f"/bot{safe_token}/{method}", data=form_data, files=files,
                )
            else:
                response = await client.post(
                    f"/bot{safe_token}/{method}", json=payload or {},
                )
    except httpx.HTTPError as exc:
        raise TelegramBotApiError(method) from None

    if response.is_redirect:
        raise TelegramBotApiError(method, status_code=response.status_code)
    try:
        body = response.json()
    except (ValueError, TypeError):
        raise TelegramBotApiError(method, status_code=response.status_code) from None
    if not response.is_success or not isinstance(body, dict) or body.get("ok") is not True:
        parameters = body.get("parameters") if isinstance(body, dict) else None
        retry_after = parameters.get("retry_after") if isinstance(parameters, dict) else None
        error_code = body.get("error_code") if isinstance(body, dict) else None
        raise TelegramBotApiError(
            method,
            status_code=response.status_code,
            error_code=error_code if isinstance(error_code, int) else None,
            retry_after=retry_after if isinstance(retry_after, int) else None,
        )
    return body.get("result")


async def download_file(token: str, file_path: str, *, max_bytes: int) -> bytes:
    """从固定 Telegram 文件主机下载，拒绝路径穿越、重定向和超限响应。"""
    safe_token = validate_bot_token(token)
    path = str(file_path or "")
    if (
        not path
        or len(path) > 512
        or not re.fullmatch(r"[A-Za-z0-9_./-]+", path)
        or any(part in {".", ".."} for part in path.split("/"))
    ):
        raise TelegramBotApiError("getFile")

    client_options = {
        "base_url": _API_BASE,
        "timeout": httpx.Timeout(60.0),
        "follow_redirects": False,
        "trust_env": True,
    }
    try:
        egress = get_settings().safe_egress
        if egress.enabled:
            client_options["proxy"] = build_httpx_proxy(egress)
            client_options["trust_env"] = False
    except Exception:
        raise TelegramBotApiError("getFile") from None

    url_path = f"/file/bot{safe_token}/{quote(path, safe='/')}"
    data = bytearray()
    try:
        async with httpx.AsyncClient(**client_options) as client:
            async with client.stream("GET", url_path) as response:
                if response.is_redirect or not response.is_success:
                    raise TelegramBotApiError("getFile", status_code=response.status_code)
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > max_bytes:
                    raise TelegramBotApiError("getFile", status_code=response.status_code)
                async for chunk in response.aiter_bytes(64 * 1024):
                    if len(data) + len(chunk) > max_bytes:
                        raise TelegramBotApiError("getFile", status_code=response.status_code)
                    data.extend(chunk)
    except TelegramBotApiError:
        raise
    except (httpx.HTTPError, ValueError, TypeError):
        raise TelegramBotApiError("getFile") from None
    return bytes(data)
