"""IM 平台身份绑定服务。"""

import hashlib
import hmac
import json
import secrets
from typing import List
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import redis as R
from app.core.config import get_settings
from app.core.tz import now_utc
from app.models import UserBot

DEFAULT_GROUP_ALLOWED_TOOLS: List[str] = ["web_search", "http_get", "image_search", "inspect_images", "send_file"]


def normalize_group_allowed_tools(configured: object) -> List[str]:
    """兼容旧白名单：已授权联网搜索的机器人同时获得网页阅读能力。"""
    if not isinstance(configured, list):
        return list(DEFAULT_GROUP_ALLOWED_TOOLS)
    allowed = [str(name) for name in configured if isinstance(name, str)]
    if "web_search" in allowed and "http_get" not in allowed:
        allowed.insert(allowed.index("web_search") + 1, "http_get")
    # 图片读取是图片搜索的子能力；旧白名单只授权 image_search 时自动补上，避免升级后群成员看不到新工具。
    if "image_search" in allowed and "inspect_images" not in allowed:
        allowed.insert(allowed.index("image_search") + 1, "inspect_images")
    return allowed
QQ_BINDING_CODE_TTL = 600
QQ_BINDING_CODE_MAX_ATTEMPTS = 5


def _qq_binding_key(bot_id: int) -> str:
    return f"im:qq-binding:{bot_id}"


def _qq_binding_attempts_key(bot_id: int, challenge_id: str, platform_user_id: str) -> str:
    sender_hash = hashlib.sha256(platform_user_id.encode("utf-8")).hexdigest()[:16]
    return f"im:qq-binding-attempts:{bot_id}:{challenge_id}:{sender_hash}"


def _hash_qq_binding_code(bot_id: int, user_id: UUID, code: str) -> str:
    message = f"{bot_id}:{user_id}:{code}".encode("utf-8")
    secret = get_settings().secret_key.encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


async def create_qq_binding_code(bot_id: int, owner_user_id: UUID) -> tuple[str, int]:
    """为当前用户的 QQ Bot 创建一次性绑定码，明文只返回给已登录网页。"""
    code = f"{secrets.randbelow(1_000_000):06d}"
    payload = {
        "user_id": str(owner_user_id),
        "code_hash": _hash_qq_binding_code(bot_id, owner_user_id, code),
        "challenge_id": secrets.token_urlsafe(12),
    }
    redis = R.get_redis()
    await redis.set(_qq_binding_key(bot_id), json.dumps(payload), ex=QQ_BINDING_CODE_TTL)
    return code, QQ_BINDING_CODE_TTL


async def consume_qq_binding_code(
    bot_id: int,
    owner_user_id: UUID,
    platform_user_id: str,
    code: str,
) -> bool:
    """校验并消费 QQ 绑定码，成功后只允许占用空 owner 绑定。"""
    normalized = "".join(str(code).split())
    if not platform_user_id or len(normalized) != 6 or not normalized.isdigit():
        return False

    # QQ 可能重复投递同一条 C2C 消息。第一次消费成功后验证码会被删除，
    # 重试不能再显示“无效或已过期”；同一 Bot、同一 QQ 身份的重复绑定应保持幂等。
    import app.db.session as db_session
    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        already_bound = (
            await db.execute(
                select(UserBot).where(
                    UserBot.id == bot_id,
                    UserBot.user_id == owner_user_id,
                    UserBot.platform == "qq",
                    UserBot.owner_platform_user_id == platform_user_id,
                )
            )
        ).scalars().first()
    if already_bound:
        return True

    redis = R.get_redis()
    raw = await redis.get(_qq_binding_key(bot_id))
    try:
        payload = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        payload = {}
    if payload.get("user_id") != str(owner_user_id):
        return False
    challenge_id = str(payload.get("challenge_id") or "")
    if not challenge_id:
        return False
    attempts_key = _qq_binding_attempts_key(bot_id, challenge_id, platform_user_id)
    attempts = await redis.incr(attempts_key)
    if attempts == 1:
        await redis.expire(attempts_key, QQ_BINDING_CODE_TTL)
    if attempts > QQ_BINDING_CODE_MAX_ATTEMPTS:
        return False
    expected = _hash_qq_binding_code(bot_id, owner_user_id, normalized)
    if not hmac.compare_digest(str(payload.get("code_hash") or ""), expected):
        return False

    result = await redis.get(_qq_binding_key(bot_id))
    if not result:
        return False
    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        update_result = await db.execute(
            update(UserBot)
            .where(
                UserBot.id == bot_id,
                UserBot.user_id == owner_user_id,
                UserBot.platform == "qq",
                UserBot.owner_platform_user_id.is_(None),
            )
            .values(
                owner_platform_user_id=platform_user_id,
                owner_bound_at=now_utc(),
            )
        )
        await db.commit()
    if update_result.rowcount != 1:
        await redis.delete(_qq_binding_key(bot_id))
        return False
    await redis.delete(_qq_binding_key(bot_id), attempts_key)
    return True


async def bind_qq_owner_if_unbound(
    bot_id: int,
    owner_user_id: UUID,
    platform_user_id: str,
) -> bool:
    """首次收到 QQ 私聊时绑定当前 QQ 用户为该 Bot 的 owner。

    QQ 扫码授权只返回 Bot 凭据，不会返回发起私聊用户的 openid；因此首次
    C2C 消息需要补齐 owner 身份。使用带 ``IS NULL`` 的原子更新，避免并发
    首次消息把 owner 绑定到不同用户。
    """
    if not platform_user_id:
        return False
    import app.db.session as db_session

    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        result = await db.execute(
            update(UserBot)
            .where(
                UserBot.id == bot_id,
                UserBot.user_id == owner_user_id,
                UserBot.platform == "qq",
                UserBot.owner_platform_user_id.is_(None),
            )
            .values(
                owner_platform_user_id=platform_user_id,
                owner_bound_at=now_utc(),
            )
        )
        await db.commit()
    return result.rowcount == 1


class QQGroupAccess:
    """当前 QQ Bot 内的一条群聊权限快照。"""

    def __init__(self, role: str, allowed_tool_names: list[str] | None):
        self.role = role
        self.allowed_tool_names = allowed_tool_names


async def resolve_qq_group_access(db: AsyncSession, bot_id: int,
                                  owner_user_id: UUID,
                                  platform_user_id: str) -> QQGroupAccess:
    """按当前 Bot 的 owner 平台身份解析群成员权限。

    这是 Bot 作用域内的比较，不尝试跨 Bot 合并 QQ 身份。查不到 Bot 或 owner
    时按 unknown 处理，仍允许普通聊天，但只能拿默认白名单工具。
    """
    bot = (await db.execute(
        select(UserBot).where(
            UserBot.id == bot_id,
            UserBot.user_id == owner_user_id,
            UserBot.platform == "qq",
        )
    )).scalars().first()
    if not bot or not bot.owner_platform_user_id:
        return QQGroupAccess("unknown", list(DEFAULT_GROUP_ALLOWED_TOOLS))
    if bot.owner_platform_user_id == platform_user_id:
        return QQGroupAccess("owner", None)
    return QQGroupAccess("member", normalize_group_allowed_tools(bot.group_allowed_tools))
