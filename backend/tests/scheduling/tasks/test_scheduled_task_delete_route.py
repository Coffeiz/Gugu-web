from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import scheduled_tasks
from app.models import ScheduledTask


@pytest.mark.asyncio
async def test_delete_task_owner_isolation_and_post_commit_event(db, user_a, user_b, monkeypatch):
    task = ScheduledTask(user_id=user_a.id, name='定时测试', payload='占位', cron='0 9 * * *', channels='web')
    db.add(task)
    await db.commit()
    task_id = task.id
    events = []

    async def publish(owner, resource, **values):
        assert not db.in_transaction()
        assert await db.scalar(select(ScheduledTask.id).where(ScheduledTask.id == task_id)) is None
        events.append((owner, resource, values))

    monkeypatch.setattr(scheduled_tasks.events, 'publish', publish)
    with pytest.raises(HTTPException) as exc:
        await scheduled_tasks.delete_task(task_id, user=user_b, db=db)
    assert exc.value.status_code == 404
    assert await db.get(ScheduledTask, task_id) is not None
    assert events == []

    await scheduled_tasks.delete_task(task_id, user=user_a, db=db, request=SimpleNamespace(headers={'X-Client-Id': 'test-client'}))
    assert events == [(user_a.id, 'scheduled_tasks', {'origin': 'test-client', 'operation': 'delete', 'entity_id': task_id})]
    with pytest.raises(HTTPException) as exc:
        await scheduled_tasks.delete_task(task_id, user=user_a, db=db)
    assert exc.value.status_code == 404
    assert len(events) == 1
