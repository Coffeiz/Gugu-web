"""Telegram 接入验证：只暴露安全错误，不回传 Bot API 原始信息。"""

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from app.api.v1 import telegram_connect
from app.services.telegram_bot_api import TelegramBotApiError, validate_bot_token

_TEST_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789"


def test_token_validation_rejects_malformed_or_oversized_values():
    assert validate_bot_token(_TEST_TOKEN) == _TEST_TOKEN
    for token in ("", "not-a-token", "12345:short", "9" * 200):
        with pytest.raises(ValueError):
            validate_bot_token(token)


@pytest.mark.asyncio
async def test_connect_validation_checks_identity_then_webhook_without_returning_secret(monkeypatch):
    calls = []

    async def fake_call(token, method):
        calls.append((token, method))
        if method == "getMe":
            return {"id": 9001, "username": "sample_bot"}
        return {"url": ""}

    monkeypatch.setattr(telegram_connect, "call", fake_call)
    result = await telegram_connect._verify(_TEST_TOKEN)

    assert calls == [(_TEST_TOKEN, "getMe"), (_TEST_TOKEN, "getWebhookInfo")]
    assert result["info"]["id"] == 9001


@pytest.mark.asyncio
async def test_connect_rejects_malformed_bot_identity_before_checking_webhook(monkeypatch):
    methods = []

    async def fake_call(_token, method):
        methods.append(method)
        return {"id": "9001"} if method == "getMe" else {"url": ""}

    monkeypatch.setattr(telegram_connect, "call", fake_call)
    with pytest.raises(HTTPException) as raised:
        await telegram_connect._verify(_TEST_TOKEN)

    assert raised.value.status_code == 502
    assert methods == ["getMe"]


@pytest.mark.asyncio
async def test_existing_webhook_is_rejected_without_deleting_or_exposing_url(monkeypatch):
    methods = []

    async def fake_call(token, method):
        methods.append(method)
        if method == "getMe":
            return {"id": 9001, "username": "sample_bot"}
        return {"url": "https://webhook.invalid/bot-secret"}

    monkeypatch.setattr(telegram_connect, "call", fake_call)
    with pytest.raises(HTTPException) as raised:
        await telegram_connect._verify(_TEST_TOKEN)

    assert raised.value.status_code == 409
    assert "webhook.invalid" not in str(raised.value.detail)
    assert methods == ["getMe", "getWebhookInfo"]


@pytest.mark.asyncio
async def test_bot_api_failure_is_safe_and_does_not_include_token(monkeypatch):
    async def fake_call(token, method):
        raise TelegramBotApiError(method, status_code=401, error_code=401)

    monkeypatch.setattr(telegram_connect, "call", fake_call)
    with pytest.raises(HTTPException) as raised:
        await telegram_connect._verify(_TEST_TOKEN)

    assert raised.value.status_code == 400
    assert _TEST_TOKEN not in str(raised.value.detail)


@pytest.mark.asyncio
async def test_gateway_reload_failure_is_written_to_restricted_diagnostics(monkeypatch, user_a):
    from app.core import events, redis
    from app.core import redaction

    published_events = []
    diagnostics = []

    async def publish_event(user_id, domain, *, operation):
        published_events.append((user_id, domain, operation))

    class Redis:
        async def publish(self, *_args):
            raise RuntimeError("synthetic Redis unavailable")

    def diag_log(where, exc):
        diagnostics.append((where, type(exc)))

    monkeypatch.setattr(events, "publish", publish_event)
    monkeypatch.setattr(redis, "get_redis", lambda: Redis())
    monkeypatch.setattr(redaction, "diag_log", diag_log)

    await telegram_connect._touch(user_a.id)

    assert published_events == [(user_a.id, "im_channels", "refresh")]
    assert diagnostics == [
        ("app.api.telegram_connect.reload_gateway", RuntimeError),
    ]


@pytest.mark.asyncio
async def test_connect_encrypts_token_at_rest_and_returns_no_secret(db, user_a, monkeypatch):
    async def fake_verify(token):
        return {"token": token, "info": {"id": 9001, "username": "sample_bot"}}

    async def fake_touch(_user_id):
        return None

    monkeypatch.setattr(telegram_connect, "_verify", fake_verify)
    monkeypatch.setattr(telegram_connect, "_touch", fake_touch)
    response = await telegram_connect.connect(
        telegram_connect.TelegramTokenIn(token=_TEST_TOKEN), user_a, db
    )
    stored = (await db.execute(
        text("SELECT app_secret FROM user_bots WHERE id = :id"), {"id": response["id"]}
    )).scalar_one()

    assert response == {
        "id": response["id"], "platform": "telegram", "name": "@sample_bot",
        "app_id": "9001", "enabled": True,
    }
    assert stored != _TEST_TOKEN
    assert _TEST_TOKEN not in stored


@pytest.mark.asyncio
async def test_connect_rejects_bot_already_owned_by_another_account(db, user_a, user_b, monkeypatch):
    from app.models import UserBot

    db.add(UserBot(user_id=user_b.id, platform="telegram", app_id="9001", app_secret=_TEST_TOKEN))
    await db.commit()

    async def verify(_token):
        return {"token": _TEST_TOKEN, "info": {"id": 9001, "username": "sample_bot"}}

    monkeypatch.setattr(telegram_connect, "_verify", verify)
    with pytest.raises(HTTPException) as raised:
        await telegram_connect.connect(
            telegram_connect.TelegramTokenIn(token=_TEST_TOKEN), user_a, db
        )

    assert raised.value.status_code == 409
    assert (await db.execute(
        text("SELECT COUNT(*) FROM user_bots WHERE platform = 'telegram' AND app_id = '9001'")
    )).scalar_one() == 1


@pytest.mark.asyncio
async def test_failed_token_rotation_leaves_existing_credential_untouched(db, user_a, monkeypatch):
    from app.models import UserBot

    bot = UserBot(user_id=user_a.id, platform="telegram", app_id="9001", app_secret=_TEST_TOKEN)
    db.add(bot)
    await db.commit()
    await db.refresh(bot)

    async def reject(_token):
        raise HTTPException(400, "Telegram Bot Token 无效")

    monkeypatch.setattr(telegram_connect, "_verify", reject)
    with pytest.raises(HTTPException):
        await telegram_connect.replace_token(
            bot.id,
            telegram_connect.TelegramTokenIn(token="123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef01234567"),
            user_a,
            db,
        )
    await db.refresh(bot)
    assert bot.app_secret == _TEST_TOKEN


@pytest.mark.asyncio
async def test_user_cannot_replace_another_accounts_telegram_bot(db, user_a, user_b, monkeypatch):
    from app.models import UserBot

    bot = UserBot(user_id=user_b.id, platform="telegram", app_id="9001", app_secret=_TEST_TOKEN)
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    verified = []

    async def verify(_token):
        verified.append(True)
        return {"token": _TEST_TOKEN, "info": {"id": 9002}}

    monkeypatch.setattr(telegram_connect, "_verify", verify)
    with pytest.raises(HTTPException) as raised:
        await telegram_connect.replace_token(
            bot.id,
            telegram_connect.TelegramTokenIn(token=_TEST_TOKEN),
            user_a,
            db,
        )

    assert raised.value.status_code == 404
    assert verified == []


@pytest.mark.asyncio
async def test_replacing_with_a_different_bot_requires_a_new_owner_binding(db, user_a, monkeypatch):
    from app.core.tz import now_utc
    from app.models import UserBot

    bot = UserBot(
        user_id=user_a.id,
        platform="telegram",
        app_id="9001",
        app_secret=_TEST_TOKEN,
        owner_platform_user_id="7001",
        owner_bound_at=now_utc(),
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)

    async def verify(_token):
        return {"token": _TEST_TOKEN, "info": {"id": 9002, "username": "new_sample_bot"}}

    async def touch(_user_id):
        return None

    monkeypatch.setattr(telegram_connect, "_verify", verify)
    monkeypatch.setattr(telegram_connect, "_touch", touch)
    await telegram_connect.replace_token(
        bot.id,
        telegram_connect.TelegramTokenIn(token=_TEST_TOKEN),
        user_a,
        db,
    )

    await db.refresh(bot)
    assert bot.app_id == "9002"
    assert bot.owner_platform_user_id is None
    assert bot.owner_bound_at is None


@pytest.mark.asyncio
async def test_telegram_owner_binding_code_is_single_use_and_bot_scoped(db, user_a, monkeypatch):
    from app.models import UserBot
    from app.services import im_identity

    monkeypatch.setattr(
        im_identity, "get_settings", lambda: type("Settings", (), {"secret_key": "synthetic-test-key"})()
    )
    bot = UserBot(user_id=user_a.id, platform="telegram", app_id="9001", app_secret=_TEST_TOKEN)
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    code, ttl = await im_identity.create_telegram_binding_code(bot.id, user_a.id)
    assert ttl == im_identity.QQ_BINDING_CODE_TTL

    assert await im_identity.consume_telegram_binding_code(bot.id, user_a.id, "7001", code) is True
    await db.refresh(bot)
    assert bot.owner_platform_user_id == "7001"
    assert await im_identity.consume_telegram_binding_code(bot.id, user_a.id, "7002", code) is False


@pytest.mark.asyncio
async def test_telegram_owner_binding_limits_total_failed_guesses(db, user_a, monkeypatch):
    from app.models import UserBot
    from app.services import im_identity

    monkeypatch.setattr(
        im_identity, "get_settings", lambda: type("Settings", (), {"secret_key": "synthetic-test-key"})()
    )
    bot = UserBot(user_id=user_a.id, platform="telegram", app_id="9001", app_secret=_TEST_TOKEN)
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    code, _ = await im_identity.create_telegram_binding_code(bot.id, user_a.id)
    wrong_code = "000000" if code != "000000" else "000001"

    for _ in range(im_identity.QQ_BINDING_CODE_MAX_ATTEMPTS):
        assert await im_identity.consume_telegram_binding_code(bot.id, user_a.id, "7001", wrong_code) is False
    assert await im_identity.consume_telegram_binding_code(bot.id, user_a.id, "7001", code) is False
