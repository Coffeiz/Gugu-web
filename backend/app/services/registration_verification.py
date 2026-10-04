"""匿名注册邮箱验证码的短期 Redis 状态。"""

from __future__ import annotations

import hashlib
import hmac
import secrets

from app.core.config import get_settings


REGISTRATION_CODE_TTL = 10 * 60
REGISTRATION_CODE_COOLDOWN = 60
REGISTRATION_CODE_MAX_ATTEMPTS = 5


def _email_key(email: str) -> str:
    return hashlib.sha256(email.encode("utf-8")).hexdigest()


def _code_digest(email: str, code: str) -> str:
    secret = get_settings().secret_key.encode("utf-8")
    message = f"{email}\0{code}".encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def create_registration_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


async def reserve_registration_code(redis, email: str, code: str) -> bool:
    """按邮箱设置发送冷却并保存验证码摘要；返回 False 表示仍在冷却期。"""
    key = _email_key(email)
    reserved = await redis.set(
        f"regverify:cooldown:{key}", "1", ex=REGISTRATION_CODE_COOLDOWN, nx=True,
    )
    if not reserved:
        return False
    try:
        await redis.set(
            f"regverify:code:{key}", _code_digest(email, code), ex=REGISTRATION_CODE_TTL,
        )
        await redis.delete(f"regverify:attempts:{key}")
    except Exception:
        await redis.delete(f"regverify:cooldown:{key}")
        raise
    return True


async def clear_registration_code(redis, email: str) -> None:
    key = _email_key(email)
    await redis.delete(
        f"regverify:code:{key}",
        f"regverify:cooldown:{key}",
        f"regverify:attempts:{key}",
    )


async def consume_registration_code(redis, email: str, code: str) -> bool:
    """限制邮箱验证码猜测次数，并在成功校验时原子删除一次性验证码。"""
    key = _email_key(email)
    attempts_key = f"regverify:attempts:{key}"
    attempts = await redis.incr(attempts_key)
    if attempts == 1:
        await redis.expire(attempts_key, REGISTRATION_CODE_TTL)
    if attempts > REGISTRATION_CODE_MAX_ATTEMPTS:
        return False

    code_key = f"regverify:code:{key}"
    expected = await redis.get(code_key)
    if not expected or not hmac.compare_digest(expected, _code_digest(email, code)):
        return False
    return await redis.delete(code_key) == 1
