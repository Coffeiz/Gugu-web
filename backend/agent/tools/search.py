"""联网搜索工具集：

- `xng_search`：通用网页、图像或混合搜索，走自建 **SearXNG**（免费、快）。
- `web_search`：使用当前启用的模型 Provider 原生联网搜索；支持 MiniMax、GLM、Qwen 百炼、DeepSeek、MiMo 与 Ollama Cloud。
- `deep_research`：按 Admin 选择的 Provider 查询外部资料。Tavily / You.com 返回研究答案；百度使用普通百度搜索并返回网页引用，适合
  需要"读内容并总结/比较/研究/给引用"的任务。有每日次数配额（SearchUsage）。
- `similar_image_search`：根据已有图片以图搜图，返回相似候选。
  默认只返回候选（标题+来源页+图片直链），**不会自动读取或发送**；需要视觉分析时用 `read_file(items=[...])` 批量读取选中的图片。
  真要把图发进对话/IM，接着调 `files.py` 的 `send_file(url=候选的 img_src)`。

成本梯队（见 `agent/skills/web-search.md`）：专有技能 → 已启用时优先 Provider 原生 web_search，否则 xng_search(SearXNG) → deep_research（Admin 选择的 Provider）。
SearXNG 部署在后端同机（127.0.0.1），由 settings.search.searxng_url 配；国内服务器只有
sogou/quark/360search 可达，固定带 engines 避开会超时的 google/bing 等。图片搜索能用的引擎不一定
是同一批（`settings.search.searxng_image_engines`，留空回退文本引擎列表）。
"""
from datetime import datetime

import base64
from collections import Counter
import io
import json
import logging
import random
from urllib.parse import urlencode

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

_SEARCH_QUERY_DESCRIPTION = (
    "简短检索词；保留实体名、产品名、版本号、日期和关键术语，不要复制完整问题。"
)

SEARCH_TOOL_NAMES = frozenset({"xng_search", "web_search", "deep_research", "similar_image_search"})


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
    if name == "xng_search":
        return bool((settings.search.searxng_url or "").strip())
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


def _parse_requested_engines(raw: str | None) -> list[str]:
    """把后台逗号分隔的引擎配置转成有序、去重列表。"""
    out: list[str] = []
    seen: set[str] = set()
    for part in str(raw or "").split(","):
        name = part.strip()
        key = name.casefold()
        if name and key not in seen:
            seen.add(key)
            out.append(name)
    return out


def _build_searxng_search_url(base: str, params: dict) -> str:
    """用 UTF-8 显式编码查询参数，避免生产环境 ASCII locale 处理中文时抛错。"""
    query = urlencode(params, encoding="utf-8", errors="strict")
    return f"{base}/search?{query}"


def _normalize_failure_reason(raw_reason) -> str:
    text = str(raw_reason or "").strip().lower()
    if not text:
        return "unknown"
    if "captcha" in text or "challenge" in text:
        return "captcha"
    if "too many requests" in text or "rate limit" in text or "ratelimit" in text or "429" in text:
        return "rate_limited"
    if "suspend" in text:
        return "suspended"
    if "timeout" in text or "timed out" in text:
        return "timeout"
    if any(token in text for token in (
        "unavailable", "connection", "network", "forbidden", "access denied",
        "accessdenied", "blocked", "403", "502", "503", "504",
    )):
        return "unavailable"
    return "unknown"


def _normalize_engine_failures(data: dict) -> list[dict[str, str]]:
    """容错读取 SearXNG 的 ``unresponsive_engines``，只保留 engine + 归一化 reason。

    SearXNG 版本/引擎实现可能返回 list/tuple/dict 等不同形态；诊断字段坏掉不能影响
    已拿到的正常 results，所以任何无法识别的项都忽略或归入 unknown，不向上抛。
    """
    if not isinstance(data, dict):
        return []
    raw = data.get("unresponsive_engines")
    if not raw:
        return []

    if isinstance(raw, dict):
        entries = [{"engine": engine, "reason": reason} for engine, reason in raw.items()]
    elif isinstance(raw, (list, tuple)):
        entries = list(raw)
    else:
        return []

    out_by_key: dict[str, dict[str, str]] = {}
    order: list[str] = []
    for item in entries:
        engine = None
        reason_raw = None
        if isinstance(item, dict):
            engine = item.get("engine") or item.get("name")
            reason_raw = item.get("reason") or item.get("error") or item.get("message")
        elif isinstance(item, (list, tuple)) and item:
            engine = item[0]
            reason_raw = " ".join(str(part) for part in item[1:] if part is not None)
        elif isinstance(item, str):
            if ":" in item:
                engine, reason_raw = item.split(":", 1)
            else:
                engine = item

        name = str(engine or "").strip()
        if not name:
            continue
        key = name.casefold()
        normalized = _normalize_failure_reason(reason_raw)
        if key not in out_by_key:
            order.append(key)
            out_by_key[key] = {"engine": name, "reason": normalized}
        elif out_by_key[key]["reason"] == "unknown" and normalized != "unknown":
            out_by_key[key] = {"engine": name, "reason": normalized}

    return [out_by_key[key] for key in order]


def _build_search_status(
    results: list[dict],
    requested_engines: list[str],
    failures: list[dict[str, str]],
) -> dict:
    requested_keys = {name.casefold() for name in requested_engines}
    # SearXNG 可能返回本次请求之外的引擎故障（例如配置只请求 sogou，响应却带了
    # bing 的 timeout）。这些故障不能改变本次请求的状态，也不能被展示成当前搜索引擎失败。
    relevant_failures = [
        item for item in failures
        if not requested_keys or str(item.get("engine", "")).casefold() in requested_keys
    ]
    failed_keys = {
        str(item["engine"]).casefold()
        for item in relevant_failures
        if item.get("engine")
    }
    failed_requested = requested_keys & failed_keys
    all_requested_failed = bool(requested_keys) and requested_keys.issubset(failed_keys)

    if relevant_failures:
        # 有实际结果时即便所有配置引擎都报告过异常，也至少不是“完全没法搜”；保留结果并标 degraded。
        state = "unavailable" if not results and all_requested_failed else "degraded"
    else:
        state = "ok" if results else "empty"

    working_count = (
        max(len(requested_engines) - len(failed_requested), 0)
        if requested_engines else None
    )
    return {
        "state": state,
        "requested_engines": requested_engines,
        "failed_engines": relevant_failures,
        "working_engine_count": working_count,
        "result_count": len(results),
    }


def _search_note(state: str, *, kind: str, has_results: bool) -> str | None:
    noun = "图片" if kind == "image" else "结果"
    if state == "ok":
        return None
    if state == "empty":
        return f"当前可用搜索引擎没有返回{noun}；可以换一组更短/更宽的关键词再搜一次。"
    if state == "unavailable":
        prefix = "当前配置的 SearXNG 图片搜索引擎均不可用" if kind == "image" else "当前配置的 SearXNG 搜索引擎均不可用"
        return f"{prefix}；这不代表没有相关结果。请改用 deep_research 兜底。"
    if has_results:
        return "部分搜索引擎不可用，当前结果覆盖可能不完整；已有结果仍可使用。"
    return "本次没有返回结果，但部分搜索引擎不可用，不能据此判断网上没有相关内容；可换关键词重试一次，或改用 deep_research。"


def _log_search_health(kind: str, query: str, status: dict) -> None:
    """只记搜索健康元数据，不新增 query 原文日志。"""
    try:
        reason_counts = Counter(
            item.get("reason", "unknown") for item in status.get("failed_engines", [])
        )
        _search_log.info(json.dumps({
            "t": "search_health",
            "kind": kind,
            "state": status.get("state"),
            "requested_engine_count": len(status.get("requested_engines") or []),
            "failed_engine_count": len(status.get("failed_engines") or []),
            "failure_reasons": dict(reason_counts),
            "result_count": status.get("result_count", 0),
            "query_len": len(query),
        }, ensure_ascii=False))
    except Exception:
        pass


def _build_search_response(
    query: str,
    results: list[dict],
    engines_config: str | None,
    data: dict,
    *,
    kind: str,
) -> dict:
    requested = _parse_requested_engines(engines_config)
    failures = _normalize_engine_failures(data)
    status = _build_search_status(results, requested, failures)
    payload = {"query": query, "results": results, "search_status": status}
    note = _search_note(status["state"], kind=kind, has_results=bool(results))
    if note:
        payload["note"] = note
    _log_search_health(kind, query, status)
    return payload


# ── xng_search：SearXNG 网页/图像搜索────────────────────────────────────────
async def _xng_search(db, user_id, args: dict):
    settings = get_settings()
    base = (settings.search.searxng_url or "").rstrip("/")
    if not base:
        return {"error": "管理员尚未配置 XNG Search"}
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "需要提供搜索关键词 query"}

    mode = str(args.get("mode") or "web").strip().lower()
    if mode not in {"web", "images", "both"}:
        return {"error": "mode 必须是 web、images 或 both"}
    max_results = args.get("max_results") or settings.search.max_results
    web_engines = settings.search.searxng_engines
    image_engines = settings.search.searxng_image_engines or web_engines
    if mode == "web":
        engines = web_engines
        categories = "general"
    elif mode == "images":
        engines = image_engines
        categories = "images"
    else:
        engines = ",".join(_parse_requested_engines(f"{web_engines},{image_engines}"))
        categories = "general,images"
    params = {"q": query, "format": "json", "categories": categories, "engines": engines}
    request_url = _build_searxng_search_url(base, params)
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=20.0, write=5.0, pool=5.0)
        ) as client:
            resp = await client.get(request_url)
    except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError):
        if mode == "web" and await search_tool_is_configured("deep_research", db=db, user_id=user_id, settings=settings):
            return await _deep_research(db, user_id, {"query": query, "max_results": max_results})
        return {"error": "XNG Search 暂时不可用，请稍后重试"}
    except Exception as e:
        return {"error": f"XNG Search 暂时失败（{type(e).__name__}）"}
    if resp.status_code == 403:
        return {"error": "XNG Search 返回 403：实例未启用 JSON 输出格式"}
    if resp.status_code != 200:
        return {"error": f"XNG Search 失败（HTTP {resp.status_code}）"}
    try:
        data = resp.json()
    except Exception:
        return {"error": "XNG Search 返回了无法解析的响应"}

    raw_results = data.get("results") or []
    web_results = [
        {"title": item.get("title"), "url": item.get("url"), "content": (item.get("content") or "")[:300]}
        for item in raw_results if isinstance(item, dict) and not item.get("img_src")
    ][:max_results]
    image_results = [
        {
            "result_id": f"image-{index}",
            "title": item.get("title"),
            "url": item.get("url"),
            "img_src": item.get("img_src"),
            "thumbnail": item.get("thumbnail_src") or item.get("thumbnail"),
        }
        for index, item in enumerate(raw_results, start=1)
        if isinstance(item, dict) and item.get("img_src")
    ][:max_results]

    if mode == "both":
        web_payload = _build_search_response(query, web_results, web_engines, data, kind="web")
        image_payload = _build_search_response(query, image_results, image_engines, data, kind="image")
        return {
            "query": query,
            "mode": mode,
            "web_results": web_payload["results"],
            "image_results": image_payload["results"],
            "search_status": {
                "web": web_payload["search_status"],
                "images": image_payload["search_status"],
            },
            **({"notes": [note for note in (web_payload.get("note"), image_payload.get("note")) if note]}),
        }
    if mode == "web":
        return _build_search_response(query, web_results, engines, data, kind="web")
    return _build_search_response(query, image_results, engines, data, kind="image")


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
            return json.dumps({"error": f"今天的深度研究次数已用完（上限 {limit} 次/天）；普通查找可用 xng_search"})

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
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=timeout_seconds, write=10.0, pool=5.0),
            follow_redirects=False,
        ) as client:
            response = await client.post(
                "https://qianfan.baidubce.com/v2/tools/image_similar_info",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
    except httpx.TimeoutException:
        return {"error": "相似图搜索请求超时，请稍后重试", "error_code": "upstream_timeout"}
    except httpx.HTTPError:
        return {"error": "相似图搜索网络连接失败，请稍后重试", "error_code": "upstream_error"}

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
    name = "xng_search"
    tools = [
        Tool(
            name="web_search", label="联网搜索",
            description_short="由当前模型 Provider 提供的联网搜索，调用可能收费。",
            description="联网搜索工具由当前模型 Provider 提供，使用当前模型配置的 API Key，调用可能产生搜索服务和模型费用，按 Provider 规则计费。参数遵循该 Provider 的原生 Schema。适合查找近期网页信息和事实核查。",
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            input_schema_factory=_provider_web_search_schema,
            handler=_web_search,
            start_message=lambda args: random.choice(["我用当前模型的联网搜索查一下。", "我查一下最新网页资料。"]),
            parallel_safe=True,
        ),
        Tool(
            name="xng_search", label="XNG 搜索",
            description_short='搜索网页、图像或同时搜索两类内容。',
            description="使用 XNG 搜索公网网页或图像。mode=web 搜网页，mode=images 搜图像，mode=both 同时搜索两类；返回图像候选，不会自动读取或发送。需要读正文或深度研究时分别使用 http_get 或 deep_research。",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": _SEARCH_QUERY_DESCRIPTION},
                    "mode": {"type": "string", "enum": ["web", "images", "both"], "default": "web"},
                    "max_results": {
                        "type": "integer", "minimum": 1, "maximum": 20,
                    },
                },
                "required": ["query"],
            },
            handler=_xng_search,
            start_message=lambda args: random.choice(["我去查一下。", "我搜一下最新的资料。", "我确认一下这个。"]),
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
            start_message=lambda args: random.choice(["我找找相似图片。", "我用这张图找找相似图片。"]),
        ),
        Tool(
            name="deep_research", label="深度研究",
            description_short='对指定主题进行深度研究。',
            description="阅读和研究外部资料，返回总结或引用；普通网页或图像搜索用 xng_search。",
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
            start_message=lambda args: random.choice(["我深入研究一下这个。", "我仔细看看，等会儿告诉你。"]),
        ),
    ]


SearchSkill().register()
