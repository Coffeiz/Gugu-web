"""系统日志读取的 Python 参考对照，仅创建独立内存表。"""
import asyncio
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.v1.system_logs import list_system_logs
from app.models import SystemLog


def test_system_logs_filter_limit_and_preserve_microseconds():
    async def scenario():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as connection:
                await connection.run_sync(SystemLog.__table__.create)
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                db.add_all([
                    SystemLog(level="ERROR", module="synthetic", message="合成错误",
                              created_at=datetime(2026, 1, 1, 0, 0, 0, 123456, tzinfo=timezone.utc)),
                    SystemLog(level="INFO", module="synthetic", message="合成状态",
                              created_at=datetime(2026, 1, 2, tzinfo=timezone.utc)),
                ])
                await db.commit()
                result = await list_system_logs(limit=200, level=None, db=db)
                assert [item["level"] for item in result["items"]] == ["INFO", "ERROR"]
                assert await list_system_logs(limit=1, level="error", db=db) == {
                    "items": [dict(id=1, level="ERROR", module="synthetic", message="合成错误",
                                   traceback=None, created_at="2026-01-01T00:00:00.123456+00:00")]
                }
                assert await list_system_logs(limit=0, level="", db=db) == {"items": []}
                assert await list_system_logs(limit=200, level="WARNING", db=db) == {"items": []}
        finally:
            await engine.dispose()
    asyncio.run(scenario())
