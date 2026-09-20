"""agent/tools/calendar.py 单元补测（CRAP 治理 P1）。

覆盖：事件创建（含顺手建提醒）、列表聚合、event 解析阶梯、更新校验、
单/批量删除（确认门拦截 + 放行）、提醒精简视图与提前量列表。
DB 走 conftest 内存库；确认门用 monkeypatch 归零验证放行路径。
"""
import json
from datetime import datetime
from types import SimpleNamespace

import pytest

from agent.tools import calendar as cal
from app.core.schedule_rules import SCHEDULE_TZ
from app.services.calendar import create_event, create_event_reminders


async def _mk_event(db, user, title="评审", date="2026-09-20", time_="09:00", **kw):
    return await create_event(
        db, user.id, title=title, date=date, time=time_, end_time=kw.pop("end_time", None),
        event_type=kw.pop("event_type", "event"), project_id=kw.pop("project_id", None),
    )


# ── _create_event ─────────────────────────────────────────────────────────

async def test_create_event_shapes_and_inline_reminders(db, user_a):
    missing = json.loads(await cal._create_event(db, user_a.id, {
        "title": "评审", "date": "2026-09-20", "project_id": 987654}))
    assert missing["error"] == "项目不存在"

    all_day = await cal._create_event(db, user_a.id, {"title": "截止", "date": "2026-09-21", "all_day": True})
    assert all_day["success"] and all_day["time"] is None and all_day["end_time"] is None

    timed = await cal._create_event(db, user_a.id, {
        "title": "评审", "date": "2026-09-20", "time": "10:00", "end_time": "11:30", "type": "deadline"})
    assert timed["time"] == "10:00" and timed["end_time"] == "11:30" and timed["date"] == "2026-09-20"

    # 顺手建提醒：批量 reminders + 渠道
    with_rem = await cal._create_event(db, user_a.id, {
        "title": "带提醒", "date": "2026-09-22", "time": "09:00",
        "reminders": [30, 1440], "reminder_channels": ["qq"]})
    assert with_rem["reminders_added"] and len(with_rem["reminders_added"]) == 2
    leads = {r["lead_minutes"] for r in with_rem["reminders_added"]}
    assert leads == {30, 1440}
    assert all(r["channels"] == ["qq"] for r in with_rem["reminders_added"])

    # 单个 lead_minutes 形态
    single = await cal._create_event(db, user_a.id, {
        "title": "单提醒", "date": "2026-09-23", "time": "09:00", "lead_minutes": 15})
    assert len(single["reminders_added"]) == 1 and single["reminders_added"][0]["lead_minutes"] == 15


# ── _list_events：活动 + 提醒一次聚合 ──────────────────────────────────────

async def test_list_events_groups_reminders_and_omits_empty(db, user_a, monkeypatch):
    from app.services import calendar as calendar_service

    monkeypatch.setattr(
        calendar_service, "local_now",
        lambda: datetime(2026, 9, 1, tzinfo=SCHEDULE_TZ),
    )
    e1 = await _mk_event(db, user_a, "有提醒")
    await _mk_event(db, user_a, "没提醒", date="2026-09-21")
    await create_event_reminders(db, user_a.id, e1, [30], ["qq", "web"], commit=True)

    rows = await cal._list_events(db, user_a.id, {"from": "2026-09-01", "to": "2026-09-30"})
    by_title = {r["title"]: r for r in rows}
    assert "reminders" in by_title["有提醒"]
    assert by_title["有提醒"]["reminders"][0]["channels"] == ["qq", "web"]
    assert "reminders" not in by_title["没提醒"]                      # 无提醒省略字段

    only = await cal._list_events(db, user_a.id, {"type": "deadline"})
    assert all(r["type"] == "deadline" for r in only)


# ── _resolve_event：id / 标题 / on_date 解析阶梯 ───────────────────────────

async def test_resolve_event_ladder(db, user_a):
    e1 = await _mk_event(db, user_a, "周报评审", date="2026-09-20")
    await _mk_event(db, user_a, "周报评审", date="2026-09-27")

    hit, err = await cal._resolve_event(db, user_a.id, {"event_id": e1.id})
    assert err is None and hit.id == e1.id
    miss, err = await cal._resolve_event(db, user_a.id, {"event_id": 987654})
    assert miss is None and "事件不存在" in json.loads(err)["error"]

    amb, err = await cal._resolve_event(db, user_a.id, {"event": "周报评审"})
    err_data = json.loads(err)
    assert amb is None and "有多个匹配" in err_data["error"] and len(err_data["candidates"]) == 2

    unique, err = await cal._resolve_event(db, user_a.id, {"event": "周报评审", "on_date": "2026-09-27"})
    assert err is None and unique.date == "2026-09-27"

    none, err = await cal._resolve_event(db, user_a.id, {"event": "不存在的活动"})
    assert none is None and "未找到事件" in json.loads(err)["error"]
    none, err = await cal._resolve_event(db, user_a.id, {})
    assert none is None and "event_id" in json.loads(err)["error"]


# ── _update_event：校验与应用 ──────────────────────────────────────────────

async def test_update_event_validations_and_apply(db, user_a):
    e = await _mk_event(db, user_a, "原题", time_="09:00")

    err = json.loads(await cal._update_event(db, user_a.id, {"event_id": e.id}))
    assert "没提供要修改的字段" in err["error"]

    err = json.loads(await cal._update_event(db, user_a.id, {"event_id": e.id, "all_day": False}))
    assert "all_day=false 时必须提供 time" in err["error"]

    err = json.loads(await cal._update_event(
        db, user_a.id, {"event_id": e.id, "title": "新题", "project_id": 987654}))
    assert "关联项目不存在" in err["error"]

    ok = await cal._update_event(db, user_a.id, {
        "event_id": e.id, "title": "新题", "description": "改一下"})
    assert ok == {"success": True, "event_id": e.id}
    await db.refresh(e)
    assert e.title == "新题" and e.description == "改一下"

    # all_day=true 清空时间；all_day=false + time 恢复时间
    await cal._update_event(db, user_a.id, {"event_id": e.id, "all_day": True})
    await db.refresh(e)
    assert e.time is None and e.end_time is None
    await cal._update_event(db, user_a.id, {"event_id": e.id, "all_day": False, "time": "08:15"})
    await db.refresh(e)
    assert e.time == "08:15"


# ── _delete_event：确认门 + 单/批量 ───────────────────────────────────────

async def test_delete_event_single_blocked_then_confirmed(db, user_a, monkeypatch):
    from app.services import calendar as calendar_service
    from app.services.calendar import list_event_reminders

    monkeypatch.setattr(
        calendar_service, "local_now",
        lambda: datetime(2026, 9, 1, tzinfo=SCHEDULE_TZ),
    )
    e = await _mk_event(db, user_a, "要删的")
    await create_event_reminders(db, user_a.id, e, [30], ["qq"], commit=True)

    blocked = await cal._delete_event(db, user_a.id, {"event_id": e.id})
    assert "success" not in blocked                                   # 未确认必须被拦截

    monkeypatch.setattr(cal.confirm, "needs_target_confirmation", lambda *a, **k: None)
    result = await cal._delete_event(db, user_a.id, {"event_id": e.id})
    assert result["success"] and result["deleted_reminders"] == 1
    assert await list_event_reminders(db, user_a.id, e.id) == []      # 提醒连带删除


async def test_delete_event_batch_validation_and_confirmed(db, user_a, monkeypatch):
    e1 = await _mk_event(db, user_a, "批量甲")
    e2 = await _mk_event(db, user_a, "批量乙")

    bad = json.loads(await cal._delete_event(db, user_a.id, {"event_ids": "nope"}))
    assert "event_ids" in bad["error"]
    bad = json.loads(await cal._delete_event(db, user_a.id, {"event_ids": []}))
    assert "event_ids" in bad["error"]
    bad = json.loads(await cal._delete_event(db, user_a.id, {"event_ids": list(range(51))}))
    assert "event_ids" in bad["error"]
    bad = json.loads(await cal._delete_event(db, user_a.id, {"event_ids": [987654]}))
    assert "事件不存在" in bad["error"]

    monkeypatch.setattr(cal.confirm, "needs_target_confirmation", lambda *a, **k: None)
    result = await cal._delete_event(db, user_a.id, {"event_ids": [e2.id, e1.id]})
    assert result["success"] and result["deleted_count"] == 2
    assert {r["title"] for r in result["results"]} == {"批量甲", "批量乙"}


# ── 纯函数：提醒精简视图与提前量列表 ────────────────────────────────────────

def test_reminder_brief_and_lead_list():
    base = datetime(2026, 9, 20, 9, 0)
    once = SimpleNamespace(id=7, schedule_kind="once",
                           start_at=datetime(2026, 9, 20, 8, 0, tzinfo=SCHEDULE_TZ),
                           channels="qq,web", enabled=True)
    brief = cal._reminder_brief(once, base)
    assert brief == {"reminder_id": 7, "fire_at": "2026-09-20 08:00",
                     "lead_minutes": 60, "channels": ["qq", "web"], "enabled": True}

    cron = cal._reminder_brief(SimpleNamespace(
        id=8, schedule_kind="cron", start_at=None, channels=None, enabled=False), base)
    assert cron["fire_at"] is None and cron["lead_minutes"] is None
    assert cron["channels"] == [] and cron["enabled"] is False

    assert cal._lead_list({"reminders": [30, 1440]}) == [30, 1440]
    assert cal._lead_list({"lead_minutes": 10}) == [10]
    assert cal._lead_list({}) == []
    assert cal._lead_list({"reminders": []}) == []                    # 空列表不采纳
