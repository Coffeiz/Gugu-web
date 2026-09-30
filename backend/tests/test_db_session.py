"""数据库 Session 生命周期回归测试。"""

import asyncio
from types import SimpleNamespace

import pytest

import app.db.session as db_session


def test_build_engine_reaps_idle_transactions(monkeypatch):
    captured = {}
    fake_engine = object()

    def fake_create_engine(url, **kwargs):
        captured["url"] = url
        captured["kwargs"] = kwargs
        return fake_engine

    def fake_sessionmaker(*args, **kwargs):
        captured["sessionmaker"] = kwargs
        return object()

    monkeypatch.setattr(db_session, "create_async_engine", fake_create_engine)
    monkeypatch.setattr(db_session, "async_sessionmaker", fake_sessionmaker)
    monkeypatch.setattr(
        db_session,
        "get_settings",
        lambda: SimpleNamespace(
            db=SimpleNamespace(url="postgresql+asyncpg://test:test@localhost/test"),
            debug=False,
        ),
    )
    monkeypatch.setattr(db_session, "_engine", None)
    monkeypatch.setattr(db_session, "_SessionLocal", None)
    monkeypatch.setattr(db_session, "_engine_loop", None)

    db_session._build_engine()

    assert captured["kwargs"]["connect_args"] == {
        "server_settings": {
            "idle_in_transaction_session_timeout": "60000",
        },
    }


@pytest.mark.asyncio
async def test_get_db_rolls_back_before_close(monkeypatch):
    calls = []

    class FakeSession:
        async def rollback(self):
            calls.append("rollback")

        async def close(self):
            calls.append("close")

    session = FakeSession()
    monkeypatch.setattr(db_session, "_engine", object())
    monkeypatch.setattr(db_session, "_SessionLocal", lambda: session)

    generator = db_session.get_db()
    assert await generator.__anext__() is session
    await generator.aclose()

    assert calls == ["rollback", "close"]


@pytest.mark.asyncio
async def test_get_db_cleanup_finishes_if_request_task_is_cancelled(monkeypatch):
    calls = []
    rollback_started = asyncio.Event()
    allow_rollback_to_finish = asyncio.Event()
    session_closed = asyncio.Event()

    class FakeSession:
        async def rollback(self):
            calls.append("rollback-started")
            rollback_started.set()
            await allow_rollback_to_finish.wait()
            calls.append("rollback-finished")

        async def close(self):
            calls.append("close")
            session_closed.set()

    session = FakeSession()
    monkeypatch.setattr(db_session, "_engine", object())
    monkeypatch.setattr(db_session, "_SessionLocal", lambda: session)

    generator = db_session.get_db()
    assert await generator.__anext__() is session
    cleanup_task = asyncio.create_task(generator.aclose())
    await asyncio.wait_for(rollback_started.wait(), timeout=1)

    cleanup_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cleanup_task

    allow_rollback_to_finish.set()
    await asyncio.wait_for(session_closed.wait(), timeout=1)
    assert calls == ["rollback-started", "rollback-finished", "close"]


@pytest.mark.asyncio
async def test_rollback_safely_invalidates_closed_connection():
    calls = []

    class ClosedSession:
        async def rollback(self):
            calls.append("rollback")
            raise RuntimeError("connection is closed")

        async def invalidate(self):
            calls.append("invalidate")

    assert await db_session.rollback_safely(ClosedSession()) is False
    assert calls == ["rollback", "invalidate"]
