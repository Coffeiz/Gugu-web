import pytest
from fastapi import HTTPException
from starlette.responses import Response

from app.api.v1 import auth
from app.core import events
from app.core.security import create_stream_token, create_user_token, is_user_active, verify_stream_token
from app.schemas import ResetPassword


@pytest.mark.asyncio
async def test_logout_revokes_old_user_jwt_but_new_version_remains_valid(db, user_a):
    previous_version = user_a.security_version or 1
    old_token = create_user_token(user_a.id, previous_version)
    file_token = create_stream_token(17, user_a.id, security_version=previous_version)

    await auth.logout(Response(), user_a, db)

    assert user_a.security_version == previous_version + 1
    assert not await is_user_active(user_a.id, previous_version)
    assert await is_user_active(user_a.id, user_a.security_version)
    assert old_token != create_user_token(user_a.id, user_a.security_version)
    file_id, token_user_id, token_version = verify_stream_token(file_token)
    assert file_id == 17 and token_user_id == user_a.id
    assert not await is_user_active(token_user_id, token_version)


@pytest.mark.asyncio
async def test_password_reset_advances_security_version_and_revokes_old_jwt(db, user_a, monkeypatch):
    previous_version = user_a.security_version or 1
    old_token = create_user_token(user_a.id, previous_version)
    reset_store = {}
    published = []

    class FakeRedis:
        async def get(self, key):
            return reset_store.get(key)

        async def delete(self, key):
            reset_store.pop(key, None)

        async def publish(self, channel, raw):
            assert not await is_user_active(user_a.id, previous_version)
            published.append(channel)

    monkeypatch.setattr(auth, "get_redis", lambda: FakeRedis())
    monkeypatch.setattr(events, "get_redis", lambda: FakeRedis())
    reset_store["pwdreset:tok:synthetic-reset-token"] = str(user_a.id)

    await auth.reset_password(
        ResetPassword(token="synthetic-reset-token", new_password="new-password-123"),
        Response(),
        db,
    )

    assert user_a.security_version == previous_version + 1
    assert not await is_user_active(user_a.id, previous_version)
    assert await is_user_active(user_a.id, user_a.security_version)
    assert old_token != create_user_token(user_a.id, user_a.security_version)
    assert published == [f"events:{user_a.id}"]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["profile_password", "email_change"])
async def test_credential_changes_notify_only_after_old_version_is_revoked(db, user_a, monkeypatch, operation):
    from starlette.requests import Request

    from app.core.security import hash_password
    from app.schemas import EmailChangeVerify, UpdateProfile
    from app.services.email.email_change import create_email_change_request

    previous_version = user_a.security_version
    notified = []

    async def notify(user_id):
        assert not await is_user_active(user_id, previous_version)
        notified.append(user_id)

    monkeypatch.setattr(events, "publish_auth_state_changed", notify)
    if operation == "profile_password":
        user_a.hashed_password = hash_password("old-test-password")
        await db.commit()
        await auth.update_profile(
            UpdateProfile(current_password="old-test-password", new_password="new-test-password"),
            Request({"type": "http", "scheme": "https", "path": "/api/v1/auth/profile", "headers": []}),
            Response(), user_a, db,
        )
    else:
        _, token = await create_email_change_request(db, user_a, "new@example.test")
        await db.commit()

        async def theme(*_args):
            return "light", "mist"

        monkeypatch.setattr(auth, "_email_preference_theme", theme)
        monkeypatch.setattr(auth.email_svc, "send_email_change_notice", lambda **_kwargs: None)
        await auth.verify_email_change(EmailChangeVerify(token=token), db)
    assert notified == [user_a.id]


@pytest.mark.asyncio
async def test_logout_remains_revoked_when_notification_publish_fails(db, user_a, monkeypatch):
    previous_version = user_a.security_version

    class UnavailableRedis:
        async def publish(self, *_args):
            raise ConnectionError("测试 Redis 不可用")

    monkeypatch.setattr(events, "get_redis", lambda: UnavailableRedis())
    assert await auth.logout(Response(), user_a, db) == {"ok": True}
    assert not await is_user_active(user_a.id, previous_version)


@pytest.mark.asyncio
async def test_admin_logout_invalidates_previously_issued_tokens(monkeypatch):
    from app.api.v1 import admin_auth

    class FakeRedis:
        version = 0

        async def get(self, _key):
            return str(self.version)

        async def incr(self, _key):
            self.version += 1
            return self.version

    redis = FakeRedis()
    monkeypatch.setattr(admin_auth, "get_redis", lambda: redis)
    await admin_auth.ensure_admin_token_current({"av": 0})

    await redis.incr(admin_auth.ADMIN_AUTH_VERSION_KEY)

    with pytest.raises(HTTPException) as exc:
        await admin_auth.ensure_admin_token_current({"av": 0})
    assert exc.value.status_code == 401
    await admin_auth.ensure_admin_token_current({"av": 1})
