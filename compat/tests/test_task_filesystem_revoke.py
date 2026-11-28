"""任务撤权实际Python handler、审计和幂等对照，独立内存库。"""
import asyncio
from types import SimpleNamespace
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.api.v1.scheduled_tasks import revoke_task_filesystem_authorization
from app.models import FilesystemAuthorizationGrant, ScheduledTask, SecurityEvent
from app.security import events
from agent.interactions import confirmations


def test_task_revoke_clears_grant_audits_and_is_idempotent(monkeypatch):
    calls = []
    monkeypatch.setattr(confirmations, "revoke_confirmation", lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.setattr(events, "security_fingerprint", lambda value: "synthetic-fingerprint")

    async def scenario():
        owner = UUID("00000000-0000-4000-8000-000000000091")
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as connection:
                for model in [FilesystemAuthorizationGrant, ScheduledTask, SecurityEvent]:
                    await connection.run_sync(model.__table__.create)
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                grant = FilesystemAuthorizationGrant(user_id=owner, subject_type="scheduled_task", subject_id="1")
                db.add(grant)
                await db.flush()
                task = ScheduledTask(user_id=owner, name="合成任务", cron="0 0 * * *", filesystem_authorization_grant_id=grant.id)
                db.add(task)
                await db.commit()
                assert await revoke_task_filesystem_authorization(task.id, SimpleNamespace(id=owner), db) == {"status":"revoked", "task_id":task.id, "revoked":True}
                await db.refresh(task)
                assert task.filesystem_authorization_grant_id is None
                await db.refresh(grant)
                assert grant.revoked_at is not None
                audit = (await db.execute(select(SecurityEvent))).scalar_one()
                assert audit.reason_code == "revoked"
                assert audit.metadata_json["subject_type"] == "scheduled_task"
                assert audit.resource_fingerprint == "synthetic-fingerprint"
                assert await revoke_task_filesystem_authorization(task.id, SimpleNamespace(id=owner), db) == {"status":"revoked", "task_id":task.id, "revoked":False}
                assert len((await db.execute(select(SecurityEvent))).scalars().all()) == 1
                assert calls[0][1]["identity"] == "scheduled-task:filesystem:1"
        finally:
            await engine.dispose()
    asyncio.run(scenario())
