"""联网搜索工具集：

- `web_search`：通用网页搜索，走自建 **SearXNG**（免费、快）。返回标题+链接+摘要，
  适合找官网/文档/GitHub/某个事实/新闻标题/下载地址等"普通查找"。无配额。
- `deep_research`：深度研究，走 **Tavily**（抓取并清洗网页正文 + 给 answer），适合
  需要"读内容并总结/比较/研究/给引用"的任务。有每日次数配额（SearchUsage）。
- `image_search`：图片搜索，同样走 SearXNG（`categories=images`），免配额。只返回候选
  （标题+来源页+图片直链 img_src+缩略图），**不会自动发送**——真要把图发进对话/IM，
  接着调 `files.py` 的 `send_file(url=候选的 img_src)`。

成本梯队（见 `agent/skills/web-search.md`）：专有技能 → web_search(SearXNG) → deep_research(Tavily)。
SearXNG 部署在后端同机（127.0.0.1），由 settings.search.searxng_url 配；国内服务器只有
sogou/quark/360search 可达，固定带 engines 避开会超时的 google/bing 等。图片搜索能用的引擎不一定
是同一批（`settings.search.searxng_image_engines`，留空回退文本引擎列表）。
"""
from datetime import datetime

import asyncio
from collections import Counter
import json
import logging
import random

from app.core.tz import local_day_start_utc

import httpx
from app.core.config import get_settings
from app.services.search import count_daily_search_usage, get_user_daily_search_limit, record_search_usage
from agent.tools.base import BaseSkill, Tool

_TAVILY_URL = "https://api.tavily.com/search"
_search_log = logging.getLogger("agent.search")

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
            "title": r.get("title"),
            "url": r.get("url"),                              # 来源页（供了解出处）
            "img_src": r.get("img_src"),                       # 图片直链——发图/展示用这个
            "thumbnail": r.get("thumbnail_src") or r.get("thumbnail"),
        }
        for r in (data.get("results") or [])[:max_results]
        if r.get("img_src")
    ]
    return _build_search_response(query, results, engines, data, kind="image")


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
