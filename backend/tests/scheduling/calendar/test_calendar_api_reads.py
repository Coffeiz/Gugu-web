"""新增 Web 日历读取基准：直接调用真实 handler，不替代 Agent 提醒聚合回归。"""

from fastapi import HTTPException
import pytest

from app.api.v1.events import get_event, list_events
from app.core.tz import now_utc
from app.models import CalendarEvent, Project


pytestmark = pytest.mark.asyncio


async def test_web_list_events_preserves_owner_active_date_order_and_full_camel_dto(db, user_a, user_b):
    """列表仅返回当前用户存活事件；排序及联系人等完整DTO不能被迁移丢失。"""
    project = Project(user_id=user_a.id, name="日历关联项目")
    db.add(project)
    await db.flush()
    later = CalendarEvent(
        user_id=user_a.id, title="后续评审", date="2026-01-30", time="10:15", end_time="11:45",
        type="deadline", client="小北", project_id=project.id, description="合成会议说明", version=3,
    )
    earlier = CalendarEvent(user_id=user_a.id, title="前期计划", date="2026-01-02", type="event")
    foreign = CalendarEvent(user_id=user_b.id, title="其他用户日历", date="2026-01-01", type="event")
    deleted = CalendarEvent(
        user_id=user_a.id, title="已删除日历", date="2026-01-01", type="event", deleted_at=now_utc(),
    )
    db.add_all([later, foreign, earlier, deleted])
    await db.commit()

    result = await list_events(year=None, month=None, current_user=user_a, db=db)

    assert [event.id for event in result] == [earlier.id, later.id]
    assert [event.model_dump(by_alias=True) for event in result] == [
        {
            "id": earlier.id, "title": "前期计划", "date": "2026-01-02", "time": None,
            "endTime": None, "type": "event", "client": None, "projectId": None,
            "description": None, "version": 1,
        },
        {
            "id": later.id, "title": "后续评审", "date": "2026-01-30", "time": "10:15",
            "endTime": "11:45", "type": "deadline", "client": "小北", "projectId": project.id,
            "description": "合成会议说明", "version": 3,
        },
    ]
    own_b = await list_events(year=None, month=None, current_user=user_b, db=db)
    assert [event.id for event in own_b] == [foreign.id]


async def test_web_list_events_filters_only_when_year_and_month_are_both_nonzero(db, user_a):
    """保留真实Web查询的truthy规则，不把单项参数/0误当日期过滤或悄悄拒绝负数。"""
    january = CalendarEvent(user_id=user_a.id, title="一月事项", date="2026-01-15", type="event")
    february = CalendarEvent(user_id=user_a.id, title="二月事项", date="2026-02-15", type="event")
    next_year = CalendarEvent(user_id=user_a.id, title="次年事项", date="2027-01-15", type="event")
    db.add_all([next_year, february, january])
    await db.commit()

    all_ids = [january.id, february.id, next_year.id]
    for year, month in [(None, None), (2026, None), (None, 1), (2026, 0), (0, 1), (0, 0)]:
        result = await list_events(year=year, month=month, current_user=user_a, db=db)
        assert [event.id for event in result] == all_ids
    selected = await list_events(year=2026, month=1, current_user=user_a, db=db)
    assert [event.id for event in selected] == [january.id]
    for year, month in [(-2026, 1), (2026, -1), (-2026, -1), (2026, 13)]:
        result = await list_events(year=year, month=month, current_user=user_a, db=db)
        assert result == []


async def test_web_get_event_hides_foreign_deleted_missing_and_preserves_nulls_version_fallback(db, user_a, user_b):
    """详情越权/软删均404；全天nullable字段与历史0版本回退不可因Node迁移改变。"""
    live = CalendarEvent(
        user_id=user_a.id, title="全天事项", date="2026-03-01", type="event", version=0,
        time=None, end_time=None, client=None, project_id=None, description=None,
    )
    foreign = CalendarEvent(user_id=user_b.id, title="其他用户事项", date="2026-03-01", type="event")
    deleted = CalendarEvent(
        user_id=user_a.id, title="已删事项", date="2026-03-01", type="event", deleted_at=now_utc(),
    )
    db.add_all([live, foreign, deleted])
    await db.commit()

    result = await get_event(eid=live.id, current_user=user_a, db=db)
    assert result.model_dump(by_alias=True) == {
        "id": live.id, "title": "全天事项", "date": "2026-03-01", "time": None,
        "endTime": None, "type": "event", "client": None, "projectId": None,
        "description": None, "version": 1,
    }
    for event_id in [foreign.id, deleted.id, 999999]:
        with pytest.raises(HTTPException) as error:
            await get_event(eid=event_id, current_user=user_a, db=db)
        assert error.value.status_code == 404
        assert error.value.detail == "事件不存在"
    await db.refresh(live)
    assert live.version == 0  # DTO回退不应偷偷迁移或重写历史数据。
