import json

from app.models import UserBot
from app.services.im_identity import (
    QQ_BINDING_CODE_MAX_ATTEMPTS,
    _qq_binding_attempts_key,
    _qq_binding_key,
    consume_qq_binding_code,
    create_qq_binding_code,
)


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.counters = {}
        self.expirations = {}

    async def set(self, key, value, **kwargs):
        self.values[key] = value
        return True

    async def get(self, key):
        return self.values.get(key)

    async def incr(self, key):
        self.counters[key] = self.counters.get(key, 0) + 1
        return self.counters[key]

    async def expire(self, key, seconds):
        self.expirations[key] = seconds
        return True

    async def delete(self, *keys):
        for key in keys:
            self.values.pop(key, None)
            self.counters.pop(key, None)
        return True


async def _create_bot(db, user_id):
    bot = UserBot(
        user_id=user_id,
        platform="qq",
        app_id="app-1",
        app_secret="secret",
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    return bot


async def test_qq_binding_code_is_hashed_and_consumed_once(db, user_a, monkeypatch):
    redis = FakeRedis()
    monkeypatch.setattr("app.services.im_identity.R.get_redis", lambda: redis)
    bot = await _create_bot(db, user_a.id)

    code, expires_in = await create_qq_binding_code(bot.id, user_a.id)

    assert len(code) == 6
    assert code.isdigit()
    assert expires_in == 600
    stored = json.loads(redis.values[_qq_binding_key(bot.id)])
    assert code not in json.dumps(stored)
    assert redis.expirations == {}

    assert await consume_qq_binding_code(bot.id, user_a.id, "qq-owner", code) is True
    assert await consume_qq_binding_code(bot.id, user_a.id, "qq-owner", code) is False

    await db.refresh(bot)
    assert bot.owner_platform_user_id == "qq-owner"
    assert bot.owner_bound_at is not None


async def test_qq_binding_code_rejects_wrong_sender_guesses(db, user_a, monkeypatch):
    redis = FakeRedis()
    monkeypatch.setattr("app.services.im_identity.R.get_redis", lambda: redis)
    bot = await _create_bot(db, user_a.id)
    code, _ = await create_qq_binding_code(bot.id, user_a.id)
    wrong_code = "000000" if code != "000000" else "000001"

    for _ in range(QQ_BINDING_CODE_MAX_ATTEMPTS):
        assert await consume_qq_binding_code(bot.id, user_a.id, "qq-stranger", wrong_code) is False
    assert await consume_qq_binding_code(bot.id, user_a.id, "qq-stranger", code) is False
    assert redis.counters[_qq_binding_attempts_key(
        bot.id,
        json.loads(redis.values[_qq_binding_key(bot.id)])['challenge_id'],
        "qq-stranger",
    )] == QQ_BINDING_CODE_MAX_ATTEMPTS + 1


async def test_qq_binding_code_does_not_bind_another_users_bot(db, user_a, user_b, monkeypatch):
    redis = FakeRedis()
    monkeypatch.setattr("app.services.im_identity.R.get_redis", lambda: redis)
    bot = await _create_bot(db, user_b.id)
    code, _ = await create_qq_binding_code(bot.id, user_b.id)

    assert await consume_qq_binding_code(bot.id, user_a.id, "qq-owner", code) is False
    await db.refresh(bot)
    assert bot.owner_platform_user_id is None


async def test_qq_binding_command_is_consumed_before_agent_enqueue(monkeypatch):
    from agent.gateway import qq

    acked = []
    produced = []

    async def fake_consume(bot_id, owner_user_id, platform_user_id, code):
        assert bot_id == 18
        assert str(owner_user_id) == "00000000-0000-0000-0000-000000000001"
        assert platform_user_id == "qq-owner"
        assert code == "123456"
        return True

    async def fake_ack(*args):
        acked.append(args)

    async def fake_produce(*args):
        produced.append(args)

    monkeypatch.setattr("app.services.im_identity.consume_qq_binding_code", fake_consume)
    monkeypatch.setattr(qq, "_qq_ack", fake_ack)
    monkeypatch.setattr(qq.R, "produce", fake_produce)

    await qq._handle_raw_qq_message(
        "C2C_MESSAGE_CREATE",
        {
            "id": "message-1",
            "content": "绑定 123456",
            "author": {"user_openid": "qq-owner"},
            "attachments": [],
        },
        "18",
        "00000000-0000-0000-0000-000000000001",
        {},
    )

    assert produced == []
    assert acked and acked[0][1:4] == ("c2c", "qq-owner", "QQ 身份已绑定，之后可以正常使用。")
