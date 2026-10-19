"""DeepSeek Search API 原生字段与当前 Provider 凭据。"""
from ..search_http import official_host, post_search

_ENDPOINT = "https://api.deepseek.com/v1/tools/search"


def supports(model_cfg) -> bool:
    return official_host(
        str(getattr(model_cfg, "base_url", "") or ""), _ENDPOINT, frozenset({"api.deepseek.com"}),
    ) is not None


def input_schema(model_cfg=None) -> dict:
    return {
        "type": "object",
        "properties": {
            "query": {"type": "string", "minLength": 1, "maxLength": 128, "pattern": "\\S", "description": "搜索词，支持 site:、lang:、after:、before: 等搜索语法。"},
            "count": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
            "ori_question": {"type": ["string", "null"], "minLength": 1, "maxLength": 128, "description": "可选原始问题，用于理解搜索意图。"},
            "localization": {"type": "string", "description": "用于优先返回本地化搜索结果的 IP 地址，默认空字符串。"},
            "need_content": {"type": "boolean", "default": False, "description": "是否返回网页正文。"},
        },
        "required": ["query"], "additionalProperties": False,
    }


async def search(model_cfg, args: dict) -> dict:
    if not supports(model_cfg):
        return {"error": "当前 DeepSeek API 地址不支持官方联网搜索"}
    return await post_search(_ENDPOINT, model_cfg.api_key, args, label="DeepSeek 联网搜索")
