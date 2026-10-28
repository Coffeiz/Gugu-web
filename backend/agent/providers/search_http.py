"""搜索适配器共用的官方端点校验与固定 IP 传输。"""
from __future__ import annotations

from urllib.parse import urlsplit
import json

import httpx

from app.core.safe_egress import SafeEgressClient
from .search_limits import MAX_RESPONSE_BYTES, limit_search_result


async def read_search_response(response: httpx.Response, *, label: str) -> dict:
    """流式限制解压后的响应大小，再解析并限制模型可见结果。"""
    if response.status_code != 200:
        return {"error": f"{label}返回 HTTP {response.status_code}"}
    length = response.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_RESPONSE_BYTES:
        return {"error": f"{label}响应超过大小限制，请缩小查询范围或减少正文返回"}
    raw = bytearray()
    async for chunk in response.aiter_bytes():
        if len(raw) + len(chunk) > MAX_RESPONSE_BYTES:
            return {"error": f"{label}响应超过大小限制，请缩小查询范围或减少正文返回"}
        raw.extend(chunk)
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return {"error": f"{label}返回了无法识别的数据"}
    if not isinstance(data, dict):
        return {"error": f"{label}返回了无法识别的数据"}
    if "error" in data:
        return {"error": f"{label}请求未成功，请检查账户权限或模型支持范围"}
    return limit_search_result(data)


def official_host(base_url: str, default_url: str, hosts: frozenset[str]) -> str | None:
    try:
        parsed = urlsplit((base_url or default_url).strip())
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "https" or parsed.hostname not in hosts
        or port not in (None, 443) or parsed.username or parsed.password
        or parsed.query or parsed.fragment
    ):
        return None
    return parsed.hostname


async def post_search(endpoint: str, api_key: str, payload: dict, *, label: str, auth_header: str = "Authorization") -> dict:
    """调用已由 Provider 选定的端点；上游错误正文不进入工具结果。"""
    if not api_key.strip():
        return {"error": f"{label}缺少有效 API Key"}
    authorization = f"Bearer {api_key}" if auth_header == "Authorization" else api_key
    try:
        async with SafeEgressClient().stream(
            endpoint,
            timeout=httpx.Timeout(connect=10, read=60, write=10, pool=5),
            headers={auth_header: authorization, "Content-Type": "application/json"},
            post_json=payload,
        ) as response:
            return await read_search_response(response, label=label)
    except Exception:
        return {"error": f"{label}服务地址校验或连接失败"}
