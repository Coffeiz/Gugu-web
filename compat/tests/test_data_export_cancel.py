"""导出取消请求Python直接对照，不启动归档Worker。"""
import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.v1 import data_portability as api
from app.models import DataExportJob
from app.services.data_portability import api_jobs


def test_export_cancel_owner_state_and_expired_job(monkeypatch):
    stamp = datetime(2026, 1, 2, tzinfo=timezone.utc)
    monkeypatch.setattr(api_jobs, "now_utc", lambda: stamp)
    async def scenario():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as connection:
                await connection.run_sync(DataExportJob.__table__.create)
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                owner, foreign = SimpleNamespace(id=uuid4()), SimpleNamespace(id=uuid4())
                jobs = {state: DataExportJob(user_id=owner.id, status=state, stage=state, expires_at=datetime(2025, 1, 1, tzinfo=timezone.utc)) for state in ["queued", "running", "ready"]}
                db.add_all(jobs.values())
                await db.commit()
                try:
                    await api.cancel_export(jobs["queued"].id, user=foreign, db=db)
                    assert False, "跨用户取消必须拒绝"
                except HTTPException as exc:
                    assert exc.status_code == 404
                assert (await api.cancel_export(jobs["queued"].id, user=owner, db=db))["status"] == "canceled"
                assert jobs["queued"].finished_at == stamp
                assert (await api.cancel_export(jobs["running"].id, user=owner, db=db))["status"] == "canceling"
                assert jobs["running"].finished_at is None
                for state in ["ready", "queued", "running"]:
                    try:
                        await api.cancel_export(jobs[state].id, user=owner, db=db)
                        assert False, "终态及已取消请求必须拒绝"
                    except HTTPException as exc:
                        assert exc.status_code == 409
        finally:
            await engine.dispose()
    asyncio.run(scenario())


def test_export_cancel_refresh_observes_worker_terminal_or_concurrent_deletion(monkeypatch):
    from sqlalchemy import delete, update
    from sqlalchemy.exc import InvalidRequestError
    async def scenario():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as connection:
                await connection.run_sync(DataExportJob.__table__.create)
            factory = async_sessionmaker(engine, expire_on_commit=False)
            async with factory() as db:
                owner = SimpleNamespace(id=uuid4())
                running = DataExportJob(user_id=owner.id, status="running", stage="running")
                queued = DataExportJob(user_id=owner.id, status="queued", stage="queued")
                db.add_all([running, queued])
                await db.commit()
                original = db.refresh
                async def refresh(instance, *args, **kwargs):
                    async with factory() as worker:
                        if instance.id == running.id:
                            await worker.execute(update(DataExportJob).where(DataExportJob.id == running.id, DataExportJob.status == "canceling").values(status="canceled", stage="canceled"))
                        else:
                            await worker.execute(delete(DataExportJob).where(DataExportJob.id == queued.id))
                        await worker.commit()
                    await original(instance, *args, **kwargs)
                monkeypatch.setattr(db, "refresh", refresh)
                assert (await api.cancel_export(running.id, user=owner, db=db))["status"] == "canceled"
                try:
                    await api.cancel_export(queued.id, user=owner, db=db)
                    assert False, "提交后的并行删除导致刷新失败，不能作为最初不存在的404"
                except InvalidRequestError:
                    pass
        finally:
            await engine.dispose()
    asyncio.run(scenario())
