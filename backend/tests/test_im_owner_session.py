import pytest

from agent.im import owner_session
from app.models import ConversationSession


class _FakeRedis:
    def __init__(self):
        self.values = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, ex=None):
        self.values[key] = value

    async def delete(self, key):
        self.values.pop(key, None)


@pytest.mark.asyncio
async def test_owner_session_binding_is_explicit_and_owned(db, user_a, user_b, monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(owner_session.redis_core, "get_redis", lambda: redis)

    session = ConversationSession(user_id=user_a.id, title="网页对话", source="web")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    assert await owner_session.bind_session(db, user_a.id, "qq", "owner-1", session.id)
    assert await owner_session.resolve_session(user_a.id, "qq", "owner-1") == session.id
    assert await owner_session.resolve_session(
        user_a.id, "qq", "owner-1", explicit_session_id=999
    ) == 999
    assert not await owner_session.bind_session(db, user_b.id, "qq", "owner-2", session.id)


@pytest.mark.asyncio
async def test_owner_session_clear_removes_binding(user_a, monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(owner_session.redis_core, "get_redis", lambda: redis)

    key = owner_session._key(user_a.id, "qq", "owner-1")
    redis.values[key] = "123"

    await owner_session.clear_binding(user_a.id, "qq", "owner-1")

    assert await owner_session.get_bound_session(user_a.id, "qq", "owner-1") is None


@pytest.mark.asyncio
async def test_persist_private_session_binds_the_existing_web_session(db, user_a, monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(owner_session.redis_core, "get_redis", lambda: redis)
    session = ConversationSession(user_id=user_a.id, title="网页对话", source="web")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    assert await owner_session.bind_session_by_id("qq", "owner-1", session.id)
    assert await owner_session.resolve_session(user_a.id, "qq", "owner-1") == session.id


@pytest.mark.asyncio
async def test_persist_private_session_accepts_the_platform_session(db, user_a, monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(owner_session.redis_core, "get_redis", lambda: redis)
    session = ConversationSession(user_id=user_a.id, title="QQ 私聊", source="qq")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    assert await owner_session.bind_session_by_id("qq", "owner-1", session.id)
    assert await owner_session.resolve_session(user_a.id, "qq", "owner-1") == session.id


@pytest.mark.asyncio
async def test_bind_web_session_tool_is_owner_private_only(db, user_a, monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(owner_session.redis_core, "get_redis", lambda: redis)
    session = ConversationSession(user_id=user_a.id, title="网页对话", source="web")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    from agent import imctx
    from agent.tools.conversations import _bind_web_session

    imctx.set_im("qq", "msg-1", "bot-1", None, "owner-1", "c2c", im_role="owner")
    assert (await _bind_web_session(db, user_a.id, {"session_id": session.id}))["bound"] is True

    imctx.set_im("qq", "msg-2", "bot-1", "group-1", "member-1", "group", im_role="member")
    assert "error" in await _bind_web_session(db, user_a.id, {"session_id": session.id})
    imctx.clear()
