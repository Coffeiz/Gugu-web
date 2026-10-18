"""智谱 Web Search API：保留官方字段，复用当前 GLM 凭据。"""
from __future__ import annotations

from urllib.parse import urlsplit
import asyncio

import httpx

from app.core.pinned_http import PinnedHTTPTransport
from app.core.url_security import resolve_pinned_ip

_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/web_search"


def supports(model_cfg) -> bool:
    raw = str(getattr(model_cfg, "base_url", "") or _ENDPOINT).strip()
    parsed = urlsplit(raw)
    try:
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme == "https" and parsed.hostname == "open.bigmodel.cn"
        and port in (None, 443) and not parsed.username and not parsed.password
        and not parsed.query and not parsed.fragment
    )


def input_schema(model_cfg=None) -> dict:
    """对应官方 WebSearchRequest；凭据由服务端配置提供。"""
    return {
        "type": "object",
        "properties": {
            "search_query": {"type": "string", "minLength": 1, "maxLength": 70, "description": "需要搜索的内容，最多 70 个字符。"},
            "search_engine": {"type": "string", "enum": ["search_std", "search_pro", "search_pro_sogou", "search_pro_quark"]},
            "search_intent": {"type": "boolean", "default": False, "description": "是否先识别搜索意图；false 直接搜索。"},
            "count": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10, "description": "搜狗仅支持 10/20/30/40/50；夸克不支持此字段。"},
            "search_domain_filter": {"type": "string", "description": "限定白名单域名；夸克不支持。"},
            "search_recency_filter": {"type": "string", "enum": ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"], "default": "noLimit"},
            "content_size": {"type": "string", "enum": ["medium", "high"], "description": "medium 返回摘要；high 返回更详细内容。"},
            "request_id": {"type": "string", "minLength": 6, "maxLength": 64},
            "user_id": {"type": "string", "minLength": 6, "maxLength": 128, "description": "可选终端用户标识，不要填写隐私信息。"},
        },
        "required": ["search_query", "search_engine", "search_intent"],
        "additionalProperties": False,
    }


async def search(model_cfg, args: dict) -> dict:
    if not supports(model_cfg):
        return {"error": "当前 GLM API 地址不支持智谱网络搜索"}
    ip, error = await asyncio.to_thread(resolve_pinned_ip, _ENDPOINT)
    if error or not ip:
        return {"error": "智谱搜索服务地址校验失败"}
    async with httpx.AsyncClient(
        transport=PinnedHTTPTransport(ip), timeout=30.0,
        follow_redirects=False, trust_env=False,
    ) as client:
        response = await client.post(
            _ENDPOINT,
            headers={"Authorization": f"Bearer {model_cfg.api_key}", "Content-Type": "application/json"},
            json=args,
        )
    if response.is_error:
        return {"error": f"智谱网络搜索返回 HTTP {response.status_code}"}
    try:
        data = response.json()
    except ValueError:
        return {"error": "智谱网络搜索返回了无法识别的数据"}
    if not isinstance(data, dict):
        return {"error": "智谱网络搜索返回了无法识别的数据"}
    if "error" in data:
        return {"error": "智谱网络搜索请求未成功，请检查账户权限或稍后重试"}
    return data
