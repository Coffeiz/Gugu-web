"""聚合查询技能：get_upcoming / get_dashboard_stats。

跨项目 + 日历 + 文件 + 客户的只读聚合，让咕咕能回答「最近要忙什么」「手头
多少项目」这类问题，也是未来主动触达的基础。日期字段为 YYYY-MM-DD 字符串，
可直接字典序比较。
"""
from datetime import datetime, timedelta

from sqlalchemy import func, select

from app.models import CalendarEvent, Client, File, Project
from agent.tools.base import BaseSkill, Tool


async def _get_upcoming(db, user_id, args: dict):
    days = int(args.get("days", 7))
    today = datetime.now().strftime("%Y-%m-%d")
    until = (datetime.now() + timedelta(days=days)).strftime("%Y-%m-%d")

    # 近期截止的未完成项目
    proj_rows = (await db.execute(
        select(Project).where(
            Project.user_id == user_id,
            Project.archived == False,
            Project.status != "done",
            Project.deadline.is_not(None),
            Project.deadline >= today,
            Project.deadline <= until,
        )
    )).scalars().all()

    # 近期日历事件
    ev_rows = (await db.execute(
        select(CalendarEvent).where(
            CalendarEvent.user_id == user_id,
            CalendarEvent.date >= today,
            CalendarEvent.date <= until,
        )
    )).scalars().all()

    items = (
        [{"kind": "project_deadline", "date": p.deadline, "title": p.name,
          "project_id": p.id, "status": p.status} for p in proj_rows]
        + [{"kind": e.type, "date": e.date, "title": e.title,
            "event_id": e.id, "project_id": e.project_id} for e in ev_rows]
    )
    items.sort(key=lambda x: x["date"])
    return {"from": today, "to": until, "count": len(items), "items": items}


async def _get_dashboard_stats(db, user_id, args: dict):
    async def _count(stmt):
        return (await db.execute(stmt)).scalar() or 0

    today = datetime.now().strftime("%Y-%m-%d")
    base_proj = select(func.count(Project.id)).where(
        Project.user_id == user_id, Project.archived == False)

    pending = await _count(base_proj.where(Project.status == "pending"))
    active = await _count(base_proj.where(Project.status == "active"))
    done = await _count(base_proj.where(Project.status == "done"))
    upcoming_events = await _count(
        select(func.count(CalendarEvent.id)).where(
            CalendarEvent.user_id == user_id, CalendarEvent.date >= today))
    files = await _count(
        select(func.count(File.id)).where(
            File.user_id == user_id, File.deleted_at.is_(None)))
    clients = await _count(
        select(func.count(Client.id)).where(Client.user_id == user_id))

    return {
        "projects": {"pending": pending, "active": active, "done": done,
                     "total": pending + active + done},
        "upcoming_events": upcoming_events,
        "files": files,
        "clients": clients,
    }


class OverviewSkill(BaseSkill):
    name = "overview"
    tools = [
        Tool(
            name="get_upcoming", label="近期待办",
            description="汇总近期（默认 7 天内）要截止的项目与日历事件，按日期排序。用于回答「最近要忙什么」。",
            input_schema={
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "description": "未来天数，默认 7"},
                },
            },
            handler=_get_upcoming,
        ),
        Tool(
            name="get_dashboard_stats", label="总览统计",
            description="返回项目（按状态）、近期事件、文件、客户的数量统计。用于回答「我手头有多少项目」这类总览问题。",
            input_schema={"type": "object", "properties": {}},
            handler=_get_dashboard_stats,
        ),
    ]


OverviewSkill().register()
