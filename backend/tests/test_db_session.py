"""数据库 Session 生命周期回归测试。"""

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
