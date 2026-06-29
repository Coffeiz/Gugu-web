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
        time=(args.get("time") or None),         # 开始 HH:MM，可选
        end_time=(args.get("end_time") or None), # 结束 HH:MM，可选
        type=args.get("type", "event"),
        project_id=pid,
    )
    db.add(ev)
    await db.commit()
    await db.refresh(ev)
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
    stmt = select(CalendarEvent).where(CalendarEvent.user_id == user_id)
    if args.get("from"):
        stmt = stmt.where(CalendarEvent.date >= args["from"])
    if args.get("to"):
        stmt = stmt.where(CalendarEvent.date <= args["to"])
    if args.get("type"):
        stmt = stmt.where(CalendarEvent.type == args["type"])
    stmt = stmt.order_by(CalendarEvent.date).limit(args.get("limit", 50))
    rows = (await db.execute(stmt)).scalars().all()
    # 一并把这些活动的提醒查出来分组挂上，省得模型再逐个 list_event_reminders（一次调用拿全）
    from app.models import ScheduledTask
    rem_by_event: dict = {}
    eids = [e.id for e in rows]
    if eids:
        rtasks = (await db.execute(
            select(ScheduledTask).where(ScheduledTask.user_id == user_id, ScheduledTask.event_id.in_(eids))
            .order_by(ScheduledTask.id)
        )).scalars().all()
        for t in rtasks:
            rem_by_event.setdefault(t.event_id, []).append(t)
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
    fields = ("title", "date", "time", "end_time", "type", "project_id", "description")
    if not any(fld in args for fld in fields):   # 没给任何要改的字段 → 别假成功（防咕咕误报"已更新"）
        return json.dumps({"error": "没提供要修改的字段（title/date/time/end_time/type/project_id/description），未改动。"})
    if args.get("project_id") is not None:
        proj = await db.get(Project, args["project_id"])
        if not proj or proj.user_id != user_id:
            return json.dumps({"error": "关联项目不存在"})
    for field in fields:
        if field in args:
            setattr(e, field, args[field])
    await db.commit()
    return {"success": True, "event_id": e.id}


async def _delete_event(db, user_id, args: dict):
    e, _err = await _resolve_event(db, user_id, args)
    if _err:
        return _err

    eid, etitle = e.id, e.title
    # 应用层级联：连带删掉绑定到该事件的提醒任务（event_id 无 DB 外键，手动清，免留孤儿提醒）。
    # 先点清提醒数量，好在二次确认里如实告知用户「连带删 N 条提醒」。
    from app.models import ScheduledTask
    reminders = (await db.execute(
        select(ScheduledTask).where(ScheduledTask.event_id == eid)
    )).scalars().all()

    # 事件无回收站 → 不可逆 → 删除二次确认保底
    _r = f"及其 {len(reminders)} 条提醒" if reminders else ""
    summary = f"将删除日历事件「{etitle}」（{e.date}）{_r}，事件无回收站，删除后不可恢复"
    blocked = confirm.needs_confirmation(args, summary)
    if blocked is not None:
        return blocked

    for t in reminders:
        await db.delete(t)
    await db.delete(e)
    await db.commit()
    return {"success": True, "deleted_event_id": eid, "title": etitle, "deleted_reminders": len(reminders)}


# ── 活动提醒（绑定到事件的 @once 定时任务，event_id 非空）──────────────────────
# 与独立定时任务完全分开：这些提醒只归活动管，不出现在 list_scheduled_tasks，
# 删活动时连带删；在网页活动卡里也能看到/改。
_REMINDER_CHANNELS = {"web", "feishu", "qq", "wechat"}


def _norm_reminder_channels(chs):
    chs = [c for c in (chs or ["web"]) if c in _REMINDER_CHANNELS]
    return ",".join(chs) if chs else "web"


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


def _build_reminder(user_id, e, lead, channels):
    """构造一条绑定到活动 e 的 @once 提醒任务（不 commit）。返回 (task|None, 跳过说明|None)。"""
    from datetime import timedelta
    from app.core.tz import local_now
    from app.models import ScheduledTask
    try:
        lead = int(lead)
    except (TypeError, ValueError):
        return None, "lead_minutes 需为整数分钟（0=活动开始时）"
    if lead < 0:
        return None, "lead_minutes 不能为负"
    fire = _event_base_dt(e.date, e.time) - timedelta(minutes=lead)
    if fire <= local_now().replace(tzinfo=None):
        return None, f"提前 {lead} 分钟（{fire.strftime('%Y-%m-%d %H:%M')}）已过，跳过"
    when = e.date + (f" {e.time}" if e.time else "")
    t = ScheduledTask(
        user_id=user_id, name=f"{e.title} 提醒",
        payload=f"提醒：{e.title}（{when}）",
        cron=f"@once:{fire.strftime('%Y-%m-%dT%H:%M')}",
        channels=_norm_reminder_channels(channels),
        enabled=True, event_id=e.id,
    )
    return t, None


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
    created, skipped = [], []
    for lead in leads:
        t, err = _build_reminder(user_id, e, lead, channels)
        if err:
            skipped.append(err)
        else:
            db.add(t)
            created.append(t)
    await db.commit()
    for t in created:
        await db.refresh(t)
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
    from app.models import ScheduledTask
    e, _err = await _resolve_event(db, user_id, args)
    if _err:
        return _err
    rows = (await db.execute(
        select(ScheduledTask).where(ScheduledTask.event_id == e.id, ScheduledTask.user_id == user_id)
        .order_by(ScheduledTask.id)
    )).scalars().all()
    base = _event_base_dt(e.date, e.time)
    return {"event_id": e.id, "title": e.title, "reminders": [_reminder_brief(t, base) for t in rows]}


async def _remove_event_reminder(db, user_id, args: dict):
    from app.models import ScheduledTask
    rid = args.get("reminder_id")
    if not rid:
        return json.dumps({"error": "需提供 reminder_id（用 list_event_reminders 查）"}, ensure_ascii=False)
    t = await db.get(ScheduledTask, rid)
    # 必须是本人的、且是活动提醒（event_id 非空）——独立定时任务不归这个工具删
    if not t or t.user_id != user_id or t.event_id is None:
        return json.dumps({"error": "活动提醒不存在"}, ensure_ascii=False)
    tid = t.id
    await db.delete(t)
    await db.commit()
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
                                   "description": "可选，给该活动设提醒，元素=提前分钟数：0=活动开始时、30=提前30分钟、60=1小时、1440=1天。可多个，如 [30, 1440]。无时间的全天活动按当天 09:00 计；已过的会跳过。"},
                    "reminder_channels": {"type": "array", "items": {"type": "string", "enum": ["web", "feishu", "qq", "wechat"]},
                                          "description": "提醒投递渠道，默认 [web]；仅在设了 reminders 时有用"},
                },
                "required": ["title", "date"],
            },
            handler=_create_event,
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
        ),
        Tool(
            name="delete_event",
            label="删除日历事件",
            description="删除日历事件 / 活动（无回收站，不可恢复；会连带删除该活动自带的提醒）。流程：先不带 confirm 调用 → 返回影响详情（含将连带删除的提醒条数）→ 转达用户征得明确同意 → 带 confirm=true 再调一次执行。",
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
        Tool(
            name="add_event_reminder",
            label="给活动加提醒",
            description=("给某个已存在的日历活动添加提醒（到点把活动提醒推给用户）。提醒绑定到活动、与独立定时任务分开管理，"
                         "也会出现在网页活动卡里。提前量单位分钟：0=活动开始时、30=提前30分钟、60=1小时、1440=1天。"
                         "可一次加多个：用 reminders=[30,1440]；只加一个也可用 lead_minutes。"
                         "无时间的全天活动按当天 09:00 计；已过的会跳过（在 skipped 里说明）。"
                         "渠道 channels：web(默认)/feishu/qq/wechat，已连哪个看系统提示。"
                         "（注：新建活动时直接用 create_event 的 reminders 一步到位，不必先建再调这个。）"),
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
        ),
    ]


CalendarSkill().register()
