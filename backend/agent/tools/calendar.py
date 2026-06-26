"""日历领域技能：create_event。

逻辑迁自原 agent.py 的 `_exec_tool`，一字不改（含 project 归属校验）。
"""
import json

from sqlalchemy import select

from app.models import CalendarEvent, Project
from agent import confirm
from agent.tools.base import BaseSkill, Tool


async def _create_event(db, user_id, args: dict):
    pid = args.get("project_id")
    if pid is not None:
        proj = await db.get(Project, pid)
        if not proj or proj.user_id != user_id:
            return json.dumps({"error": "项目不存在"})
    ev = CalendarEvent(
        user_id=user_id,
        title=args["title"],
        date=args["date"],
        type=args.get("type", "event"),
        project_id=pid,
    )
    db.add(ev)
    await db.commit()
    return {"success": True, "title": args["title"], "date": args["date"]}


async def _list_events(db, user_id, args: dict):
    stmt = select(CalendarEvent).where(CalendarEvent.user_id == user_id)
    if args.get("from"):
        stmt = stmt.where(CalendarEvent.date >= args["from"])
    if args.get("to"):
        stmt = stmt.where(CalendarEvent.date <= args["to"])
    if args.get("type"):
        stmt = stmt.where(CalendarEvent.type == args["type"])
    stmt = stmt.order_by(CalendarEvent.date).limit(args.get("limit", 50))
    rows = (await db.execute(stmt)).scalars().all()
    return [
        {"id": e.id, "title": e.title, "date": e.date, "type": e.type,
         "project_id": e.project_id, "description": e.description}
        for e in rows
    ]


async def _resolve_event(db, user_id, args):
    """按 event_id 或事件标题 event（+可选 on_date）定位；返回 (Event|None, 错误JSON|None)。"""
    eid = args.get("event_id")
    if eid:
        e = await db.get(CalendarEvent, eid)
        if not e or e.user_id != user_id:
            return None, json.dumps({"error": "事件不存在"})
        return e, None
    title = args.get("event")
    if title:
        title = str(title).strip()
        rows = (await db.execute(
            select(CalendarEvent).where(CalendarEvent.user_id == user_id, CalendarEvent.title == title)
        )).scalars().all()
        if not rows:
            rows = (await db.execute(
                select(CalendarEvent).where(CalendarEvent.user_id == user_id, CalendarEvent.title.ilike(f"%{title}%"))
            )).scalars().all()
        if args.get("on_date"):
            rows = [e for e in rows if e.date == args["on_date"]]
        if not rows:
            return None, json.dumps({"error": f"未找到事件「{title}」"})
        if len(rows) > 1:
            return None, json.dumps({"error": f"有多个匹配「{title}」的事件，请加 on_date 指明日期或用 event_id",
                                     "candidates": [{"id": e.id, "title": e.title, "date": e.date} for e in rows[:10]]})
        return rows[0], None
    return None, json.dumps({"error": "需提供 event_id 或事件标题 event"})


async def _update_event(db, user_id, args: dict):
    e, _err = await _resolve_event(db, user_id, args)
    if _err:
        return _err
    if args.get("project_id") is not None:
        proj = await db.get(Project, args["project_id"])
        if not proj or proj.user_id != user_id:
            return json.dumps({"error": "关联项目不存在"})
    for field in ("title", "date", "type", "project_id", "description"):
        if field in args:
            setattr(e, field, args[field])
    await db.commit()
    return {"success": True, "event_id": e.id}


async def _delete_event(db, user_id, args: dict):
    e, _err = await _resolve_event(db, user_id, args)
    if _err:
        return _err

    # 事件无回收站 → 不可逆 → 删除二次确认保底
    summary = f"将删除日历事件「{e.title}」（{e.date}），事件无回收站，删除后不可恢复"
    blocked = confirm.needs_confirmation(args, summary)
    if blocked is not None:
        return blocked

    eid, etitle = e.id, e.title
    await db.delete(e)
    await db.commit()
    return {"success": True, "deleted_event_id": eid, "title": etitle}


class CalendarSkill(BaseSkill):
    name = "calendar"
    tools = [
        Tool(
            name="create_event",
            label="新建日历事件",
            description="在日历上创建事件或截止提醒。",
            input_schema={
                "type": "object",
                "properties": {
                    "title":      {"type": "string"},
                    "date":       {"type": "string", "description": "YYYY-MM-DD"},
                    "type":       {"type": "string", "enum": ["event", "deadline"], "description": "默认 event"},
                    "project_id": {"type": "integer", "description": "关联项目 ID（可选）"},
                },
                "required": ["title", "date"],
            },
            handler=_create_event,
        ),
        Tool(
            name="list_events",
            label="查询日历事件",
            description="查询日历事件，可按日期范围和类型筛选。",
            input_schema={
                "type": "object",
                "properties": {
                    "from": {"type": "string", "description": "起始日期 YYYY-MM-DD（含）"},
                    "to":   {"type": "string", "description": "结束日期 YYYY-MM-DD（含）"},
                    "type": {"type": "string", "enum": ["event", "deadline"]},
                },
            },
            handler=_list_events,
        ),
        Tool(
            name="update_event",
            label="更新日历事件",
            description="修改日历事件的标题、日期、类型、关联项目、描述。",
            input_schema={
                "type": "object",
                "properties": {
                    "event_id":   {"type": "integer", "description": "事件 ID（可选）"},
                    "event":      {"type": "string", "description": "事件标题（推荐：直接用标题定位）"},
                    "on_date":    {"type": "string", "description": "同名事件时用日期 YYYY-MM-DD 区分"},
                    "title":      {"type": "string"},
                    "date":       {"type": "string", "description": "YYYY-MM-DD"},
                    "type":       {"type": "string", "enum": ["event", "deadline"]},
                    "project_id": {"type": "integer", "description": "关联项目 ID"},
                    "description": {"type": "string"},
                },
                "required": [],
            },
            handler=_update_event,
        ),
        Tool(
            name="delete_event",
            label="删除日历事件",
            description="删除日历事件 / 活动（无回收站，不可恢复）。流程：先不带 confirm 调用 → 返回影响详情 → 转达用户征得明确同意 → 带 confirm=true 再调一次执行。",
            input_schema={
                "type": "object",
                "properties": {
                    "event_id": {"type": "integer", "description": "事件 ID（可选）"},
                    "event": {"type": "string", "description": "事件标题（推荐：直接用标题定位）"},
                    "on_date": {"type": "string", "description": "同名事件时用日期 YYYY-MM-DD 区分"},
                    "confirm": {"type": "boolean", "description": "确认执行；仅在用户明确同意后置 true"},
                },
                "required": [],
            },
            handler=_delete_event,
            destructive=True,
        ),
    ]


CalendarSkill().register()
