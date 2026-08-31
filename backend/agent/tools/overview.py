"""聚合查询技能：get_upcoming / get_dashboard_stats。

跨项目 + 日历 + 文件 + 客户的只读聚合，让咕咕能回答「最近要忙什么」「手头
多少项目」这类问题，也是未来主动触达的基础。日期字段为 YYYY-MM-DD 字符串，
可直接字典序比较。
"""
from datetime import datetime, timedelta

from app.core.tz import now_ctx

from app.services.overview import dashboard_counts, upcoming_rows
from agent.tools.base import BaseSkill, Tool


async def _get_upcoming(db, user_id, args: dict):
    days = int(args.get("days", 7))
    today = now_ctx().strftime("%Y-%m-%d")
    until = (now_ctx() + timedelta(days=days)).strftime("%Y-%m-%d")

    # 近期截止的未完成项目
    proj_rows, ev_rows = await upcoming_rows(db, user_id, today, until)

    items = (
        [{"kind": "project_deadline", "date": p.deadline, "title": p.name,
          "project_id": p.id, "status": p.status} for p in proj_rows]
        + [{"kind": e.type, "date": e.date, "title": e.title,
            "event_id": e.id, "project_id": e.project_id} for e in ev_rows]
    )
    items.sort(key=lambda x: x["date"])
    return {"from": today, "to": until, "count": len(items), "items": items}


async def _get_dashboard_stats(db, user_id, args: dict):
    today = now_ctx().strftime("%Y-%m-%d")
    counts = await dashboard_counts(db, user_id, today)

    return {
        "projects": {"pending": counts["pending"], "active": counts["active"], "done": counts["done"],
                     "total": counts["pending"] + counts["active"] + counts["done"]},
        "upcoming_events": counts["upcoming_events"],
        "files": counts["files"],
        "clients": counts["clients"],
    }


class OverviewSkill(BaseSkill):
    name = "overview"
    tools = [
        Tool(
            name="get_upcoming", label="近期待办",
            description_short='汇总近期项目和活动。',
            description="汇总近期（默认 7 天内）要截止的项目与日历事件，按日期排序。用于回答「最近要忙什么」。",
            input_schema={
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "minimum": 1, "maximum": 366},
                },
            },
            handler=_get_upcoming,
        ),
        Tool(
            name="get_dashboard_stats", label="总览统计",
            description_short='汇总项目、事件、文件和客户数量；无需参数',
            description="返回项目（按状态）、近期事件、文件、客户的数量统计。用于回答「我手头有多少项目」这类总览问题。",
            input_schema={"type": "object", "properties": {}},
            handler=_get_dashboard_stats,
        ),
    ]


OverviewSkill().register()
