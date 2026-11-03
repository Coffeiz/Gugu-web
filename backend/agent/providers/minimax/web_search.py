"""MiniMax Coding Plan MCP Web Search 的 provider 适配器。

官方 MCP 的 ``web_search(query)`` 工具最终调用同一官方 HTTP API；在进程内
适配可避免运行外置 MCP 子进程，同时沿用当前已选 MiniMax 凭据。
"""
from __future__ import annotations

import asyncio
import re
from urllib.parse import urlsplit

from app.core.redaction import diag_log_raw
from app.core.safe_egress import SafeEgressClient, SafeEgressError
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
    for attempt in range(3):
        try:
            async with SafeEgressClient().stream(
                endpoint,
                timeout=30.0,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                post_json={"q": args["query"]},
            ) as response:
                request_id = response.headers.get("x-request-id", "")
                data = await read_search_response(response, label="MiniMax 搜索服务")
        except SafeEgressError:
            return {"error": "MiniMax 搜索服务地址校验或连接失败"}
        if "error" in data:
            return data

        base_resp = data.get("base_resp")
        code = str(base_resp.get("status_code", "0")) if isinstance(base_resp, dict) else "0"
        if code in {"0", "None", ""}:
            return data
        safe_code = code if re.fullmatch(r"[0-9]{1,10}", code) else "unknown"
        safe_id = request_id if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id) else "unavailable"
        diag_log_raw("minimax.web_search", f"status_code={safe_code} request_id={safe_id} attempt={attempt + 1}")
        if code == "1033" and attempt < 2:
            await asyncio.sleep(5.0)
            continue
        if code == "1033":
            return {"error": "MiniMax 搜索服务暂时出现内部错误，重试后仍未成功，请稍后再试"}
        if code in {"1004", "2049"}:
            return {"error": "MiniMax 搜索未获授权，请检查 API Key 和账户权限"}
        if code in {"1008", "2056"}:
            return {"error": "MiniMax 账户余额或可用额度不足，请检查账户状态"}
        return {"error": f"MiniMax 搜索请求未成功（错误码 {safe_code}），请检查账户状态或稍后重试"}
