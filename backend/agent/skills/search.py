"""联网搜索技能：Tavily。

web_search 调 Tavily Search API 取实时网络信息。Key 从 settings.search.tavily_api_key
读（env SEARCH__TAVILY_API_KEY 或 config.override.json），未配置时返回友好错误。
每日次数受 quota.default_search_limit_daily 限制，每次成功搜索记一行 SearchUsage。
"""
import json
from datetime import datetime

import httpx
from sqlalchemy import func, select

from app.core.config import get_settings
from app.models import SearchUsage
from agent.skills.base import BaseSkill, Tool

_TAVILY_URL = "https://api.tavily.com/search"


async def _web_search(db, user_id, args: dict):
    settings = get_settings()
    key = settings.search.tavily_api_key
    if not key:
        return json.dumps({"error": "管理员尚未配置联网搜索（Tavily API Key），暂时无法上网查"})

    query = (args.get("query") or "").strip()
    if not query:
        return json.dumps({"error": "需要提供搜索关键词 query"})

    # ── 每日次数配额（None=不限制）──
    limit = settings.quota.default_search_limit_daily
    if limit is not None:
        day_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        used = (await db.execute(
            select(func.count(SearchUsage.id)).where(
                SearchUsage.user_id == user_id, SearchUsage.created_at >= day_start
            )
        )).scalar() or 0
        if used >= limit:
            return json.dumps({"error": f"今天的联网搜索次数已用完（上限 {limit} 次/天），明天再来吧"})

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
        return json.dumps({"error": f"搜索失败：{str(e)[:100]}"})

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
                "联网搜索实时/外部信息（新闻、资料、当前事实、行情等）。"
                "需要用户数据库之外的最新信息时用；查项目/文件/日历/客户等用户自己的数据"
                "请用对应工具，不要用本工具。"
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
            handler=_web_search,
        ),
    ]


SearchSkill().register()
