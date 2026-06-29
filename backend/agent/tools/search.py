"""联网搜索工具集：

- `web_search`：通用网页搜索，走自建 **SearXNG**（免费、快）。返回标题+链接+摘要，
  适合找官网/文档/GitHub/某个事实/新闻标题/下载地址等"普通查找"。无配额。
- `deep_research`：深度研究，走 **Tavily**（抓取并清洗网页正文 + 给 answer），适合
  需要"读内容并总结/比较/研究/给引用"的任务。有每日次数配额（SearchUsage）。

成本梯队（见 prompts/skills.md）：专有技能 → web_search(SearXNG) → deep_research(Tavily)。
SearXNG 部署在后端同机（127.0.0.1），由 settings.search.searxng_url 配；国内服务器只有
sogou/quark/360search 可达，固定带 engines 避开会超时的 google/bing 等。
"""
import json
from datetime import datetime

from app.core.tz import local_day_start_utc

import httpx
from sqlalchemy import func, select

from app.core.config import get_settings
from app.models import SearchUsage
from agent.tools.base import BaseSkill, Tool

_TAVILY_URL = "https://api.tavily.com/search"


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
    params = {"q": query, "format": "json", "engines": settings.search.searxng_engines}
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
    if not results:
        return {"query": query, "results": [], "note": "没搜到结果；换个关键词，或改用 deep_research 深度研究兜底"}
    return {"query": query, "results": results}


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
    from app.models import User as _User
    _user_obj = await db.get(_User, user_id)
    limit = (
        _user_obj.search_limit_daily
        if _user_obj and _user_obj.search_limit_daily is not None
        else settings.quota.default_search_limit_daily
    )
    if limit is not None:
        day_start = local_day_start_utc()
        used = (await db.execute(
            select(func.count(SearchUsage.id)).where(
                SearchUsage.user_id == user_id, SearchUsage.created_at >= day_start
            )
        )).scalar() or 0
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
    db.add(SearchUsage(user_id=user_id, query=query[:500]))
    await db.commit()

    results = [
        {"title": r.get("title"), "url": r.get("url"), "content": r.get("content")}
        for r in (data.get("results") or [])
    ]
    return {"query": query, "answer": data.get("answer"), "results": results}


class SearchSkill(BaseSkill):
    name = "search"
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
                    "query": {"type": "string", "description": "搜索关键词"},
                    "max_results": {"type": "integer", "description": "返回结果数（默认 5）"},
                },
                "required": ["query"],
            },
            handler=_searxng_search,
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
                    "query": {"type": "string", "description": "搜索关键词"},
                    "max_results": {"type": "integer", "description": "返回结果数（默认 5）"},
                    "depth": {"type": "string", "enum": ["basic", "advanced"],
                              "description": "搜索深度，默认 basic（advanced 更深但更慢）"},
                },
                "required": ["query"],
            },
            handler=_deep_research,
        ),
    ]


SearchSkill().register()
