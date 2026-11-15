"""管理员通知持久化与投影对照，使用独立内存表和合成投递。"""
import asyncio
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.v1 import notifications_admin as api
from app.models import SiteNotification


def test_notification_broadcast_commits_channels_ttl_and_rejects_empty(monkeypatch):
    async def scenario():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        delivered = []
        typed = api.BroadcastRequest(content="类型兼容", bubble="true", persist="false", bubble_ttl_hours="2.0")
        assert typed.bubble is True and typed.persist is False and typed.bubble_ttl_hours == 2
        try:
            async with engine.begin() as connection:
                await connection.run_sync(SiteNotification.__table__.create)
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                async def publish(title, content, color, **kwargs):
                    assert await db.get(SiteNotification, kwargs["nid"]) is not None
                    delivered.append((title, content, color, kwargs))
                monkeypatch.setattr(api.ev, "broadcast", publish)
                monkeypatch.setattr(api, "now_utc", lambda: datetime(2026, 1, 1, tzinfo=timezone.utc))
                result = await api.broadcast(api.BroadcastRequest(content="合成通知", persist=False, bubble_ttl_hours=2), db)
                row = await db.get(SiteNotification, result["id"])
                assert row.bubble_expire_at.isoformat() == "2026-01-01T02:00:00+00:00"
                assert row.bubble is True and row.persist is False
                assert delivered[0][3] == {"nid": row.id, "bubble": True, "persist": False}
                for request in [api.BroadcastRequest(), api.BroadcastRequest(content="内容", bubble=False, persist=False)]:
                    try:
                        await api.broadcast(request, db)
                        assert False, "无效请求应拒绝"
                    except HTTPException as exc:
                        assert exc.status_code == 400
                assert len((await db.execute(select(SiteNotification))).scalars().all()) == 1
        finally:
            await engine.dispose()
    asyncio.run(scenario())
