"""定时任务时区与文件版本查询的回归测试。"""
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.exc import DBAPIError


@pytest.mark.asyncio
async def test_list_tasks_does_not_delete_expired_but_failed_once_task(db, user_a):
    """过期的一次性任务面板打开时会被清掉——但如果它是"触发过但失败"的，不能跟着
    一起删：用户还没看到失败结果、也没法再手动重试，就已经从面板上消失了。"""
    from datetime import timedelta as _td
    from app.api.v1.scheduled_tasks import list_tasks
    from app.core.tz import local_now
    from app.models import ScheduledTask

    old = local_now() - _td(minutes=10)
    failed_task = ScheduledTask(
        user_id=user_a.id, name="失败的任务", payload="占位",
        cron=f"@once:{old.isoformat()}", channels="qq", delivery_targets=None,
        schedule_kind="once", start_at=old,
        last_run_at=local_now(), last_run_failed=True,
    )
    succeeded_style_task = ScheduledTask(
        user_id=user_a.id, name="早就过期没标失败", payload="占位",
        cron=f"@once:{old.isoformat()}", channels="qq", delivery_targets=None,
        schedule_kind="once", start_at=old,
    )
    db.add_all([failed_task, succeeded_style_task])
    await db.commit()
    await db.refresh(failed_task)
    await db.refresh(succeeded_style_task)

    resp = await list_tasks(event_id=None, user=user_a, db=db)

    ids = {t["id"] for t in resp["tasks"]}
    assert failed_task.id in ids          # 失败的留着
    assert succeeded_style_task.id not in ids   # 没标失败的过期任务照常清理


@pytest.mark.asyncio
async def test_list_tasks_marks_crashed_once_task_as_failed_instead_of_deleting(db, user_a, monkeypatch):
    """跑过（last_run_at 非空）但既没标失败也没在跑（Redis 锁不在、早过了锁的宽限期）：
    大概率是 worker 执行中途崩了，没来得及写结果。这种不能直接删——要转成失败态，
    让用户能在面板里看到、手动重新触发，而不是无声无息地消失。"""
    from datetime import timedelta as _td
    from app.api.v1.scheduled_tasks import list_tasks
    from app.core.tz import local_now, now_utc
    from app.models import ScheduledTask

    async def fake_exists(key):
        return False   # 锁不在了

    monkeypatch.setattr("app.core.redis.get_redis", lambda: SimpleNamespace(exists=fake_exists))

    old_scheduled = local_now() - _td(minutes=10)
    crashed_task = ScheduledTask(
        user_id=user_a.id, name="执行中途崩溃的任务", payload="占位",
        cron=f"@once:{old_scheduled.isoformat()}", channels="qq", delivery_targets=None,
        schedule_kind="once", start_at=old_scheduled,
        last_run_at=now_utc() - _td(seconds=700),   # 早就超过锁的 600s timeout
        last_run_failed=False,
    )
    db.add(crashed_task)
    await db.commit()
    await db.refresh(crashed_task)

    resp = await list_tasks(event_id=None, user=user_a, db=db)

    ids = {t["id"] for t in resp["tasks"]}
    assert crashed_task.id in ids   # 没被删

    await db.refresh(crashed_task)
    assert crashed_task.last_run_failed is True   # 转成了失败态


@pytest.mark.asyncio
async def test_list_tasks_keeps_in_flight_once_task_untouched(db, user_a, monkeypatch):
    """Redis 锁还在（真的正在跑）：既不删也不标失败，原样留着。"""
    from datetime import timedelta as _td
    from app.api.v1.scheduled_tasks import list_tasks
    from app.core.tz import local_now, now_utc
    from app.models import ScheduledTask

    async def fake_exists(key):
        return True   # 锁还在

    monkeypatch.setattr("app.core.redis.get_redis", lambda: SimpleNamespace(exists=fake_exists))

    old_scheduled = local_now() - _td(minutes=10)
    running_task = ScheduledTask(
        user_id=user_a.id, name="正在跑的任务", payload="占位",
        cron=f"@once:{old_scheduled.isoformat()}", channels="qq", delivery_targets=None,
        schedule_kind="once", start_at=old_scheduled,
        last_run_at=now_utc() - _td(seconds=700),
        last_run_failed=False,
    )
    db.add(running_task)
    await db.commit()
    await db.refresh(running_task)

    resp = await list_tasks(event_id=None, user=user_a, db=db)

    ids = {t["id"] for t in resp["tasks"]}
    assert running_task.id in ids

    await db.refresh(running_task)
    assert running_task.last_run_failed is False   # 没被误标成失败


@pytest.mark.asyncio
async def test_files_version_retries_deadlock_after_rollback(monkeypatch):
    from app.services.files.browser import get_file_version_snapshot

    class DeadlockDetectedError(Exception):
        pass

    db = SimpleNamespace(
        execute=AsyncMock(side_effect=[
            DBAPIError("SELECT", {}, DeadlockDetectedError()),
        SimpleNamespace(one=lambda: (1, "updated", None)),
        ]),
        rollback=AsyncMock(),
    )
    monkeypatch.setattr("asyncio.sleep", AsyncMock())

    result = await get_file_version_snapshot(db, 1)

    assert result == (1, "updated", None)
    assert db.execute.await_count == 2
    db.rollback.assert_awaited_once()


@pytest.mark.asyncio
async def test_files_version_does_not_retry_non_deadlock():
    from app.services.files.browser import get_file_version_snapshot

    db_error = DBAPIError("SELECT", {}, ValueError("bad query"))
    db = SimpleNamespace(
        execute=AsyncMock(side_effect=db_error),
        rollback=AsyncMock(),
    )

    with pytest.raises(DBAPIError):
        await get_file_version_snapshot(db, 1)

    db.execute.assert_awaited_once()
    db.rollback.assert_not_awaited()
