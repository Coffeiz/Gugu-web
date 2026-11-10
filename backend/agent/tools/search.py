"""联网搜索工具集：

- `web_search`：使用当前启用的模型 Provider 原生联网搜索；支持 MiniMax、GLM、Qwen 百炼、DeepSeek、MiMo 与 Ollama Cloud。
- `deep_research`：按 Admin 选择的 Provider 查询外部资料。Tavily / You.com 返回研究答案；百度使用普通百度搜索并返回网页引用，适合
  需要"读内容并总结/比较/研究/给引用"的任务。有每日次数配额（SearchUsage）。
- `similar_image_search`：根据已有图片以图搜图，返回相似候选。
  默认只返回候选（标题+来源页+图片直链），**不会自动读取或发送**；需要视觉分析时用 `read_file(items=[...])` 批量读取选中的图片。
  真要把图发进对话/IM，接着调 `files.py` 的 `send_file(url=候选的 img_src)`。

搜索策略见 `agent/skills/web-search.md`。网页搜索由当前模型 Provider 提供；深度研究使用 Admin 配置的独立 Provider。
"""
from datetime import datetime

import base64
import io
import json
import logging
import random

from app.core.tz import local_day_start_utc
from app.core.credentials import normalize_ascii_api_key

import httpx
from app.core.config import get_settings
from app.core import chat_attach
from app.byok.service import decrypt_value, get_active_credential
from app.services.search import (
    count_daily_search_usage,
    count_similar_image_usage,
    get_user_daily_search_limit,
    record_search_usage,
    record_similar_image_usage,
)
from agent.providers.web_search import input_schema as _provider_web_search_schema
from agent.tools.base import BaseSkill, Tool

_search_log = logging.getLogger("agent.search")

SEARCH_TOOL_NAMES = frozenset({"web_search", "deep_research", "similar_image_search"})


async def _deep_research_config(db, user_id, settings):
    """按执行时相同的优先级解析深度研究凭据。"""
    user_credential = (
        await get_active_credential(db, user_id, "deep_research")
        if db is not None and user_id is not None else None
    )
    provider = user_credential.provider if user_credential else settings.search.deep_research_provider
    keys = {
        "tavily": settings.search.tavily_api_key,
        "baidu": settings.search.deep_research_baidu_api_key,
        "you": settings.search.deep_research_you_api_key,
    }
    key = decrypt_value(user_credential) if user_credential else keys.get(provider, "")
    return provider, key


async def search_tool_is_configured(name: str, *, db=None, user_id=None, settings=None, model_cfg=None) -> bool:
    """只按当前用户可实际使用的配置判断搜索工具是否应暴露。"""
    settings = settings or get_settings()
    if name == "deep_research":
        _, key = await _deep_research_config(db, user_id, settings)
        return bool(key)
    if name == "web_search":
        from agent.llm import modelctx
        cfg = model_cfg or modelctx.get_model_cfg()
        from agent.providers.web_search import supports_web_search
        return bool(
            cfg
            and supports_web_search(cfg)
            and bool(getattr(cfg, "web_search_enabled", False))
            and str(getattr(cfg, "api_key", "") or "").strip()
        )
    if name == "similar_image_search":
        if settings.search.similar_image_provider != "baidu_qianfan":
            return False
        user_credential = (
            await get_active_credential(db, user_id, "similar_image_search")
            if db is not None and user_id is not None else None
        )
        if user_credential is not None:
            return bool(decrypt_value(user_credential))
        return bool(settings.search.baidu_qianfan_api_key)
    return True


async def filter_configured_search_tools(tool_names, *, db=None, user_id=None, settings=None, model_cfg=None):
    """从本轮可见工具中移除没有有效配置的搜索能力。"""
    settings = settings or get_settings()
    configured = []
    for name in tool_names:
        if name not in SEARCH_TOOL_NAMES or await search_tool_is_configured(
            name, db=db, user_id=user_id, settings=settings, model_cfg=model_cfg,
        ):
            configured.append(name)
    return configured


# ── deep_research：可配置 Provider（深度、有配额）────────────────────────────
async def _deep_research(db, user_id, args: dict):
    settings = get_settings()
    provider, key = await _deep_research_config(db, user_id, settings)
    if not key:
        return json.dumps({"error": f"尚未配置深度研究（{provider} API Key）"})

    query = (args.get("query") or "").strip()
    if not query:
        return json.dumps({"error": "需要提供搜索关键词 query"})

    # ── 每日次数配额（None=不限制；优先用户个人配置，否则回落全局）──
    limit = await get_user_daily_search_limit(db, user_id)
    if limit is None:
        limit = settings.quota.default_search_limit_daily
    if limit is not None:
        day_start = local_day_start_utc()
        used = await count_daily_search_usage(db, user_id, day_start)
        if used >= limit:
            return json.dumps({"error": f"今天的深度研究次数已用完（上限 {limit} 次/天）；普通查找可用 web_search"})

    max_results = args.get("max_results") or settings.search.max_results
    try:
        from agent.tools.deep_research import run
        data = await run(
            provider, query, key,
            max_results=max_results,
            depth=args.get("depth", "basic"),
        )
    except Exception as e:
        return json.dumps({"error": f"深度研究失败：{str(e)[:100]}"})

    # 记一次用量（成功才记，计入每日配额）
    await record_search_usage(db, user_id, query)

    return data


async def _resolve_similar_image(user_id, args: dict) -> tuple[bytes | None, str | None]:
    """把暂存附件或网络图片解析为百度接口需要的图片字节。"""
    attach_id = str(args.get("attach_id") or "").strip()
    image_url = str(args.get("image_url") or "").strip()
    if attach_id:
        meta = await chat_attach.get_meta(user_id, attach_id)
        if not meta:
            return None, "找不到这个图片附件，可能已过期"
        if meta.get("kind") != "image":
            return None, "指定附件不是图片"
        ext = str(meta.get("ext") or "").lower()
        if ext not in {"jpg", "jpeg", "png"}:
            return None, "相似图搜索只支持 JPG 和 PNG 图片"
        raw = await chat_attach.read_bytes(meta)
    elif image_url:
        from agent.tools.files import _send_file_from_url
        result = await _send_file_from_url(None, image_url, "", stage=False)
        if not isinstance(result, dict) or not result.get("data"):
            return None, "网络图片下载失败，无法进行相似图搜索"
        if result.get("ext") not in {"jpg", "jpeg", "png"}:
            return None, "网络图片不是支持的 JPG 或 PNG 格式"
        raw = result["data"]
    else:
        return None, "需要提供当前图片、附件 ID 或网络图片地址"

    if len(raw) > 4 * 1024 * 1024:
        return None, "图片超过百度接口的 4MB 限制"
    try:
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in {"JPEG", "PNG"}:
                return None, "图片实际格式不是 JPG 或 PNG"
            image.verify()
    except Exception:
        return None, "图片内容无法解析"
    return raw, None


async def _call_baidu_similar_image(raw: bytes, api_key: str, count: int, timeout_seconds: int) -> dict:
    try:
        api_key = normalize_ascii_api_key(api_key, label="百度相似图搜索 API Key")
    except ValueError:
        return {"error": "百度相似图搜索 API Key 格式无效，请使用服务提供的 ASCII API Key", "error_code": "invalid_api_key"}
    if not api_key:
        return {"error": "百度相似图搜索 API Key 未配置，请管理员检查服务配置", "error_code": "invalid_api_key"}
    payload = {"image": base64.b64encode(raw).decode("ascii"), "count": count}
    try:
        from app.core.safe_egress import SafeEgressClient, SafeEgressError
        async with SafeEgressClient().stream(
            "https://qianfan.baidubce.com/v2/tools/image_similar_info",
            timeout=httpx.Timeout(connect=5.0, read=timeout_seconds, write=10.0, pool=5.0),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            post_json=payload,
        ) as response:
            await response.aread()
    except httpx.TimeoutException:
        return {"error": "相似图搜索请求超时，请稍后重试", "error_code": "upstream_timeout"}
    except httpx.HTTPError:
        return {"error": "相似图搜索网络连接失败，请稍后重试", "error_code": "upstream_error"}
    except SafeEgressError:
        return {"error": "相似图搜索服务地址校验失败，请管理员检查网络配置", "error_code": "upstream_error"}

    if response.status_code in (401, 403):
        return {"error": "百度相似图搜索鉴权失败，请管理员检查 API Key", "error_code": "upstream_auth"}
    if response.status_code == 429:
        return {"error": "百度相似图搜索调用频率或额度已用尽，请稍后重试", "error_code": "upstream_rate_limited"}
    if response.status_code >= 500:
        return {"error": "百度相似图搜索暂时不可用，请稍后重试", "error_code": "upstream_error"}
    if response.status_code != 200:
        return {"error": "百度相似图搜索请求失败，请管理员检查服务配置", "error_code": "upstream_error"}
    try:
        data = response.json()
    except ValueError:
        return {"error": "百度相似图搜索返回了无法解析的数据", "error_code": "upstream_error"}

    # 百度成功响应当前包在 result 下；兼容早期/代理层直接返回 res_data 的结构。
    result_data = data.get("result") if isinstance(data.get("result"), dict) else data
    raw_items = ((result_data.get("res_data") or {}).get("res_items") or [])
    if isinstance(raw_items, dict):
        raw_items = list(raw_items.values())
    if not isinstance(raw_items, list):
        raw_items = []
    results = []
    for item in raw_items[:count]:
        if not isinstance(item, dict):
            continue
        results.append({
            "title": item.get("title"),
            "site_name": item.get("site_name"),
            "source_url": item.get("fromurl") or item.get("result_page"),
            "image_url": item.get("objurl"),
            "detail_url": item.get("detail_page") or item.get("result_page"),
            "similarity": item.get("sim_level"),
            "width": item.get("width"),
            "height": item.get("height"),
        })
    return {
        "results": results,
        "request_id": data.get("requestId") or result_data.get("requestId"),
        "count": len(results),
    }


async def _similar_image_search(db, user_id, args: dict):
    settings = get_settings()
    cfg = settings.search
    user_credential = await get_active_credential(db, user_id, "similar_image_search")
    image_key = decrypt_value(user_credential) if user_credential else cfg.baidu_qianfan_api_key
    if cfg.similar_image_provider != "baidu_qianfan" or not image_key:
        return {"error": "相似图搜索尚未配置或未启用，请管理员先在 Admin 配置百度千帆 API Key"}

    count = args.get("max_results") or cfg.similar_image_default_count
    try:
        count = max(1, min(20, int(count)))
    except (TypeError, ValueError):
        return {"error": "max_results 必须是 1 到 20 之间的整数"}

    day_start = local_day_start_utc()
    limit = cfg.similar_image_limit_daily
    user_limit = await get_user_daily_search_limit(db, user_id)
    if user_limit is not None:
        limit = user_limit if limit is None else min(limit, user_limit)
    if limit is not None and await count_similar_image_usage(db, user_id, day_start) >= limit:
        return {"error": f"今天的相似图搜索次数已用完（上限 {limit} 次/天）"}

    raw, error = await _resolve_similar_image(user_id, args)
    if error:
        return {"error": error}
    result = await _call_baidu_similar_image(
        raw, image_key, count, cfg.similar_image_timeout_seconds,
    )
    if "error" not in result:
        await record_similar_image_usage(db, user_id)
        if not result.get("results"):
            result["note"] = "没有找到相似结果"
    return result


async def _web_search(db, user_id, args: dict):
    """使用本轮 Provider 凭据调用其原生联网搜索 API。"""
    from agent.llm import modelctx
    from agent.providers.web_search import search

    cfg = modelctx.get_model_cfg()
    if not await search_tool_is_configured("web_search", db=db, user_id=user_id, model_cfg=cfg):
        return {"error": "当前模型未启用联网搜索，或缺少有效凭据"}
    try:
        return await search(cfg, args)
    except Exception as exc:
        _search_log.warning("Provider 联网搜索失败: %s", type(exc).__name__)
        return {"error": "联网搜索暂时不可用，请稍后重试"}


class SearchSkill(BaseSkill):
    name = "search"
    tools = [
        Tool(
            name="web_search", label="联网搜索",
            description_short="适合大部分信息检索的 Provider 联网搜索，调用可能收费。",
            description="联网搜索工具由当前模型 Provider 提供，使用当前模型配置的 API Key，调用可能产生搜索服务和模型费用，按 Provider 规则计费。参数遵循该 Provider 的原生 Schema，适合信息检索、近期动态和事实核验。",
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            input_schema_factory=_provider_web_search_schema,
            handler=_web_search,
            proxy_selectable=True,
            start_message=lambda args: random.choice(["我用当前模型的联网搜索查一下。", "我查一下最新网页资料。"]),
            parallel_safe=True,
        ),
        Tool(
            name="similar_image_search", label="以图搜图",
            description_short='根据已有图片寻找相似图像。',
            description="以图搜图，只返回相似候选；使用已有图片附件或图片 URL，不用于按关键词搜索图片。",
            input_schema={
                "type": "object",
                "properties": {
                    "attach_id": {"type": "string"},
                    "image_url": {"type": "string"},
                    "max_results": {
                        "type": "integer", "minimum": 1, "maximum": 20,
                    },
                },
                "anyOf": [{"required": ["attach_id"]}, {"required": ["image_url"]}],
            },
            handler=_similar_image_search,
            proxy_selectable=True,
            start_message=lambda args: random.choice(["我找找相似图片。", "我用这张图找找相似图片。"]),
        ),
        Tool(
            name="deep_research", label="深度研究",
            description_short='对指定主题进行深度研究。',
            description="阅读和研究外部资料，返回总结或引用；复杂任务应结合网页搜索与原文阅读，使用本工具聚合分析，再对关键结论和分歧补充独立来源核验。",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "max_results": {
                        "type": "integer", "minimum": 1, "maximum": 20,
                    },
                    "depth": {"type": "string", "enum": ["basic", "advanced"]},
                },
                "required": ["query"],
            },
            handler=_deep_research,
            proxy_selectable=True,
            start_message=lambda args: random.choice(["我深入研究一下这个。", "我仔细看看，等会儿告诉你。"]),
        ),
    ]


SearchSkill().register()
