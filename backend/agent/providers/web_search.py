"""Provider 原生联网搜索：只调度，Schema 和请求由各 Provider 声明。"""
from __future__ import annotations


def _adapter(model_cfg):
    provider = str(getattr(model_cfg, "provider", "") or "").strip().lower()
    if provider == "minimax":
        from .minimax import web_search
    elif provider == "qwen":
        from .qwen import web_search
    elif provider == "glm":
        from .glm import web_search
    elif provider == "deepseek":
        from .deepseek import web_search
    elif provider == "mimo":
        from .mimo import web_search
    elif provider == "ollama":
        from .ollama import web_search
    else:
        return None
    return web_search


def supports_web_search(model_cfg) -> bool:
    adapter = _adapter(model_cfg)
    return adapter is not None and adapter.supports(model_cfg)


def input_schema(model_cfg) -> dict:
    adapter = _adapter(model_cfg)
    if adapter is None:
        return {"type": "object", "properties": {}, "additionalProperties": False}
    return adapter.input_schema(model_cfg)


async def search(model_cfg, args: dict) -> dict:
    """原样分派当前 Provider 的参数，不转换成统一 query/max_results。"""
    adapter = _adapter(model_cfg)
    if adapter is None:
        return {"error": "当前模型提供方尚未实现联网搜索"}
    return await adapter.search(model_cfg, args)
