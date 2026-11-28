"""终端删除实际Python handler对照：不调用Shell或PTY，仅清理持久视图。"""
import asyncio
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.api.v1.terminals import delete_terminal_view
from app.models import ConversationSession, TerminalSessionRecord, TerminalEventRecord
from app.core import events


def test_terminal_delete_checks_session_owner_and_clears_events(monkeypatch):
    published = []

    async def publish(*args, **kwargs):
        published.append((args, kwargs))

    monkeypatch.setattr(events, "publish", publish)

    async def scenario():
        owner = UUID("00000000-0000-4000-8000-000000000111")
        foreign = UUID("00000000-0000-4000-8000-000000000112")
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as connection:
                for model in [ConversationSession, TerminalSessionRecord, TerminalEventRecord]:
                    await connection.run_sync(model.__table__.create)
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                session = ConversationSession(user_id=foreign,title="合成对话",source="web")
                db.add(session)
                await db.flush()
                for terminal_id, user, session_id in [("owned",owner,None),("foreign",foreign,None),("cross-session",owner,session.id),("missing-session",owner,999)]:
                    db.add(TerminalSessionRecord(id=terminal_id,owner_id=user,session_id=session_id,name="合成终端"))
                await db.flush()
                db.add(TerminalEventRecord(terminal_id="owned",sequence=1,event_type="output",stdout="合成输出"))
                await db.commit()
                for terminal_id, code in [("foreign",404),("cross-session",403),("missing-session",403)]:
                    with pytest.raises(HTTPException) as error:
                        await delete_terminal_view(terminal_id,SimpleNamespace(id=owner),db)
                    assert error.value.status_code == code
                assert published == []
                result = await delete_terminal_view("owned",SimpleNamespace(id=owner),db,SimpleNamespace(headers={"X-Client-Id":"synthetic-client"}))
                assert result == {"deleted":True,"terminalId":"owned"}
                assert (await db.execute(select(TerminalEventRecord))).scalars().all() == []
                assert len((await db.execute(select(TerminalSessionRecord))).scalars().all()) == 3
                assert published == [((owner,"terminals"),dict(origin="synthetic-client",operation="delete",entity_id="owned"))]
        finally:
            await engine.dispose()
    asyncio.run(scenario())
