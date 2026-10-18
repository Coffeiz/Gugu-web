"""阿里云百炼 Qwen 原生联网搜索适配器。"""
from __future__ import annotations

import asyncio
from urllib.parse import urlsplit

import httpx

from app.core.pinned_http import PinnedHTTPTransport
from app.core.url_security import resolve_pinned_ip

_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
_ALLOWED_HOSTS = {"dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"}
_SUPPORTED_FORMATS = {"openai", "responses"}


def _target(model_cfg) -> tuple[str, str] | None:
    api_format = str(getattr(model_cfg, "api_format", "") or "openai").strip().lower()
    if api_format not in _SUPPORTED_FORMATS:
        return None

    raw = str(getattr(model_cfg, "base_url", "") or _DEFAULT_BASE_URL).strip().rstrip("/")
    parsed = urlsplit(raw)
    host = (parsed.hostname or "").lower()
    allowed_host = host in _ALLOWED_HOSTS or host.endswith(".maas.aliyuncs.com")
    if (
        parsed.scheme != "https"
        or not allowed_host
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if port not in (None, 443) or not parsed.path.rstrip("/").endswith("/compatible-mode/v1"):
        return None

    path = "/responses" if api_format == "responses" else "/chat/completions"
    return f"https://{host}{parsed.path.rstrip('/')}{path}", api_format


def supports(model_cfg) -> bool:
    return _target(model_cfg) is not None


def input_schema(model_cfg) -> dict:
    """保留百炼协议字段；模型、凭据和启用搜索参数由服务端提供。"""
    if str(getattr(model_cfg, "api_format", "") or "openai").strip().lower() == "responses":
        return {
            "type": "object",
            "properties": {
                "input": {"type": "string", "minLength": 1, "description": "需要联网检索的问题。"},
                "max_output_tokens": {"type": "integer", "minimum": 1, "description": "限制本次搜索回答的输出 token 数。"},
            },
            "required": ["input"], "additionalProperties": False,
        }
    return {
        "type": "object",
        "properties": {
            "messages": {
                "type": "array", "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "role": {"type": "string", "enum": ["system", "user", "assistant"]},
                        "content": {"type": "string"},
                    },
                    "required": ["role", "content"], "additionalProperties": False,
                },
                "description": "百炼搜索请求的文本消息，包含要检索的问题。",
            },
            "search_options": {
                "type": "object",
                "properties": {
                    "forced_search": {"type": "boolean", "default": True},
                    "search_strategy": {"type": "string", "description": "百炼检索策略，需符合所选模型支持范围。"},
                },
                "additionalProperties": False,
            },
        },
        "required": ["messages"], "additionalProperties": False,
    }


async def search(model_cfg, args: dict) -> dict:
    """以当前 Qwen 凭据调用百炼原生联网搜索。"""
    target = _target(model_cfg)
    if not target:
        return {"error": "当前 Qwen API 格式或地址不支持联网搜索"}
    endpoint, api_format = target
    api_key = str(getattr(model_cfg, "api_key", "") or "").strip()
    model = str(getattr(model_cfg, "model", "") or "").strip()
    if not api_key or not model:
        return {"error": "当前 Qwen 配置缺少 API Key 或模型名称"}

    ip, error = await asyncio.to_thread(resolve_pinned_ip, endpoint)
    if error or not ip:
        return {"error": "百炼搜索服务地址校验失败"}
    if api_format == "responses":
        payload = {
            **args, "model": model, "tools": [{"type": "web_search"}], "store": False,
        }
    else:
        payload = {
            **args, "model": model, "enable_search": True, "include_tool_usage": True,
            "search_options": {"forced_search": True, **args.get("search_options", {})},
        }

    transport = PinnedHTTPTransport(ip)
    async with httpx.AsyncClient(
        transport=transport,
        timeout=httpx.Timeout(connect=10, read=60, write=10, pool=5),
        follow_redirects=False,
        trust_env=False,
    ) as client:
        response = await client.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
        )
    if response.is_error:
        return {"error": f"百炼联网搜索返回 HTTP {response.status_code}"}
    try:
        data = response.json()
    except ValueError:
        return {"error": "百炼联网搜索返回了无法识别的数据"}
    if not isinstance(data, dict):
        return {"error": "百炼联网搜索返回了无法识别的数据"}

    if "error" in data:
        return {"error": "百炼联网搜索请求未成功，请检查模型支持范围或账户权限"}
    return data
