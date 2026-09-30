"""日历领域技能：create_event。

逻辑迁自原 agent.py 的 `_exec_tool`，一字不改（含 project 归属校验）。
"""
import json

from agent.security import confirm
from agent.tools.base import BaseSkill, Tool
from app.services.calendar import (
    create_event,
    event_base_datetime,
    event_reminder_lead_minutes,
    find_events_by_title,
    get_event,
    get_project,
    delete_event_with_reminders,
    list_event_reminders,
    list_events_with_reminders,
    normalize_reminder_channels,
    refresh_event_reminder_metadata,
    replace_event_reminders,
)

_DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"
_TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"
_REMINDER_SCHEMA = {
    "type": "object",
    "properties": {
        "lead_minutes": {"type": "integer", "minimum": 0},
        "channels": {
            "type": "array",
            "items": {"type": "string", "enum": ["web", "feishu", "qq", "wechat"]},
            "minItems": 1,
            "uniqueItems": True,
        },
        "delivery_mode": {"type": "string", "enum": ["owner_private", "current_group"]},
        "enabled": {"type": "boolean"},
    },
    "required": ["lead_minutes"],
    "additionalProperties": False,
}


async def _create_event(db, user_id, args: dict):
    pid = args.get("project_id")
    all_day = bool(args.get("all_day"))
    reminders, error = await _resolve_reminder_specs(db, user_id, args.get("reminders", []))
    if error:
        return {"error": error}
    ev = await create_event(
        db, user_id,
        title=args["title"],
        date=args["date"],
        time=None if all_day else (args.get("time") or None),
        end_time=None if all_day else (args.get("end_time") or None),
        event_type=args.get("type", "event"),
        project_id=pid,
    )
    if ev is None:
        return {"error": "项目不存在"}
    resp = {"success": True, "event_id": ev.id, "title": ev.title, "date": ev.date,
            "time": ev.time, "end_time": ev.end_time}
    rows, error = await replace_event_reminders(db, user_id, ev, reminders)
    if error:
        return {"error": error}
    resp["reminders"] = [_reminder_brief(task, event_base_datetime(ev)) for task in rows]
    return resp


async def _list_events(db, user_id, args: dict):
    rows, rem_by_event = await list_events_with_reminders(
        db, user_id,
        start=args.get("from"),
        end=args.get("to"),
        event_type=args.get("type"),
        limit=args.get("limit", 50),
    )
    # 活动与提醒作为同一对象返回，修改时由 update_event(reminders) 一次整体对账。
    out = []
    for e in rows:
        d = {"id": e.id, "title": e.title, "date": e.date, "time": e.time, "end_time": e.end_time, "type": e.type,
             "project_id": e.project_id, "description": e.description}
        rs = rem_by_event.get(e.id, [])
        d["reminders"] = [_reminder_brief(t, event_base_datetime(e)) for t in rs]
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
    fields = ("title", "date", "time", "end_time", "type", "project_id", "description", "reminders")
    if "all_day" in args:
        if args["all_day"]:
            args = {**args, "time": None, "end_time": None}
        elif "time" not in args:
            return {"error": "all_day=false 时必须提供 time"}
    if not any(fld in args for fld in fields):   # 没给任何要改的字段 → 别假成功（防咕咕误报"已更新"）
        return {"error": "没提供要修改的字段（title/date/time/end_time/type/project_id/description/reminders），未改动。"}
    if args.get("project_id") is not None:
        proj = await get_project(db, user_id, args["project_id"])
        if not proj:
            return {"error": "关联项目不存在"}

    timing_changed = "date" in args or "time" in args
    existing_reminders = (
        await list_event_reminders(db, user_id, e.id)
        if timing_changed and "reminders" not in args else []
    )
    resolved_reminders = None
    if "reminders" in args:
        resolved_reminders, error = await _resolve_reminder_specs(db, user_id, args["reminders"])
        if error:
            return {"error": error}

    old_base = event_base_datetime(e)
    preserved_enabled_reminders = []
    for reminder in existing_reminders:
        reminder.reminder_lead_minutes = event_reminder_lead_minutes(reminder, old_base)
        if not reminder.enabled:
            continue
        lead_minutes = reminder.reminder_lead_minutes
        preserved_enabled_reminders.append({
            "lead_minutes": lead_minutes,
            "channels": [channel for channel in (reminder.channels or "web").split(",") if channel],
            "delivery_targets": reminder.delivery_targets,
            "enabled": True,
        })

    for field in fields:
        if field == "reminders":
            continue
        if field in args:
            setattr(e, field, args[field])

    if resolved_reminders is not None:
        rows, error = await replace_event_reminders(db, user_id, e, resolved_reminders)
        if error:
            return {"error": error}
    elif timing_changed and existing_reminders:
        rows, error = await replace_event_reminders(
            db, user_id, e, preserved_enabled_reminders, preserve_disabled=True,
        )
        if error:
            return {"error": error}
    elif "title" in args:
        rows = await refresh_event_reminder_metadata(db, user_id, e)
    else:
        rows = await list_event_reminders(db, user_id, e.id)

    return {
        "success": True,
        "event_id": e.id,
        "reminders": [_reminder_brief(task, event_base_datetime(e)) for task in rows],
    }


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
        events.sort(key=lambda event: event.id)
        reminders = [await list_event_reminders(db, user_id, event.id) for event in events]
        names = "、".join(event.title for event in events[:10]) + (f"等 {len(events)} 个" if len(events) > 10 else "")
        reminder_count = sum(len(items) for items in reminders)
        blocked = confirm.needs_target_confirmation(
            args,
            f"将删除日历事件：{names}，共 {len(events)} 个，并连带删除 {reminder_count} 条提醒，且无法恢复",
            user_id,
            purpose=confirm.ACTION,
            action="delete_calendar_event",
            targets={"event_id": event_ids},
        )
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
    blocked = confirm.needs_target_confirmation(
        args, summary, user_id,
        purpose=confirm.ACTION,
        action="delete_calendar_event",
        targets={"event_id": [eid]},
    )
    if blocked is not None:
        return blocked

    await delete_event_with_reminders(db, user_id, e)
    return {"success": True, "deleted_event_id": eid, "title": etitle, "deleted_reminders": len(reminders)}


# ── 活动提醒（活动字段的聚合视图；底层绑定 @once ScheduledTask）───────────────
def _reminder_brief(t, base):
    """ScheduledTask → 可直接放回 event.reminders 的字段视图。"""
    lead = event_reminder_lead_minutes(t, base)
    channels = [c for c in (t.channels or "").split(",") if c]
    result = {"lead_minutes": lead, "channels": channels, "enabled": t.enabled}
    if "qq" in channels:
        qq_target = (t.delivery_targets or {}).get("qq") if isinstance(t.delivery_targets, dict) else None
        result["delivery_mode"] = (
            "current_group" if isinstance(qq_target, dict) and qq_target.get("chat_type") == "group"
            else "owner_private"
        )
    return result


async def _resolve_reminder_delivery(db, user_id, channels, delivery_mode):
    """复用独立定时任务的 QQ 目标解析与群聊位置确认规则。"""
    if delivery_mode not in (None, "owner_private", "current_group"):
        return None, None, json.dumps({
            "error": "delivery_mode 只能是 owner_private 或 current_group",
        }, ensure_ascii=False)
    from agent.tools.scheduled_tasks import (
        _delivery_mode_confirmation_error,
        _group_delivery_mode_required,
        _resolve_delivery_targets,
    )

    requested_channels = normalize_reminder_channels(channels).split(",")
    if _group_delivery_mode_required(requested_channels, delivery_mode):
        return None, None, _delivery_mode_confirmation_error()
    resolved_channels, targets, error = await _resolve_delivery_targets(
        db, user_id, requested_channels, delivery_mode or "owner_private",
    )
    return normalize_reminder_channels(resolved_channels), targets, error


async def _resolve_reminder_specs(db, user_id, reminders):
    """解析 event.reminders 中各项的通知渠道与投递目标。"""
    if not isinstance(reminders, list):
        return None, "reminders 必须是提醒配置数组"
    resolved = []
    for reminder in reminders:
        channels, delivery_targets, error = await _resolve_reminder_delivery(
            db, user_id, reminder.get("channels"), reminder.get("delivery_mode"),
        )
        if error:
            return None, error
        resolved.append({
            "lead_minutes": reminder["lead_minutes"],
            "channels": channels.split(","),
            "delivery_targets": delivery_targets,
            "enabled": reminder.get("enabled", True),
        })
    return resolved, None


class CalendarSkill(BaseSkill):
    name = "calendar"
    tools = [
        Tool(
            name="create_event",
            label="新建日历事件",
            description_short='创建活动或截止提醒；日期传字符串，可设置提醒。',
            description=("在日历上创建事件或截止提醒。date 使用日期字符串（支持常见年月日格式，系统归一为 YYYY-MM-DD），"
                         "time/end_time 使用 HH:MM；reminders 是提醒配置数组，每项包含 lead_minutes，可选 channels、delivery_mode。"
                         "QQ 投递到私聊用 owner_private，投递到当前群用 current_group；在 QQ 群中配置 QQ 提醒时必须明确选择。"),
            input_schema={
                "type": "object",
                "properties": {
                    "title":      {"type": "string"},
                    "date":       {"type": "string", "pattern": _DATE_PATTERN},
                    "time":       {"type": "string", "pattern": _TIME_PATTERN},
                    "end_time":   {"type": "string", "pattern": _TIME_PATTERN},
                    "type":       {"type": "string", "enum": ["event", "deadline"]},
                    "project_id": {"type": "integer"},
                    "reminders":  {"type": "array", "items": _REMINDER_SCHEMA, "maxItems": 20,
                                   "x-empty-string": "empty-array"},
                    "all_day":   {"type": "boolean"},
                },
                "required": ["title", "date", "all_day"],
                "allOf": [
                    {"if": {"required": ["all_day"], "properties": {"all_day": {"const": True}}},
                     "then": {"not": {"anyOf": [{"required": ["time"]}, {"required": ["end_time"]}]}}},
                    {"if": {"required": ["all_day"], "properties": {"all_day": {"const": False}}},
                     "then": {"required": ["time"]}},
                ],
            },
            handler=_create_event,
            mutates=True,
        ),
        Tool(
            name="list_events",
            label="查询日历事件",
            description_short='查询日历事件；支持按日期范围和类型筛选。',
            description="查询日历事件，可按日期范围和类型筛选；from/to 传日期字符串。每个活动都会带 reminders 数组，元素可直接用于 update_event 的完整提醒配置。",
            input_schema={
                "type": "object",
                "properties": {
                    "from": {"type": "string", "pattern": _DATE_PATTERN},
                    "to":   {"type": "string", "pattern": _DATE_PATTERN},
                    "type": {"type": "string", "enum": ["event", "deadline"],
                             "x-empty-string": "omit", "description": "省略或留空时不筛选活动类型"},
                },
            },
            handler=_list_events,
        ),
        Tool(
            name="update_event",
            label="更新日历事件",
            description_short='修改日历活动及其提醒配置。',
            description=("修改日历事件的标题、日期、时间、类型、关联项目、描述和提醒；date/on_date 传日期字符串，time/end_time 传 HH:MM。"
                         'reminders 省略表示不改提醒，传完整提醒配置数组表示整体替换，传 [] 会清除全部提醒；兼容空字符串 "" 为 []。'
                         "活动日期或开始时间变化且 reminders 省略时，启用的提醒会保留原提前分钟数并随活动重排。"
                         "QQ 投递到私聊用 owner_private，投递到当前群用 current_group；在 QQ 群中配置 QQ 提醒时必须明确选择。"),
            input_schema={
                "type": "object",
                "properties": {
                    "event_id":   {"type": "integer"},
                    "event":      {"type": "string"},
                    "on_date":    {"type": "string", "pattern": _DATE_PATTERN},
                    "title":      {"type": "string"},
                    "date":       {"type": "string", "pattern": _DATE_PATTERN},
                    "time":       {"type": "string", "pattern": _TIME_PATTERN},
                    "end_time":   {"type": "string", "pattern": _TIME_PATTERN},
                    "type":       {"type": "string", "enum": ["event", "deadline"]},
                    "project_id": {"type": "integer"},
                    "description": {"type": "string"},
                    "reminders": {"type": "array", "items": _REMINDER_SCHEMA, "maxItems": 20,
                                  "x-empty-string": "empty-array"},
                    "all_day":   {"type": "boolean"},
                },
                "anyOf": [
                    {"required": ["event_id"]},
                    {"required": ["event"]},
                ],
                "allOf": [
                    {"if": {"required": ["all_day"], "properties": {"all_day": {"const": True}}},
                     "then": {"not": {"anyOf": [{"required": ["time"]}, {"required": ["end_time"]}]}}},
                    {"if": {"required": ["all_day"], "properties": {"all_day": {"const": False}}},
                     "then": {"required": ["time"]}},
                ],
            },
            handler=_update_event,
            mutates=True,
        ),
        Tool(
            name="delete_event",
            label="删除日历事件",
            description_short='删除日历事件。',
            description="删除一个或多个日历事件/活动（无回收站，不可恢复，会连带删除活动提醒）。单项传 event_id/event，批量传 event_ids；批量目标一次确认。",
            input_schema={
                "type": "object",
                "properties": {
                    "event_id": {"type": "integer"},
                    "event_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 50, "uniqueItems": True},
                    "event": {"type": "string"},
                    "on_date": {"type": "string", "pattern": _DATE_PATTERN},
                },
                "required": [],
            },
            handler=_delete_event,
            mutates=True,
            destructive=True,
            batch_confirmation=True,
        ),
    ]


CalendarSkill().register()
