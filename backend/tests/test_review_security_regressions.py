"""发布审查回归：匿名隐私、验证码事务与脚本执行确认边界。"""
from unittest.mock import AsyncMock

import fakeredis.aioredis
import pytest
from starlette.requests import Request
from starlette.responses import Response

from app.api.v1 import auth
from app.services import registration_verification as codes
from agent.security.shell_policy import ShellRisk, classify_command


def request():
    return Request({"type": "http", "method": "POST", "path": "/auth", "headers": [],
                    "scheme": "https", "server": ("example.test", 443), "client": ("test", 1)})


@pytest.mark.asyncio
@pytest.mark.parametrize("cooldown", [False, True])
async def test_forgot_password_never_discloses_email_or_account_presence(db, user_a, monkeypatch, cooldown):
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(auth, "get_redis", lambda: redis)
    monkeypatch.setattr(auth, "rate_limit", AsyncMock())
    monkeypatch.setattr(auth, "is_system_email_available", lambda: True)
    monkeypatch.setattr(auth, "run_in_threadpool", AsyncMock(return_value=True))
    monkeypatch.setattr(auth, "get_user_email_preferences", AsyncMock(return_value={}))
    if cooldown:
        await redis.set(f"pwdreset:cd:{user_a.email.lower()}", "1")
    known = await auth.forgot_password(auth.ForgotPassword(email=user_a.username), request(), db)
    unknown = await auth.forgot_password(auth.ForgotPassword(email="synthetic-missing"), request(), db)
    assert known == unknown == auth._RESET_GENERIC
    assert "email" not in known
    await redis.aclose()


@pytest.mark.asyncio
async def test_registration_commit_failure_restores_code_without_extending_validity(db, monkeypatch):
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    email = "synthetic@example.test"
    await codes.reserve_registration_code(redis, email, "123456")
    before = await codes.registration_code_ttl(redis, email)
    monkeypatch.setattr(auth, "get_redis", lambda: redis)
    monkeypatch.setattr(auth, "rate_limit", AsyncMock())
    monkeypatch.setattr(auth, "is_system_email_available", lambda: True)
    monkeypatch.setattr(db, "commit", AsyncMock(side_effect=RuntimeError("合成提交失败")))
    with pytest.raises(RuntimeError, match="合成提交失败"):
        await auth.register(auth.UserRegister(username="synthetic", email=email, password="Synthetic123!",
                                             verification_code="123456"), request(), Response(), db)
    assert await codes.verify_registration_code(redis, email, "123456")
    assert 0 < await codes.registration_code_ttl(redis, email) <= before
    await redis.aclose()


@pytest.mark.asyncio
async def test_registration_conflict_does_not_consume_code(db, user_a, monkeypatch):
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    email = "another@example.test"
    await codes.reserve_registration_code(redis, email, "123456")
    monkeypatch.setattr(auth, "get_redis", lambda: redis)
    monkeypatch.setattr(auth, "rate_limit", AsyncMock())
    monkeypatch.setattr(auth, "is_system_email_available", lambda: True)
    with pytest.raises(auth.HTTPException) as failure:
        await auth.register(auth.UserRegister(username=user_a.username, email=email, password="Synthetic123!",
                                             verification_code="123456"), request(), Response(), db)
    assert failure.value.status_code == 400
    assert await codes.verify_registration_code(redis, email, "123456")
    assert await codes.consume_registration_code(redis, email, "123456")
    assert not await codes.consume_registration_code(redis, email, "123456")
    await redis.aclose()


@pytest.mark.parametrize("command", [
    "python3 cleanup.py", "python3 -c 'import shutil; shutil.rmtree(\"folder\")'",
    "/usr/bin/python3.12 cleanup.py", "env node app.js", "bash deploy.sh", "./cleanup.sh",
    "pnpm run cleanup", "make cleanup",
])
def test_arbitrary_code_execution_is_dangerous_before_dispatch(command):
    assert classify_command(command) is ShellRisk.DANGEROUS
