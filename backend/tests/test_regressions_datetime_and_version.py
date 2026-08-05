"""定时任务时区与文件版本查询的回归测试。"""
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.exc import DBAPIError


def test_once_expired_accepts_legacy_naive_and_aware_iso():
    from app.scheduled_tasks import _once_expired
    from app.core.tz import local_now

    now = local_now()
    old = now - timedelta(minutes=3)
    assert _once_expired(f"@once:{old.replace(tzinfo=None).isoformat()}", now)
    assert _once_expired(f"@once:{old.isoformat()}", now)
    assert not _once_expired(f"@once:{(now + timedelta(minutes=3)).isoformat()}", now)


@pytest.mark.asyncio
async def test_list_tasks_does_not_delete_expired_but_failed_once_task(db, user_a):
    """过期的一次性任务面板打开时会被清掉——但如果它是"触发过但失败"的，不能跟着
    一起删：用户还没看到失败结果、也没法再手动重试，就已经从面板上消失了。"""
    from datetime import timedelta as _td
    from app.api.v1.scheduled_tasks import list_tasks
    from app.core.tz import local_now
    from app.models import ScheduledTask

    old = (local_now() - _td(minutes=10)).isoformat()
    failed_task = ScheduledTask(
        user_id=user_a.id, name="失败的任务", payload="占位",
        cron=f"@once:{old}", channels="qq", delivery_targets=None,
        last_run_at=local_now(), last_run_failed=True,
    )
    succeeded_style_task = ScheduledTask(
        user_id=user_a.id, name="早就过期没标失败", payload="占位",
        cron=f"@once:{old}", channels="qq", delivery_targets=None,
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
