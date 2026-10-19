"""Ollama 官方云端搜索；不把本地服务凭据发送到云端。"""
from ..search_http import official_host, post_search

_ENDPOINT = "https://ollama.com/api/web_search"


def supports(model_cfg) -> bool:
    base = str(getattr(model_cfg, "base_url", "") or "")
    if not base and getattr(model_cfg, "ollama_mode", "local") != "cloud":
        return False
    return official_host(base, _ENDPOINT, frozenset({"ollama.com"})) is not None


def input_schema(model_cfg=None) -> dict:
    return {
        "type": "object",
        "properties": {
            "query": {"type": "string", "minLength": 1, "description": "搜索查询。"},
            "max_results": {"type": "integer", "minimum": 1, "maximum": 10, "default": 5},
        },
        "required": ["query"], "additionalProperties": False,
    }


async def search(model_cfg, args: dict) -> dict:
    if not supports(model_cfg):
        return {"error": "Ollama 联网搜索需要官方 Cloud API Key，不能使用本地服务凭据"}
    return await post_search(_ENDPOINT, model_cfg.api_key, args, label="Ollama 联网搜索")
