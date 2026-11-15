"""个人导入导出任务只读 API 对照；独立内存表，不启动 Worker。"""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.v1 import data_portability as api
from app.models import DataExportJob, DataImportJob


def test_lists_limits_owner_and_public_job_views():
    async def scenario():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as connection:
                await connection.run_sync(DataExportJob.__table__.create)
                await connection.run_sync(DataImportJob.__table__.create)
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                owner, foreign = SimpleNamespace(id=uuid4()), SimpleNamespace(id=uuid4())
                exports, imports = [], []
                for index in range(22):
                    stamp = datetime(2026, 1, 1, 0, 0, 0, 123456, tzinfo=timezone.utc) + timedelta(days=index)
                    exports.append(DataExportJob(user_id=owner.id, status="ready", artifact_key="synthetic-private-key", artifact_size=500, created_at=stamp))
                    imports.append(DataImportJob(user_id=owner.id, status="preview_ready", mode="preflight", preview={"safe": True}, import_token_hash="synthetic-token-hash", staging_key="synthetic-staging-key", created_at=stamp))
                db.add_all(exports + imports)
                await db.commit()
                assert len(await api.list_exports(user=owner, db=db)) == 10
                assert len(await api.list_imports(user=owner, db=db)) == 20
                assert (await api.list_exports(user=owner, db=db))[0]["id"] == str(exports[-1].id)
                assert await api.list_exports(user=foreign, db=db) == []
                for handler, job in [(api.get_export, exports[0]), (api.get_import, imports[0])]:
                    try:
                        await handler(job.id, user=foreign, db=db)
                        assert False, "跨用户读取必须拒绝"
                    except HTTPException as exc:
                        assert exc.status_code == 404
                export = await api.get_export(exports[0].id, user=owner, db=db)
                imported = await api.get_import(imports[0].id, user=owner, db=db)
                assert export["created_at"] == "2026-01-01T00:00:00.123456+00:00"
                assert export["download_available"] is True
                assert imported["preview"] == {"safe": True}
                assert "synthetic-private-key" not in repr(export)
                assert "synthetic-token-hash" not in repr(imported)
                assert "synthetic-staging-key" not in repr(imported)
        finally:
            await engine.dispose()
    asyncio.run(scenario())
