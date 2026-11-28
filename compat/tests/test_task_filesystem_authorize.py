"""任务授权实际Python request/confirm及策略消费者对照，独立内存库。"""
import asyncio
from types import SimpleNamespace
from uuid import UUID
import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.api.v1.scheduled_tasks import request_task_filesystem_authorization, confirm_task_filesystem_authorization, TaskFilesystemAuthorizationConfirm
from app.models import FilesystemAuthorizationGrant, ScheduledTask, SecurityEvent
from app.services import filesystem_authorization
from app.security import events
from agent.interactions import confirmations


class Redis:
    def __init__(self):
        self.store = {}
    def get(self, key):
        return self.store.get(key)
    def exists(self, key):
        return key in self.store
    def setex(self, key, ttl, value):
        self.store[key] = value
    def delete(self, *keys):
        for key in keys:
            self.store.pop(key, None)


def test_task_authorization_response_one_time_code_and_policy(monkeypatch):
    redis = Redis()
    monkeypatch.setattr(confirmations, "get_redis_sync", lambda: redis)
    monkeypatch.setattr(filesystem_authorization, "filesystem_authorization_enabled", lambda: True)
    monkeypatch.setattr(events, "security_fingerprint", lambda value: "synthetic-fingerprint")

    async def scenario():
        owner = UUID("00000000-0000-4000-8000-000000000091")
        user = SimpleNamespace(id=owner)
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as connection:
                for model in [FilesystemAuthorizationGrant, ScheduledTask, SecurityEvent]:
                    await connection.run_sync(model.__table__.create)
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                task = ScheduledTask(user_id=owner, name="合成任务", cron="0 0 * * *")
                db.add(task)
                await db.commit()
                pending = await request_task_filesystem_authorization(task.id, user, db)
                assert pending["status"] == "waiting_confirmation"
                assert pending["authorization_ttl_minutes"] == 10
                assert pending["needs_confirm"] is True
                assert pending["instruction"] == "确认后，该定时任务每次运行都可读写用户沙箱；不包含宿主机目录。"
                body = TaskFilesystemAuthorizationConfirm(confirm_code=pending["confirm_code"])
                granted = await confirm_task_filesystem_authorization(task.id, body, user, db)
                assert granted["status"] == "authorized"
                policy = await filesystem_authorization.resolve_filesystem_policy(db, owner, subject_type="scheduled_task", subject_id=task.id)
                assert policy.full_user_sandbox is True
                assert policy.grant_id == granted["grant_id"]
                with pytest.raises(HTTPException) as error:
                    await confirm_task_filesystem_authorization(task.id, body, user, db)
                assert error.value.status_code == 400
                assert await request_task_filesystem_authorization(task.id, user, db) == {"status":"authorized", "task_id":task.id}
        finally:
            await engine.dispose()
    asyncio.run(scenario())


def test_task_authorization_enabled_priority(tmp_path, monkeypatch):
    from app.core import config
    path = tmp_path / "config.json"
    monkeypatch.setattr(config, "OVERRIDE_FILE", path)
    monkeypatch.setattr(filesystem_authorization, "get_settings", lambda: config.AppSettings().apply_override())
    for key in ["STORAGE", "STORAGE__BACKEND", "SANDBOX", "SANDBOX__FULL_USER_SANDBOX_AUTHORIZATION_ENABLED"]:
        monkeypatch.delenv(key, raising=False)
    path.write_text("{}")
    assert filesystem_authorization.filesystem_authorization_enabled() is True
    monkeypatch.setenv("STORAGE", '{"backend":"oss"}')
    assert filesystem_authorization.filesystem_authorization_enabled() is False
    monkeypatch.setenv("STORAGE__BACKEND", "local")
    monkeypatch.setenv("SANDBOX", '{"full_user_sandbox_authorization_enabled":false}')
    assert filesystem_authorization.filesystem_authorization_enabled() is False
    monkeypatch.setenv("SANDBOX__FULL_USER_SANDBOX_AUTHORIZATION_ENABLED", "true")
    assert filesystem_authorization.filesystem_authorization_enabled() is True
    path.write_text('{"sandbox":{"full_user_sandbox_authorization_enabled":false}}')
    assert filesystem_authorization.filesystem_authorization_enabled() is False
    path.write_text('{"sandbox":{"full_user_sandbox_authorization_enabled":true}}')
    assert filesystem_authorization.filesystem_authorization_enabled() is True
