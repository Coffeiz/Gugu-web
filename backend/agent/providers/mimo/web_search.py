"""MiMo Chat Completions 联网插件，参数保持官方原生结构。"""
from ..search_http import official_host, post_search

_ENDPOINT = "https://api.xiaomimimo.com/v1/chat/completions"
SUPPORTED_MODELS = frozenset({"mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.5-pro", "mimo-v2.5"})


def supports(model_cfg) -> bool:
    return (
        str(getattr(model_cfg, "model", "") or "").strip().lower() in SUPPORTED_MODELS
        and official_host(str(getattr(model_cfg, "base_url", "") or ""), _ENDPOINT, frozenset({"api.xiaomimimo.com"})) is not None
    )


def input_schema(model_cfg=None) -> dict:
    return {
        "type": "object",
        "properties": {
            "messages": {
                "type": "array", "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {"role": {"type": "string", "enum": ["system", "user", "assistant"]}, "content": {"type": "string"}},
                    "required": ["role", "content"], "additionalProperties": False,
                },
            },
            "tools": {
                "type": "array", "minItems": 1, "maxItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["web_search"]},
                        "max_keyword": {"type": "integer", "minimum": 1, "description": "每轮最大搜索关键词数量，影响调用次数和费用。"},
                        "force_search": {"type": "boolean", "description": "是否强制联网搜索。"},
                        "limit": {"type": "integer", "minimum": 1},
                        "user_location": {
                            "type": "object",
                            "properties": {"type": {"type": "string", "enum": ["approximate"]}, "country": {"type": "string"}, "region": {"type": "string"}, "city": {"type": "string"}},
                            "required": ["type"], "additionalProperties": False,
                        },
                    },
                    "required": ["type"], "additionalProperties": False,
                },
            },
            "max_completion_tokens": {"type": "integer", "minimum": 1, "maximum": 2048, "default": 1024},
        },
        "required": ["messages", "tools"], "additionalProperties": False,
    }


async def search(model_cfg, args: dict) -> dict:
    if not supports(model_cfg):
        return {"error": "当前 MiMo 模型或 API 地址不支持官方联网搜索"}
    return await post_search(
        _ENDPOINT, model_cfg.api_key,
        {**args, "max_completion_tokens": min(args.get("max_completion_tokens", 1024), 2048), "model": model_cfg.model, "stream": False, "thinking": {"type": "disabled"}},
        label="MiMo 联网搜索", auth_header="api-key",
    )
