"""审计读取的 Python 参考对照，使用独立内存库。"""
import asyncio
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.v1.audit_log import list_audit_logs
from app.models import AuditLog


def test_audit_list_orders_limits_and_preserves_microseconds():
    async def scenario():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as connection:
                await connection.run_sync(AuditLog.__table__.create)
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                db.add_all([
                    AuditLog(username="小北", action="login", description="登录", ip=None,
                             created_at=datetime(2026, 11, 14, 1, 2, 3, 123456, tzinfo=timezone.utc)),
                    AuditLog(username="小月", action="logout", description="退出", ip="192.0.2.1",
                             created_at=datetime(2026, 11, 13, tzinfo=timezone.utc)),
                ])
                await db.commit()
                result = await list_audit_logs(limit=1, db=db)
                assert len(result["items"]) == 1
                assert result["items"][0] == dict(id=1, username="小北", action="login", description="登录", ip=None,
                                                created_at="2026-11-14T01:02:03.123456+00:00")
                assert await list_audit_logs(limit=0, db=db) == {"items": []}
                assert len((await list_audit_logs(db=db))["items"]) == 2
        finally:
            await engine.dispose()
    asyncio.run(scenario())
