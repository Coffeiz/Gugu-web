"""日历领域技能：create_event。

逻辑迁自原 agent.py 的 `_exec_tool`，一字不改（含 project 归属校验）。
"""
import json

from app.services.calendar import (
    create_event,
    find_events_by_title,
    get_event,
    get_project,
    create_event_reminders,
    delete_event_reminder,
    delete_event_with_reminders,
    get_event_reminder,
    list_event_reminders,
    list_events_with_reminders,
)
from agent.security import confirm
from agent.tools.base import BaseSkill, Tool


async def _create_event(db, user_id, args: dict):
    pid = args.get("project_id")
    ev = await create_event(
        db, user_id,
        title=args["title"],
        date=args["date"],
        time=args.get("time") or None,
        end_time=args.get("end_time") or None,
        event_type=args.get("type", "event"),
        project_id=pid,
    )
    if ev is None:
        return json.dumps({"error": "项目不存在"})
    resp = {"success": True, "event_id": ev.id, "title": ev.title, "date": ev.date,
            "time": ev.time, "end_time": ev.end_time}
    # 顺手把提醒也建了，省得再单独调 add_event_reminder（一次工具调用搞定「建活动+提醒」）
    leads = _lead_list(args)
    if leads:
        added, skipped = await _add_reminders_for(db, user_id, ev, leads, args.get("reminder_channels"))
        resp["reminders_added"] = added
        if skipped:
            resp["reminders_skipped"] = skipped
    return resp


async def _list_events(db, user_id, args: dict):
    rows, rem_by_event = await list_events_with_reminders(
        db, user_id,
        start=args.get("from"),
        end=args.get("to"),
        event_type=args.get("type"),
        limit=args.get("limit", 50),
    )
    # 一并把这些活动的提醒查出来分组挂上，省得模型再逐个 list_event_reminders（一次调用拿全）
    out = []
    for e in rows:
        d = {"id": e.id, "title": e.title, "date": e.date, "time": e.time, "end_time": e.end_time, "type": e.type,
             "project_id": e.project_id, "description": e.description}
        rs = rem_by_event.get(e.id)
        if rs:   # 有提醒才带 reminders 字段，无则省略（保持输出精简）
            d["reminders"] = [_reminder_brief(t, _event_base_dt(e.date, e.time)) for t in rs]
        out.append(d)
    return out


async def _resolve_event(db, user_id, args):
    """按 event_id 或事件标题 event（+可选 on_date）定位；返回 (Event|None, 错误JSON|None)。"""
    eid = args.get("event_id")
    if eid:
        e = await get_event(db, user_id, eid)
        if not e:
            return None, json.dumps({"error": "事件不存在"})
        return e, None
    title = args.get("event")
    if title:
        title = str(title).strip()
        rows = await find_events_by_title(db, user_id, title)
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
    fields = ("title", "date", "time", "end_time", "type", "project_id", "description")
    if not any(fld in args for fld in fields):   # 没给任何要改的字段 → 别假成功（防咕咕误报"已更新"）
        return json.dumps({"error": "没提供要修改的字段（title/date/time/end_time/type/project_id/description），未改动。"})
    if args.get("project_id") is not None:
        proj = await get_project(db, user_id, args["project_id"])
        if not proj:
            return json.dumps({"error": "关联项目不存在"})
    for field in fields:
        if field in args:
            setattr(e, field, args[field])
    await db.commit()
    return {"success": True, "event_id": e.id}


async def _delete_event(db, user_id, args: dict):
    event_ids = args.get("event_ids")
    if event_ids is not None:
        if not isinstance(event_ids, list) or not event_ids or len(event_ids) > 50:
            return json.dumps({"error": "event_ids 必须是 1-50 个事件 id"})
        events = []
        for event_id in event_ids:
            event, error = await _resolve_event(db, user_id, {"event_id": event_id})
            if error:
                return error
            events.append(event)
        reminders = [await list_event_reminders(db, user_id, event.id) for event in events]
        names = "、".join(event.title for event in events[:10]) + (f"等 {len(events)} 个" if len(events) > 10 else "")
        reminder_count = sum(len(items) for items in reminders)
        blocked = confirm.needs_confirmation(
            args, f"将删除日历事件：{names}，共 {len(events)} 个，并连带删除 {reminder_count} 条提醒，且无法恢复", user_id,
            identity=f"delete_event:event_ids={sorted(event_ids)}")
        if blocked is not None:
            return blocked
        results = []
        for event, event_reminders in zip(events, reminders):
            await delete_event_with_reminders(db, user_id, event)
            results.append({"deleted_event_id": event.id, "title": event.title,
                            "deleted_reminders": len(event_reminders)})
        await db.commit()
        return {"success": True, "deleted_count": len(results), "results": results}
    e, _err = await _resolve_event(db, user_id, args)
    if _err:
        return _err

    eid, etitle = e.id, e.title
    # 应用层级联：连带删掉绑定到该事件的提醒任务（event_id 无 DB 外键，手动清，免留孤儿提醒）。
    # 先点清提醒数量，好在二次确认里如实告知用户「连带删 N 条提醒」。
    reminders = await list_event_reminders(db, user_id, eid)

    # 事件无回收站 → 不可逆 → 删除二次确认保底
    _r = f"及其 {len(reminders)} 条提醒" if reminders else ""
    summary = f"将删除日历事件「{etitle}」（{e.date}）{_r}，事件无回收站，删除后不可恢复"
    blocked = confirm.needs_confirmation(args, summary, user_id)
    if blocked is not None:
        return blocked

    await delete_event_with_reminders(db, user_id, e)
    return {"success": True, "deleted_event_id": eid, "title": etitle, "deleted_reminders": len(reminders)}


# ── 活动提醒（绑定到事件的 @once 定时任务，event_id 非空）──────────────────────
# 与独立定时任务完全分开：这些提醒只归活动管，不出现在 list_scheduled_tasks，
# 删活动时连带删；在网页活动卡里也能看到/改。
def _event_base_dt(date_s, time_s):
    """活动开始的本地 naive datetime；无时间的活动按 09:00 计。"""
    from datetime import datetime
    hh, mm = (time_s or "09:00").split(":")
    return datetime.fromisoformat(f"{date_s}T{int(hh):02d}:{int(mm):02d}:00")


def _reminder_brief(t, base):
    """ScheduledTask → 给模型看的精简提醒视图（含提前量、触发时刻、渠道、启用）。"""
    from datetime import datetime
    lead = fire_at = None
    if (t.cron or "").startswith("@once:"):
        try:
            fdt = datetime.fromisoformat(t.cron[6:])
            fire_at = fdt.strftime("%Y-%m-%d %H:%M")
            lead = round((base - fdt).total_seconds() / 60)
        except ValueError:
            pass
    return {"reminder_id": t.id, "fire_at": fire_at, "lead_minutes": lead,
            "channels": [c for c in (t.channels or "").split(",") if c], "enabled": t.enabled}


def _lead_list(args):
    """取提前量列表：支持 reminders=[30,1440] 批量，或单个 lead_minutes。"""
    rs = args.get("reminders")
    if isinstance(rs, list) and rs:
        return rs
    if args.get("lead_minutes") is not None:
        return [args["lead_minutes"]]
    return []


async def _add_reminders_for(db, user_id, e, leads, channels):
    """给活动 e 批量建提醒并 commit；返回 (added_briefs, skipped_msgs)。"""
    base = _event_base_dt(e.date, e.time)
    created, skipped = await create_event_reminders(db, user_id, e, leads, channels)
    return [_reminder_brief(t, base) for t in created], skipped


async def _add_event_reminder(db, user_id, args: dict):
    e, _err = await _resolve_event(db, user_id, args)
    if _err:
        return _err
    leads = _lead_list(args) or [30]
    added, skipped = await _add_reminders_for(db, user_id, e, leads, args.get("channels"))
    return {"success": True, "event_id": e.id, "title": e.title,
            "added": added, "skipped": skipped,
            "note": "已绑定到该活动；最多 30 秒后开始按时触发"}


async def _list_event_reminders(db, user_id, args: dict):
    e, _err = await _resolve_event(db, user_id, args)
    if _err:
        return _err
    rows = await list_event_reminders(db, user_id, e.id)
    base = _event_base_dt(e.date, e.time)
    return {"event_id": e.id, "title": e.title, "reminders": [_reminder_brief(t, base) for t in rows]}


async def _remove_event_reminder(db, user_id, args: dict):
    rid = args.get("reminder_id")
    if not rid:
        return json.dumps({"error": "需提供 reminder_id（用 list_event_reminders 查）"}, ensure_ascii=False)
    t = await get_event_reminder(db, user_id, rid)
    if t is None:
        return json.dumps({"error": "活动提醒不存在"}, ensure_ascii=False)
    tid = await delete_event_reminder(db, user_id, rid)
    return {"success": True, "removed_reminder_id": tid}


class CalendarSkill(BaseSkill):
    name = "calendar"
    tools = [
        Tool(
            name="create_event",
            label="新建日历事件",
            description=("在日历上创建事件或截止提醒。可一次把提醒也带上（reminders）——这样「建活动+设提醒」一个调用搞定，"
                         "不用再单独调 add_event_reminder。"),
            input_schema={
                "type": "object",
                "properties": {
                    "title":      {"type": "string"},
                    "date":       {"type": "string", "description": "YYYY-MM-DD"},
                    "time":       {"type": "string", "description": "开始时间 HH:MM（可选；不填=全天）"},
                    "end_time":   {"type": "string", "description": "结束时间 HH:MM（可选）"},
                    "type":       {"type": "string", "enum": ["event", "deadline"], "description": "默认 event"},
                    "project_id": {"type": "integer", "description": "关联项目 ID（可选）"},
                    "reminders":  {"type": "array", "items": {"type": "integer"},
                                   "description": "可选提前分钟数数组，如 [30,1440]；全天活动按 09:00，已过时间跳过。"},
                    "reminder_channels": {"type": "array", "items": {"type": "string", "enum": ["web", "feishu", "qq", "wechat"]},
                                          "description": "提醒投递渠道，默认 [web]；仅在设了 reminders 时有用"},
                },
                "required": ["title", "date"],
            },
            handler=_create_event,
            mutates=True,
        ),
        Tool(
            name="list_events",
            label="查询日历事件",
            description="查询日历事件，可按日期范围和类型筛选。每个活动会**连同它自己的提醒**一起返回（reminders 字段，无提醒则不带），不用再逐个查提醒。",
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
                    "time":       {"type": "string", "description": "开始时间 HH:MM（可选；传空串清空）"},
                    "end_time":   {"type": "string", "description": "结束时间 HH:MM（可选）"},
                    "type":       {"type": "string", "enum": ["event", "deadline"]},
                    "project_id": {"type": "integer", "description": "关联项目 ID"},
                    "description": {"type": "string"},
                },
                "required": [],
            },
            handler=_update_event,
            mutates=True,
        ),
        Tool(
            name="delete_event",
            label="删除日历事件",
            description="删除一个或多个日历事件/活动（无回收站，不可恢复，会连带删除活动提醒）。单项传 event_id/event，批量传 event_ids；批量目标一次确认。",
            input_schema={
                "type": "object",
                "properties": {
                    "event_id": {"type": "integer", "description": "事件 ID（可选）"},
                    "event_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 50, "description": "批量删除事件 id"},
                    "event": {"type": "string", "description": "事件标题（推荐：直接用标题定位）"},
                    "on_date": {"type": "string", "description": "同名事件时用日期 YYYY-MM-DD 区分"},
                    "confirm": {"type": "boolean", "description": "确认执行；仅在用户明确同意后置 true"},
                    "confirm_token": {"type": "string", "description": "上一步确认请求返回的短时确认凭证"},
                },
                "required": [],
            },
            handler=_delete_event,
            mutates=True,
            destructive=True,
        ),
        Tool(
            name="add_event_reminder",
            label="给活动加提醒",
            description="给已有日历活动添加提醒；提醒绑定活动，不同于独立定时任务。",
            input_schema={
                "type": "object",
                "properties": {
                    "event_id":     {"type": "integer", "description": "活动 ID（可选）"},
                    "event":        {"type": "string", "description": "活动标题（推荐：直接用标题定位）"},
                    "on_date":      {"type": "string", "description": "同名活动时用日期 YYYY-MM-DD 区分"},
                    "reminders":    {"type": "array", "items": {"type": "integer"},
                                     "description": "批量提前量（分钟），如 [30, 1440]"},
                    "lead_minutes": {"type": "integer", "description": "单个提前量（分钟），0=活动开始时；不传 reminders 时用，默认 30"},
                    "channels":     {"type": "array", "items": {"type": "string", "enum": ["web", "feishu", "qq", "wechat"]},
                                     "description": "投递渠道，默认 [web]"},
                },
                "required": [],
            },
            handler=_add_event_reminder,
            mutates=True,
        ),
        Tool(
            name="list_event_reminders",
            label="查看活动提醒",
            description="列出某个日历活动的全部提醒（reminder_id、触发时间、提前量、渠道、是否启用）。改/删提醒前先用它拿 reminder_id。",
            input_schema={
                "type": "object",
                "properties": {
                    "event_id": {"type": "integer", "description": "活动 ID（可选）"},
                    "event":    {"type": "string", "description": "活动标题（推荐）"},
                    "on_date":  {"type": "string", "description": "同名活动时用日期 YYYY-MM-DD 区分"},
                },
                "required": [],
            },
            handler=_list_event_reminders,
        ),
        Tool(
            name="remove_event_reminder",
            label="删除活动提醒",
            description="删除某个活动提醒（用 list_event_reminders 拿到的 reminder_id）。只删活动提醒，不影响独立定时任务。",
            input_schema={
                "type": "object",
                "properties": {
                    "reminder_id": {"type": "integer", "description": "提醒 ID（来自 list_event_reminders）"},
                },
                "required": ["reminder_id"],
            },
            handler=_remove_event_reminder,
            mutates=True,
        ),
    ]


CalendarSkill().register()
