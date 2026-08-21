"""联网搜索工具集：

- `web_search`：通用网页搜索，走自建 **SearXNG**（免费、快）。返回标题+链接+摘要，
  适合找官网/文档/GitHub/某个事实/新闻标题/下载地址等"普通查找"。无配额。
- `deep_research`：深度研究，走 **Tavily**（抓取并清洗网页正文 + 给 answer），适合
  需要"读内容并总结/比较/研究/给引用"的任务。有每日次数配额（SearchUsage）。
- `image_search`：图片搜索，同样走 SearXNG（`categories=images`），免配额。默认只返回候选
  （标题+来源页+图片直链 img_src+缩略图），**不会自动读取或发送**；需要视觉分析时单独调用 `inspect_images`。真要把图发进对话/IM，
  接着调 `files.py` 的 `send_file(url=候选的 img_src)`。

成本梯队（见 `agent/skills/web-search.md`）：专有技能 → web_search(SearXNG) → deep_research(Tavily)。
SearXNG 部署在后端同机（127.0.0.1），由 settings.search.searxng_url 配；国内服务器只有
sogou/quark/360search 可达，固定带 engines 避开会超时的 google/bing 等。图片搜索能用的引擎不一定
是同一批（`settings.search.searxng_image_engines`，留空回退文本引擎列表）。
"""
from datetime import datetime

import asyncio
import base64
from collections import Counter
from contextvars import ContextVar
import io
import json
import logging
import random

from app.core.tz import local_day_start_utc

import httpx
from app.core.config import get_settings
from app.core import chat_attach
from app.services.search import (
    count_daily_search_usage,
    count_similar_image_usage,
    get_user_daily_search_limit,
    record_search_usage,
    record_similar_image_usage,
)
from agent.tools.base import BaseSkill, Tool

_TAVILY_URL = "https://api.tavily.com/search"
_search_log = logging.getLogger("agent.search")

# 每次模型工具循环独立计数，避免并发会话互相影响。
_url_inspection_used: ContextVar[bool] = ContextVar("url_inspection_used", default=False)


def reset_image_inspection_budget() -> None:
    """开始一轮对话工具循环时重置网络图片读取额度。"""
    _url_inspection_used.set(False)

_SEARCH_QUERY_DESCRIPTION = (
    "搜索关键词。优先使用简短关键词组合，不要直接复制用户的完整问题或写成长句；"
    "保留实体名、产品名、版本号、年份/日期和关键术语。精确文件名、报错文本、论文标题、"
    "产品完整型号等本身是高价值检索词，应完整保留。"
)


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


# ── web_search：SearXNG（通用、免费、无配额）────────────────────────────────
async def _searxng_search(db, user_id, args: dict):
    settings = get_settings()
    base = (settings.search.searxng_url or "").rstrip("/")
    if not base:
        return {"error": "管理员尚未配置通用搜索（SearXNG）；要查外部信息可改用 deep_research"}
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "需要提供搜索关键词 query"}

    max_results = args.get("max_results") or settings.search.max_results
    # 不用 categories：国内服务器上 news/it/science 等类别的引擎（google/bing news 等）全被墙，
    # 传了只会挂一堆死引擎、拖慢甚至超时；通用引擎 sogou/quark/360 本就覆盖新闻等查询。
    engines = settings.search.searxng_engines
    params = {"q": query, "format": "json", "engines": engines}
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
        ) as client:
            resp = await client.get(f"{base}/search", params=params)
    except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError):
        # SearXNG 已明确不可用时直接切换深度研究，避免模型在同一轮里重复调用
        # 已超时的 web_search。deep_research 自己负责配额和错误回执。
        return await _deep_research(db, user_id, {
            "query": query,
            "max_results": max_results,
        })
    except Exception as e:
        return {"error": f"通用搜索暂时失败（{type(e).__name__}）；可改用 deep_research 深度研究兜底"}
    if resp.status_code == 403:
        return {"error": "通用搜索（SearXNG）返回 403：未开启 JSON 输出，需管理员在 settings.yml 加 search.formats: json；本次改用 deep_research"}
    if resp.status_code != 200:
        return {"error": f"通用搜索失败（HTTP {resp.status_code}）；可改用 deep_research 兜底"}
    try:
        data = resp.json()
    except Exception:
        return {"error": "通用搜索返回的不是 JSON（多半未开启 json 格式）；可改用 deep_research 兜底"}

    results = [
        {"title": r.get("title"), "url": r.get("url"), "content": (r.get("content") or "")[:300]}
        for r in (data.get("results") or [])[:max_results]
    ]
    return _build_search_response(query, results, engines, data, kind="web")


# ── image_search：SearXNG images 分类（通用、免费、无配额）───────────────────
async def _searxng_image_search(db, user_id, args: dict):
    settings = get_settings()
    base = (settings.search.searxng_url or "").rstrip("/")
    if not base:
        return {"error": "管理员尚未配置通用搜索（SearXNG）；图片搜索也用不了"}
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "需要提供搜索关键词 query"}

    max_results = args.get("max_results") or settings.search.max_results
    # 图片分类能用的引擎不一定和文本分类（sogou/quark/360search）是同一批；留空则先复用
    # 文本引擎列表兜底，管理员实测后可在后台单独配 searxng_image_engines。
    engines = settings.search.searxng_image_engines or settings.search.searxng_engines
    params = {"q": query, "format": "json", "categories": "images", "engines": engines}
    resp = None
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(connect=5.0, read=20.0, write=5.0, pool=5.0)
            ) as client:
                resp = await client.get(f"{base}/search", params=params)
            break
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as e:
            if attempt == 1:
                return {"error": f"图片搜索暂时失败（{type(e).__name__}），请稍后再试"}
            await asyncio.sleep(0.3)
        except Exception as e:
            return {"error": f"图片搜索暂时失败（{type(e).__name__}）"}
    if resp.status_code == 403:
        return {"error": "图片搜索（SearXNG）返回 403：未开启 JSON 输出，需管理员在 settings.yml 加 search.formats: json"}
    if resp.status_code != 200:
        return {"error": f"图片搜索失败（HTTP {resp.status_code}）；可换个关键词重试，或提醒管理员检查 searxng_image_engines 配置"}
    try:
        data = resp.json()
    except Exception:
        return {"error": "图片搜索返回的不是 JSON（多半未开启 json 格式）"}

    results = [
        {
            "result_id": f"image-{index}",
            "title": r.get("title"),
            "url": r.get("url"),                              # 来源页（供了解出处）
            "img_src": r.get("img_src"),                       # 图片直链——发图/展示用这个
            "thumbnail": r.get("thumbnail_src") or r.get("thumbnail"),
        }
        for index, r in enumerate((data.get("results") or [])[:max_results], start=1)
        if r.get("img_src")
    ]
    response = _build_search_response(query, results, engines, data, kind="image")
    return response


async def _inspect_images(db, user_id, args: dict):
    """读取图片搜索结果中由模型挑选的图片，最多 20 张。"""
    items = args.get("images")
    if not isinstance(items, list) or not items:
        return {"error": "需要提供 images 数组，填写 image_search 返回的 result_id 和 img_src"}
    if len(items) > 20:
        return {"error": "一次最多读取 20 张图片，请拆成多次调用"}

    has_url = any(
        isinstance(item, dict)
        and not str(item.get("attach_id") or "").strip()
        and str(item.get("img_src") or item.get("url") or "").strip()
        for item in items
    )
    if has_url and _url_inspection_used.get():
        return {"error": "本轮对话已经读取过网络图片，请先根据已有图片结果继续分析；下一轮再读取新的网络图片"}
    if has_url:
        _url_inspection_used.set(True)

    from agent.tools.files import inspect_image_url

    inspected = []
    failed = []
    for item in items:
        if not isinstance(item, dict):
            failed.append({"result_id": "", "error": "图片项必须是对象"})
            continue
        result_id = str(item.get("result_id") or "").strip()
        attach_id = str(item.get("attach_id") or "").strip()
        url = str(item.get("img_src") or item.get("url") or "").strip()
        if not url and not attach_id:
            failed.append({"result_id": result_id, "error": "缺少 img_src 或 attach_id"})
            continue
        if attach_id:
            meta = await chat_attach.get_meta(user_id, attach_id)
            if not meta:
                failed.append({"result_id": result_id, "attach_id": attach_id, "error": "找不到这个历史附件，可能已被清理"})
                continue
            ext = str(meta.get("ext") or "").lower()
            if ext not in chat_attach.VISION_EXTS:
                failed.append({"result_id": result_id, "attach_id": attach_id, "error": f"附件格式 {ext or '未知'} 暂不支持识别"})
                continue
            try:
                block = chat_attach.vision_block(await chat_attach.read_bytes(meta), ext)
                result = {"block": block} if block else {"error": "附件无法解析"}
            except Exception:
                result = {"error": "历史附件读取失败"}
        else:
            result = await inspect_image_url(url)
        if result.get("block"):
            inspected.append({
                "result_id": result_id,
                "attach_id": attach_id or None,
                "title": item.get("title") or result_id or attach_id or "候选图片",
                "block": result["block"],
            })
        else:
            failed.append({"result_id": result_id, "error": result.get("error", "图片无法读取")})

    response = {
        "requested_count": len(items),
        "inspected_count": len(inspected),
        "failed": failed,
    }
    if inspected:
        response["_vision_images"] = inspected
        response["inspection_note"] = f"已读取 {len(inspected)} 张指定图片，请基于图像内容分析。"
    elif not failed:
        response["inspection_note"] = "没有成功读取图片。"
    return response


# ── deep_research：Tavily（深度、有配额）─────────────────────────────────────
async def _deep_research(db, user_id, args: dict):
    settings = get_settings()
    key = settings.search.tavily_api_key
    if not key:
        return json.dumps({"error": "管理员尚未配置深度研究（Tavily API Key）；普通查找可用 web_search"})

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
            return json.dumps({"error": f"今天的深度研究次数已用完（上限 {limit} 次/天）；普通查找仍可用 web_search"})

    max_results = args.get("max_results") or settings.search.max_results
    payload = {
        "api_key": key,
        "query": query,
        "max_results": max_results,
        "search_depth": args.get("depth", "basic"),
        "include_answer": True,
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=5.0)
        ) as client:
            resp = await client.post(_TAVILY_URL, json=payload)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return json.dumps({"error": f"深度研究失败：{str(e)[:100]}"})

    # 记一次用量（成功才记，计入每日配额）
    await record_search_usage(db, user_id, query)

    results = [
        {"title": r.get("title"), "url": r.get("url"), "content": r.get("content")}
        for r in (data.get("results") or [])
    ]
    return {"query": query, "answer": data.get("answer"), "results": results}


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


async def _search_similar_images(db, user_id, args: dict):
    settings = get_settings()
    cfg = settings.search
    if not cfg.similar_image_enabled or not cfg.baidu_qianfan_api_key:
        return {"error": "相似图搜索尚未配置或未启用，请管理员先在 Admin 配置百度千帆 API Key"}

    count = args.get("count") or cfg.similar_image_default_count
    try:
        count = max(1, min(50, int(count)))
    except (TypeError, ValueError):
        return {"error": "count 必须是 1 到 50 之间的整数"}

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
        raw, cfg.baidu_qianfan_api_key, count, cfg.similar_image_timeout_seconds,
    )
    if "error" not in result:
        await record_similar_image_usage(db, user_id)
        if not result.get("results"):
            result["note"] = "没有找到相似结果"
    return result


class SearchSkill(BaseSkill):
    name = "web_search"   # 2026-07-10 前叫 "search"，跟站内 global_search 撞名太像，改名区分；
                          # 旧定时任务 tool_groups 里存的 "search" 兼容映射见 agent/runner.py
    tools = [
        Tool(
            name="web_search", label="联网搜索",
            description=(
                "通用网页搜索（自建 SearXNG，免费、快）：找官网 / 文档 / GitHub / 某个事实 / "
                "新闻标题 / 下载地址等。返回标题+链接+摘要。**大多数联网查找都用这个**；"
                "只有需要『读网页正文并总结 / 比较 / 研究 / 给引用』时才改用 deep_research。"
                "查项目 / 文件 / 日历 / 客户等用户自己的数据请用对应工具，别用本工具。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": _SEARCH_QUERY_DESCRIPTION},
                    "max_results": {
                        "type": "integer", "minimum": 1, "maximum": 20,
                        "description": "返回结果数（默认 5，范围 1~20）",
                    },
                },
                "required": ["query"],
            },
            handler=_searxng_search,
            start_message=lambda args: random.choice(["我去查一下。", "我搜一下最新的资料。", "我确认一下这个。"]),
        ),
        Tool(
            name="image_search", label="图片搜索",
            description=(
                "图片搜索（自建 SearXNG images 分类，免费、无配额）：用户要找图/配图/看看某样东西长什么样时用。"
                "返回候选列表（标题+来源页+图片直链 img_src+缩略图），**只是列出候选，不会自动发送**。"
                "需要视觉分析时，必须再单独调用 inspect_images，并由模型自行挑选要看的候选图；每轮最多读取一次网络图片。"
                "用户明确要看图/要一张图 → 搜到后接着调 files 技能的 send_file(url=选中候选的 img_src) 把图发出去，"
                "不用再问一句「要不要发」（找图本身就是要看/要发，没有额外的保存步骤）。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": _SEARCH_QUERY_DESCRIPTION},
                    "max_results": {
                        "type": "integer", "minimum": 1, "maximum": 20,
                        "description": "返回候选数（默认 5，范围 1~20）",
                    },
                },
                "required": ["query"],
            },
            handler=_searxng_image_search,
            start_message=lambda args: random.choice(["我去找张图。", "我搜搜看有没有合适的图。"]),
        ),
        Tool(
            name="inspect_images", label="读取图片",
            description=(
                "读取 image_search 结果或历史消息附件并交给视觉模型分析。搜索图片填写 result_id、img_src、title；"
                "历史图片填写上下文中的 attach_id；"
                "一次最多读取 20 张。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "images": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 20,
                        "description": "要读取的图片结果，使用 image_search 返回的 result_id、img_src 和 title。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "result_id": {"type": "string"},
                                "img_src": {"type": "string"},
                                "attach_id": {"type": "string", "description": "历史消息中的图片附件 ID"},
                                "title": {"type": "string"},
                            },
                            "anyOf": [{"required": ["img_src"]}, {"required": ["attach_id"]}],
                        },
                    },
                },
                "required": ["images"],
            },
            handler=_inspect_images,
            start_message=lambda args: random.choice(["我读取选中的图片对比一下。", "我看看这些图片。"]),
        ),
        Tool(
            name="search_similar_images", label="相似图搜索",
            description=(
                "根据一张图片搜索互联网中的相似图片。用户说找相似图、找同款、这张图还有哪些类似图片时使用。"
                "当前图片用上下文中的 attach_id，网络图片用 image_url；如果刚用 image_search 找到图片，"
                "使用对应结果的 img_src 作为 image_url。结果是相似候选，不代表确认是同一张图。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "attach_id": {"type": "string", "description": "当前消息或历史附件中的图片附件 ID"},
                    "image_url": {"type": "string", "description": "image_search 结果中的图片直链"},
                    "count": {"type": "integer", "minimum": 1, "maximum": 50, "description": "返回结果数，默认使用 Admin 配置"},
                },
                "anyOf": [{"required": ["attach_id"]}, {"required": ["image_url"]}],
            },
            handler=_search_similar_images,
            start_message=lambda args: random.choice(["我拿这张图找找相似结果。", "我搜一下有没有相近的图片。"]),
        ),
        Tool(
            name="deep_research", label="深度研究",
            description=(
                "深度联网研究（Tavily，有每日次数配额）：需要**阅读网页正文并总结 / 比较 / "
                "研究 / 给引用**时用——它会抓取并清洗正文、给出可直接用的内容与 answer。"
                "普通『找个链接 / 查个事实 / 看新闻标题』用 web_search 就够，别用本工具。"
                "SearXNG 没结果 / 超时时，也可用本工具兜底。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "研究问题或检索主题，可使用自然语言问题"},
                    "max_results": {
                        "type": "integer", "minimum": 1, "maximum": 20,
                        "description": "返回结果数（默认 5，范围 1~20）",
                    },
                    "depth": {"type": "string", "enum": ["basic", "advanced"],
                              "description": "搜索深度，默认 basic（advanced 更深但更慢）"},
                },
                "required": ["query"],
            },
            handler=_deep_research,
            start_message=lambda args: random.choice(["我深入研究一下这个。", "我仔细看看，等会儿告诉你。"]),
        ),
    ]


SearchSkill().register()
