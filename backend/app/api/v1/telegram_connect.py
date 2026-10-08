"""用户自带 Telegram Bot 的安全接入和 owner 身份绑定。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ownership import get_owned
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User, UserBot
from app.services.telegram_bot_api import TelegramBotApiError, call, validate_bot_token

router = APIRouter(prefix="/me/telegram/connect", tags=["telegram-connect"])


class TelegramTokenIn(BaseModel):
    token: str = Field(min_length=1, max_length=160)


async def _verify(token: str) -> dict:
    try:
        normalized = validate_bot_token(token)
    except ValueError as exc:
        raise HTTPException(400, "Telegram Bot Token 格式无效") from exc
    try:
        bot_info = await call(normalized, "getMe")
        platform_id = bot_info.get("id") if isinstance(bot_info, dict) else None
        if isinstance(platform_id, bool) or not isinstance(platform_id, int) or platform_id <= 0:
            raise HTTPException(502, "Telegram 未返回有效的 Bot 身份")
        webhook = await call(normalized, "getWebhookInfo")
    except TelegramBotApiError as exc:
        if exc.error_code in {401, 404}:
            raise HTTPException(400, "Telegram Bot Token 无效") from None
        raise HTTPException(502, "暂时无法验证 Telegram Bot，请稍后重试") from None
    if isinstance(webhook, dict) and str(webhook.get("url") or "").strip():
        raise HTTPException(409, "该 Bot 已配置 Webhook；请先在 Telegram 侧移除 Webhook 后再接入")
    return {"token": normalized, "info": bot_info}


def _bot_name(info: dict) -> str:
    username = str(info.get("username") or "").strip()
    if username:
        return f"@{username}"
    full_name = " ".join(str(info.get(key) or "").strip() for key in ("first_name", "last_name")).strip()
    return full_name or "我的 Telegram 机器人"


async def _touch(user_id) -> None:
    from app.core import events, redis as R
    await events.publish(user_id, "im_channels", operation="refresh")
    try:
        await R.get_redis().publish("im:gateway:reload", "1")
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("app.api.telegram_connect.reload_gateway", exc)


async def _lock_unique_keys(db: AsyncSession, *keys: str) -> None:
    """PostgreSQL advisory transaction locks close concurrent Bot-ID upsert races."""
    bind = db.get_bind()
    if bind.dialect.name != "postgresql":
        return
    for key in sorted(set(keys)):
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:key))"), {"key": f"telegram-userbot:{key}"}
        )


@router.post("")
async def connect(
    body: TelegramTokenIn,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    verified = await _verify(body.token)
    platform_id = str(verified["info"]["id"])
    await _lock_unique_keys(db, platform_id, str(current_user.id))
    owner_bot = (await db.execute(select(UserBot).where(
        UserBot.user_id == current_user.id, UserBot.platform == "telegram"
    ))).scalars().first()
    if owner_bot:
        raise HTTPException(409, "每个咕咕账号只能接入一个 Telegram Bot；请使用替换凭据")
    duplicate = (await db.execute(select(UserBot).where(
        UserBot.platform == "telegram", UserBot.app_id == platform_id
    ))).scalars().first()
    if duplicate:
        raise HTTPException(409, "这个 Telegram Bot 已关联其他咕咕账号")
    bot = UserBot(
        user_id=current_user.id,
        platform="telegram",
        name=_bot_name(verified["info"]),
        app_id=platform_id,
        app_secret=verified["token"],
        bot_platform_user_id=platform_id,
        enabled=True,
        group_chat_enabled=False,
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    await _touch(current_user.id)
    return {"id": bot.id, "platform": bot.platform, "name": bot.name, "app_id": bot.app_id, "enabled": bot.enabled}


@router.put("/{bot_id}")
async def replace_token(
    bot_id: int,
    body: TelegramTokenIn,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    bot = await get_owned(db, UserBot, bot_id, current_user.id)
    if not bot or bot.platform != "telegram":
        raise HTTPException(404, "Telegram 机器人不存在")
    verified = await _verify(body.token)
    platform_id = str(verified["info"]["id"])
    await _lock_unique_keys(db, platform_id)
    duplicate = (await db.execute(select(UserBot).where(
        UserBot.platform == "telegram", UserBot.app_id == platform_id, UserBot.id != bot.id
    ))).scalars().first()
    if duplicate:
        raise HTTPException(409, "这个 Telegram Bot 已关联其他咕咕账号")
    if platform_id != bot.app_id:
        # Bot 记录换绑到不同 Telegram Bot 时，旧 Bot 的 owner 绑定不能迁移；
        # 必须在新 Bot 私聊中重新完成显式绑定。
        bot.owner_platform_user_id = None
        bot.owner_bound_at = None
    bot.app_id = platform_id
    bot.bot_platform_user_id = platform_id
    bot.name = _bot_name(verified["info"])
    bot.app_secret = verified["token"]
    bot.enabled = True
    await db.commit()
    await db.refresh(bot)
    await _touch(current_user.id)
    return {"id": bot.id, "platform": bot.platform, "name": bot.name, "app_id": bot.app_id, "enabled": bot.enabled}


@router.post("/{bot_id}/binding-code")
async def create_binding_code(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    bot = await get_owned(db, UserBot, bot_id, current_user.id)
    if not bot or bot.platform != "telegram":
        raise HTTPException(404, "Telegram 机器人不存在")
    if bot.owner_platform_user_id:
        raise HTTPException(409, "Telegram owner 身份已经绑定")
    from app.services.im_identity import create_telegram_binding_code

    code, expires_in = await create_telegram_binding_code(bot.id, current_user.id)
    return {"code": code, "expires_in": expires_in}
