import pytest
from fastapi import HTTPException
from starlette.responses import Response

from app.api.v1 import auth
from app.core.security import create_stream_token, create_user_token, is_user_active, verify_stream_token
from app.schemas import ResetPassword


@pytest.mark.asyncio
async def test_logout_revokes_old_user_jwt_but_new_version_remains_valid(db, user_a):
    previous_version = user_a.security_version or 1
    old_token = create_user_token(user_a.id, previous_version)
    file_token = create_stream_token(17, user_a.id, security_version=previous_version)

    await auth.logout(Response(), user_a.id, db)

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

    class FakeRedis:
        async def get(self, key):
            return reset_store.get(key)

        async def delete(self, key):
            reset_store.pop(key, None)

    monkeypatch.setattr(auth, "get_redis", lambda: FakeRedis())
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
