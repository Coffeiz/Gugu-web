"""MiniMax Coding Plan MCP Web Search 的 provider 适配器。

官方 MCP 的 ``web_search(query)`` 工具最终调用同一官方 HTTP API；在进程内
适配可避免运行外置 MCP 子进程，同时沿用当前已选 MiniMax 凭据。
"""
from __future__ import annotations

import asyncio
from urllib.parse import urlsplit

import httpx

from app.core.pinned_http import PinnedHTTPTransport
from app.core.url_security import resolve_pinned_ip
from ..search_http import read_search_response

_ALLOWED_HOSTS = {"api.minimax.cn", "api.minimaxi.com", "api.minimax.io"}
_SEARCH_PATH = "/v1/coding_plan/search"


def _endpoint(model_cfg) -> str | None:
    raw = str(getattr(model_cfg, "base_url", "") or "").strip()
    if not raw:
        raw = "https://api.minimaxi.com/v1"
    parsed = urlsplit(raw)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host not in _ALLOWED_HOSTS or parsed.username or parsed.password:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if port not in (None, 443):
        return None
    return f"https://{host}{_SEARCH_PATH}"


def supports(model_cfg) -> bool:
    return _endpoint(model_cfg) is not None


def input_schema(model_cfg=None) -> dict:
    """官方 MiniMax MCP web_search 的业务输入只有 query。"""
    return {
        "type": "object",
        "properties": {"query": {"type": "string", "minLength": 1, "description": "搜索查询。"}},
        "required": ["query"],
        "additionalProperties": False,
    }


async def search(model_cfg, args: dict) -> dict:
    """调用 MiniMax 搜索端点并规范化官方 MCP 返回结构。"""
    endpoint = _endpoint(model_cfg)
    if not endpoint:
        return {"error": "当前 MiniMax API 地址不支持联网搜索"}
    api_key = str(getattr(model_cfg, "api_key", "") or "").strip()
    ip, error = await asyncio.to_thread(resolve_pinned_ip, endpoint)
    if error or not ip:
        return {"error": "MiniMax 搜索服务地址校验失败"}
    transport = PinnedHTTPTransport(ip)
    async with httpx.AsyncClient(
        transport=transport, timeout=30.0, follow_redirects=False,
        trust_env=False,
    ) as client:
        async with client.stream(
            "POST",
            endpoint,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"q": args["query"]},
        ) as response:
            data = await read_search_response(response, label="MiniMax 搜索服务")
    if "error" in data:
        return data

    base_resp = data.get("base_resp")
    if isinstance(base_resp, dict) and str(base_resp.get("status_code", "0")) not in {"0", "None", ""}:
        return {"error": "MiniMax 搜索请求未成功，请检查账户权限或稍后重试"}
    return data
