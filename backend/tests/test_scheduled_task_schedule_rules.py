from datetime import datetime, timezone
import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_normalize_cron_supports_independent_window_boundaries():
    from app.core.schedule_rules import normalize_schedule

    spec = normalize_schedule(
        schedule_kind="cron", cron="0 9 * * *", interval_minutes=None,
        start_at="2026-09-10T00:00:00", end_at="2026-09-30T23:59:59",
        now=datetime(2026, 9, 5, tzinfo=timezone.utc),
    )
    assert spec.cron == "0 9 * * *"
    assert spec.interval_minutes is None
    assert spec.start_at == datetime(2026, 9, 9, 16, tzinfo=timezone.utc)
    assert spec.end_at == datetime(2026, 9, 30, 15, 59, 59, tzinfo=timezone.utc)


@pytest.mark.parametrize("start_at,end_at", [(None, None), ("2026-09-05T18:30", None), (None, "2099-09-05T19:30"), ("2026-09-05T18:30", "2026-09-05T19:30")])
def test_normalize_interval_supports_all_window_combinations(start_at, end_at):
    from app.core.schedule_rules import normalize_schedule

    spec = normalize_schedule(
        schedule_kind="interval", cron=None, interval_minutes=10,
        start_at=start_at, end_at=end_at,
        now=datetime(2026, 9, 5, 10, tzinfo=timezone.utc),
    )
    assert spec.cron == "*/10 * * * *"
    assert spec.interval_minutes == 10


@pytest.mark.parametrize(
    "kwargs,field",
    [
        ({"schedule_kind": "cron", "cron": "*/10 * * * *", "interval_minutes": 10}, "interval_minutes"),
        ({"schedule_kind": "interval", "cron": "0 9 * * *", "interval_minutes": 10}, "cron"),
        ({"schedule_kind": "interval", "cron": None, "interval_minutes": 0}, "interval_minutes"),
        ({"schedule_kind": "interval", "cron": None, "interval_minutes": 61}, "interval_minutes"),
        ({"schedule_kind": "cron", "cron": "0 9 * * *", "interval_minutes": None, "start_at": "2026-09-06T10:00", "end_at": "2026-09-05T10:00"}, "end_at"),
    ],
)
def test_normalize_rejects_invalid_combinations(kwargs, field):
    from app.core.schedule_rules import ScheduleValidationError, normalize_schedule

    values = {"start_at": None, "end_at": None}
    values.update(kwargs)
    with pytest.raises(ScheduleValidationError) as exc_info:
        normalize_schedule(**values, now=datetime(2026, 9, 5, 10, tzinfo=timezone.utc))
    assert exc_info.value.field == field


def test_interval_trigger_is_anchored_and_includes_end_boundary():
    from app.scheduled_tasks import build_trigger

    trigger = build_trigger(
        "*/10 * * * *", schedule_kind="interval", interval_minutes=10,
        start_at=datetime(2026, 9, 5, 10, 30, tzinfo=timezone.utc),
        end_at=datetime(2026, 9, 5, 11, 30, tzinfo=timezone.utc),
    )
    previous = None
    fire_times = []
    for _ in range(8):
        next_fire = trigger.get_next_fire_time(previous, previous or datetime(2026, 9, 5, 10, 29, tzinfo=timezone.utc))
        if next_fire is None:
            break
        fire_times.append(next_fire.astimezone(timezone.utc))
        previous = next_fire
    assert [item.strftime("%H:%M") for item in fire_times] == ["10:30", "10:40", "10:50", "11:00", "11:10", "11:20", "11:30"]


def test_cron_trigger_supports_start_and_end_window():
    from app.scheduled_tasks import build_trigger
    from app.core.schedule_rules import SCHEDULE_TZ

    trigger = build_trigger(
        "0 9 * * 1", schedule_kind="cron",
        start_at=datetime(2026, 9, 7, 0, tzinfo=timezone.utc),
        end_at=datetime(2026, 9, 30, 23, 59, tzinfo=timezone.utc),
    )

    assert trigger.start_date == datetime(2026, 9, 7, 8, tzinfo=SCHEDULE_TZ)
    assert trigger.end_date == datetime(2026, 10, 1, 7, 59, tzinfo=SCHEDULE_TZ)
    assert trigger.get_next_fire_time(
        None, datetime(2026, 9, 6, 0, tzinfo=timezone.utc)
    ) == datetime(2026, 9, 8, 1, tzinfo=timezone.utc)


def test_schedule_status_distinguishes_ended_from_disabled():
    from types import SimpleNamespace
    from app.core.schedule_rules import schedule_status

    now = datetime(2026, 9, 5, 12, tzinfo=timezone.utc)
    ended = SimpleNamespace(schedule_kind="interval", end_at=datetime(2026, 9, 5, 11, tzinfo=timezone.utc), enabled=True)
    disabled = SimpleNamespace(schedule_kind="cron", end_at=None, enabled=False)
    assert schedule_status(ended, now) == "ended"
    assert schedule_status(disabled, now) == "disabled"


@pytest.mark.asyncio
async def test_expired_repeating_tasks_are_destroyed_but_in_flight_task_is_kept(db, user_a, monkeypatch):
    from app.models import ScheduledTask
    from app.scheduled_tasks import _delete_ended_repeating_tasks

    now = datetime(2026, 9, 5, 12, tzinfo=timezone.utc)
    ended = ScheduledTask(
        user_id=user_a.id, name="已结束重复任务", payload="测试", cron="*/1 * * * *",
        schedule_kind="interval", interval_minutes=1,
        end_at=datetime(2026, 9, 5, 11, 59, tzinfo=timezone.utc),
        channels="web", enabled=True,
    )
    in_flight = ScheduledTask(
        user_id=user_a.id, name="执行中重复任务", payload="测试", cron="*/1 * * * *",
        schedule_kind="interval", interval_minutes=1,
        end_at=datetime(2026, 9, 5, 11, 59, tzinfo=timezone.utc),
        channels="web", enabled=True,
    )
    db.add_all([ended, in_flight])
    await db.commit()
    await db.refresh(ended)
    await db.refresh(in_flight)

    async def _in_flight(task_id):
        return task_id == in_flight.id

    async def _notify(_ids):
        return None

    monkeypatch.setattr("app.scheduled_tasks._task_is_in_flight", _in_flight)
    monkeypatch.setattr("app.scheduled_tasks._notify_tasks_changed", _notify)
    removed = await _delete_ended_repeating_tasks(db, [ended, in_flight], now)

    assert [task.id for task in removed] == [ended.id]
    assert await db.get(ScheduledTask, ended.id) is None
    assert await db.get(ScheduledTask, in_flight.id) is not None


def test_normalize_once_requires_a_start_and_has_no_end_window():
    from app.core.schedule_rules import ScheduleValidationError, normalize_schedule

    spec = normalize_schedule(
        schedule_kind="once", cron=None, interval_minutes=None,
        start_at="2099-09-05T18:30:00", end_at=None,
    )
    assert spec.cron == "@once:2099-09-05T10:30:00+00:00"
    assert spec.start_at.isoformat() == "2099-09-05T10:30:00+00:00"
    with pytest.raises(ScheduleValidationError, match="必须设置 start_at"):
        normalize_schedule(
            schedule_kind="once", cron=None, interval_minutes=None,
            start_at=None, end_at=None,
        )


def test_schedule_migration_backfills_cron_interval_once_and_rejects_bad_cron():
    path = Path(__file__).parents[1] / "alembic" / "versions" / "20260905000004_add_scheduled_task_schedule_window.py"
    spec = importlib.util.spec_from_file_location("schedule_window_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE scheduled_tasks ("
            "id INTEGER PRIMARY KEY, cron VARCHAR(60) NOT NULL, created_at DATETIME, "
            "event_id INTEGER, channels VARCHAR(40), enabled BOOLEAN)"
        ))
        connection.execute(text(
            "INSERT INTO scheduled_tasks(id,cron,created_at,event_id,channels,enabled) VALUES "
            "(1,'0 9 * * *','2026-09-05 10:00:00',NULL,'web',1),"
            "(2,'*/10 * * * *','2026-09-05 18:42:00',NULL,'qq',1),"
            "(3,'@once:2026-09-06T09:30:00','2026-09-05 10:00:00',7,'web',1)"
        ))
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()
        rows = connection.execute(text(
            "SELECT id, schedule_kind, interval_minutes, start_at, event_id, channels, enabled "
            "FROM scheduled_tasks ORDER BY id"
        )).all()
        assert rows[0][1:4] == ("cron", None, None)
        assert rows[1][1] == "interval"
        assert rows[1][2] == 10
        assert rows[1][3] is not None
        assert rows[2][1] == "once"
        assert rows[2][3] is not None
        assert rows[2][4:] == (7, "web", 1)


def test_schedule_migration_rolls_back_on_invalid_legacy_task():
    path = Path(__file__).parents[1] / "alembic" / "versions" / "20260905000004_add_scheduled_task_schedule_window.py"
    spec = importlib.util.spec_from_file_location("schedule_window_migration_invalid", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE scheduled_tasks (id INTEGER PRIMARY KEY, cron VARCHAR(60), created_at DATETIME)"
        ))
        connection.execute(text("INSERT INTO scheduled_tasks(id,cron,created_at) VALUES (1,'not a cron','2026-09-05 10:00:00')"))

    with pytest.raises(RuntimeError):
        with engine.begin() as connection:
            context = MigrationContext.configure(connection)
            with Operations.context(context):
                migration.upgrade()

    with engine.connect() as connection:
        assert "schedule_kind" not in {column["name"] for column in inspect(connection).get_columns("scheduled_tasks")}


@pytest.mark.asyncio
async def test_schedule_api_creates_interval_and_explicit_null_clears_start(db, user_a, monkeypatch):
    from app.api.v1.scheduled_tasks import TaskCreate, TaskUpdate, create_task, update_task

    async def _publish(*args, **kwargs):
        return None

    monkeypatch.setattr("app.api.v1.scheduled_tasks.events.publish", _publish)
    task = await create_task(
        TaskCreate(
            name="窗口任务", payload="执行一次", schedule_kind="interval",
            interval_minutes=10, start_at="2026-09-05T18:30:00", end_at="2099-09-05T19:30:00",
        ),
        user_a,
        db,
    )
    assert task["schedule_kind"] == "interval"
    assert task["cron"] == "*/10 * * * *"
    assert task["interval_minutes"] == 10
    assert task["start_at"].endswith("Z")

    updated = await update_task(task["id"], TaskUpdate(start_at=None), user_a, db)
    assert updated["start_at"] is None
    assert updated["end_at"].endswith("Z")
    assert updated["schedule_kind"] == "interval"


@pytest.mark.asyncio
async def test_schedule_api_creates_independent_once_task(db, user_a, monkeypatch):
    from app.api.v1.scheduled_tasks import TaskCreate, create_task

    async def _publish(*args, **kwargs):
        return None

    monkeypatch.setattr("app.api.v1.scheduled_tasks.events.publish", _publish)
    task = await create_task(
        TaskCreate(
            name="单次任务", payload="执行一次", schedule_kind="once",
            start_at="2099-09-05T18:30:00",
        ),
        user_a,
        db,
    )
    assert task["schedule_kind"] == "once"
    assert task["cron"] == "@once:2099-09-05T10:30:00+00:00"
    assert task["start_at"].endswith("Z")
    assert task["end_at"] is None


@pytest.mark.asyncio
async def test_scheduled_task_tool_creates_and_updates_precise_window(db, user_a):
    from agent.tools.scheduled_tasks import _create_scheduled_task, _update_scheduled_task

    created = await _create_scheduled_task(db, user_a.id, {
        "name": "精确窗口", "instruction": "执行任务", "schedule_kind": "interval",
        "interval_minutes": 10, "start_at": "2026-09-05T18:30:00",
        "end_at": "2099-09-05T19:30:00", "channels": ["web"],
    })
    assert created["success"] is True
    assert created["schedule_kind"] == "interval"
    assert created["schedule_status"] == "active"
    assert created["start_at"].endswith("Z")

    updated = await _update_scheduled_task(db, user_a.id, {
        "task_id": created["task_id"], "start_at": None,
    })
    assert updated["success"] is True
    assert updated["start_at"] is None
    assert updated["end_at"].endswith("Z")


@pytest.mark.asyncio
async def test_scheduled_task_tool_creates_independent_once_task(db, user_a):
    from agent.tools.scheduled_tasks import _create_scheduled_task

    created = await _create_scheduled_task(db, user_a.id, {
        "name": "工具单次任务", "instruction": "单次执行", "schedule_kind": "once",
        "start_at": "2099-09-05T18:30:00", "channels": ["web"],
    })
    assert created["success"] is True
    assert created["schedule_kind"] == "once"
    assert created["cron"] == "@once:2099-09-05T10:30:00+00:00"
    assert created["end_at"] is None


def test_scheduled_task_tool_schema_exposes_schedule_contract():
    from agent.tools import registry

    create = registry.get("create_scheduled_task")
    update = registry.get("update_scheduled_task")
    assert create is not None and update is not None
    create_props = create.input_schema["properties"]
    update_props = update.input_schema["properties"]
    assert create.input_schema["required"] == ["name", "instruction", "schedule_kind"]
    assert create_props["schedule_kind"]["enum"] == ["cron", "interval", "once"]
    assert create_props["interval_minutes"]["minimum"] == 1
    assert create_props["interval_minutes"]["maximum"] == 60
    for field in ("start_at", "end_at"):
        assert update_props[field]["type"] == ["string", "null"]
    assert "显式传 null 表示清除" in update.description
