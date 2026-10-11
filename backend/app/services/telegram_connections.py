"""Telegram Bot 凭据关联的持久化操作。"""
from __future__ import annotations

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ownership import get_owned
from app.models import UserBot


async def lock_telegram_unique_keys(db: AsyncSession, *keys: str) -> None:
    """串行化按 Bot ID 和用户 ID 建立关联的并发写入。"""
    bind = db.get_bind()
    if bind.dialect.name != "postgresql":
        return
    for key in sorted(set(keys)):
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
            {"key": f"telegram-userbot:{key}"},
        )


async def get_owned_telegram_bot(db: AsyncSession, bot_id: int, user_id) -> UserBot | None:
    bot = await get_owned(db, UserBot, bot_id, user_id)
    return bot if bot and bot.platform == "telegram" else None


async def get_telegram_bot_for_user(db: AsyncSession, user_id) -> UserBot | None:
    return await db.scalar(select(UserBot).where(
        UserBot.user_id == user_id,
        UserBot.platform == "telegram",
    ))


async def find_telegram_bot_by_platform_id(
    db: AsyncSession,
    platform_id: str,
    *,
    excluding_bot_id: int | None = None,
) -> UserBot | None:
    query = select(UserBot).where(
        UserBot.platform == "telegram",
        UserBot.app_id == platform_id,
    )
    if excluding_bot_id is not None:
        query = query.where(UserBot.id != excluding_bot_id)
    return await db.scalar(query)


async def create_telegram_bot(
    db: AsyncSession,
    *,
    user_id,
    name: str,
    platform_id: str,
    token: str,
) -> UserBot:
    bot = UserBot(
        user_id=user_id,
        platform="telegram",
        name=name,
        app_id=platform_id,
        app_secret=token,
        bot_platform_user_id=platform_id,
        enabled=True,
        group_chat_enabled=False,
    )
    db.add(bot)
    return bot
