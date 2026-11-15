"""恢复预检的 Python 实际 HTTP 合同，不读取归档或运行 Worker。"""
import asyncio
import hashlib
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4
from fastapi import HTTPException, Response
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.api.v1.data_portability import resume_import
from app.core.tz import now_utc
from app.models import DataImportJob


def test_resume_rotates_only_eligible_owner_token_and_disables_cache():
    async def scenario():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        owner, other = uuid4(), uuid4()
        try:
            async with engine.begin() as connection:
                await connection.run_sync(DataImportJob.__table__.create)
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                row = DataImportJob(user_id=owner, mode="preflight", status="preview_ready",
                                    staging_key="synthetic-staging", preview={"complete": True},
                                    expires_at=now_utc() + timedelta(hours=1), import_token_hash="old-hash")
                db.add(row)
                await db.commit()
                response = Response()
                first = await resume_import(row.id, response, user=SimpleNamespace(id=owner), db=db)
                assert response.headers["Cache-Control"] == "no-store"
                assert len(first["import_token"]) == 43
                assert row.import_token_hash == hashlib.sha256(first["import_token"].encode()).hexdigest()
                assert "staging_key" not in first and "import_token_hash" not in first
                second = await resume_import(row.id, Response(), user=SimpleNamespace(id=owner), db=db)
                assert second["import_token"] != first["import_token"]
                assert row.import_token_hash == hashlib.sha256(second["import_token"].encode()).hexdigest()
                for user, status in [(other, 404), (owner, 409)]:
                    if user == owner:
                        row.expires_at = now_utc() - timedelta(seconds=1)
                        await db.commit()
                    try:
                        await resume_import(row.id, Response(), user=SimpleNamespace(id=user), db=db)
                    except HTTPException as error:
                        assert error.status_code == status
                    else:
                        raise AssertionError("必须拒绝越权或过期恢复")
        finally:
            await engine.dispose()
    asyncio.run(scenario())
