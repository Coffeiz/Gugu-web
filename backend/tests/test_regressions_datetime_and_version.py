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
async def test_files_version_retries_deadlock_after_rollback(monkeypatch):
    from app.api.v1.files import _execute_version_query

    class DeadlockDetectedError(Exception):
        pass

    db = SimpleNamespace(
        execute=AsyncMock(side_effect=[
            DBAPIError("SELECT", {}, DeadlockDetectedError()),
            "success",
        ]),
        rollback=AsyncMock(),
    )
    monkeypatch.setattr("asyncio.sleep", AsyncMock())

    result = await _execute_version_query(db, object())

    assert result == "success"
    assert db.execute.await_count == 2
    db.rollback.assert_awaited_once()


@pytest.mark.asyncio
async def test_files_version_does_not_retry_non_deadlock():
    from app.api.v1.files import _execute_version_query

    db_error = DBAPIError("SELECT", {}, ValueError("bad query"))
    db = SimpleNamespace(
        execute=AsyncMock(side_effect=db_error),
        rollback=AsyncMock(),
    )

    with pytest.raises(DBAPIError):
        await _execute_version_query(db, object())

    db.execute.assert_awaited_once()
    db.rollback.assert_not_awaited()
