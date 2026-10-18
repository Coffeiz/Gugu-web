"""搜索适配器共用的官方端点校验与固定 IP 传输。"""
from __future__ import annotations

from urllib.parse import urlsplit
import asyncio

import httpx

from app.core.pinned_http import PinnedHTTPTransport
from app.core.url_security import resolve_pinned_ip


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
    ip, error = await asyncio.to_thread(resolve_pinned_ip, endpoint)
    if error or not ip:
        return {"error": f"{label}服务地址校验失败"}
    authorization = f"Bearer {api_key}" if auth_header == "Authorization" else api_key
    async with httpx.AsyncClient(
        transport=PinnedHTTPTransport(ip), timeout=httpx.Timeout(connect=10, read=60, write=10, pool=5),
        follow_redirects=False, trust_env=False,
    ) as client:
        response = await client.post(
            endpoint, headers={auth_header: authorization, "Content-Type": "application/json"}, json=payload,
        )
    if response.status_code != 200:
        return {"error": f"{label}返回 HTTP {response.status_code}"}
    try:
        data = response.json()
    except ValueError:
        return {"error": f"{label}返回了无法识别的数据"}
    if not isinstance(data, dict):
        return {"error": f"{label}返回了无法识别的数据"}
    if "error" in data:
        return {"error": f"{label}请求未成功，请检查账户权限或模型支持范围"}
    return data
