"""用户自带机器人（BYO）：每个用户管理自己的 QQ bot 凭据。

与 Admin 的共享频道（/admin/agent/bots，飞书用）不同——这里是**用户级**：
每人填自己在 q.qq.com 创建的 bot 的 AppID/AppSecret，咕咕的 supervisor 据此
为该用户起一条独立 QQ 网关。bot 收到的消息天然归属该用户，无需再做绑定。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import redis as R
from app.core.ownership import get_owned
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User, UserBot
from app.services.im_identity import normalize_group_allowed_tools

router = APIRouter(prefix="/me/bots", tags=["user-bots"])


def _mask(s: str) -> str:
    if not s:
        return ""
    return s[:3] + "•" * 6 + s[-2:] if len(s) > 6 else "•" * 6


def _out(b: UserBot) -> dict:
    response_mode = "record_only" if b.group_read_enabled and b.group_requires_at else "reply_mentions" if b.group_requires_at else "reply_all"
    return {
        "id": b.id,
        "platform": b.platform,
        "name": b.name,
        "app_id": b.app_id,
        "app_secret": _mask(b.app_secret),
        "sandbox": b.sandbox,
        "enabled": b.enabled,
        "group_chat_enabled": b.group_chat_enabled,
        "group_requires_at": b.group_requires_at,
        "group_read_enabled": b.group_read_enabled,
        "group_response_mode": response_mode,
        "group_allowed_tools": normalize_group_allowed_tools(b.group_allowed_tools),
        "group_message_format": b.group_message_format or "compat",
        "private_message_format": b.private_message_format or "smart",
        "private_streaming_enabled": b.private_streaming_enabled,
        "owner_bound": bool(b.owner_platform_user_id),
    }


async def _touch_supervisor():
    """通知 supervisor 立即重扫（不必等轮询周期）。失败无所谓，下轮也会同步。"""
    try:
        await R.get_redis().publish("im:supervisor:reload", "1")
    except Exception:
        pass


@router.get("")
async def list_my_bots(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(
        select(UserBot).where(UserBot.user_id == current_user.id).order_by(UserBot.id)
    )).scalars().all()
    return {"items": [_out(b) for b in rows]}


class BotIn(BaseModel):
    name: str = ""
    app_id: str = ""
    app_secret: str = ""
    sandbox: bool = False
    enabled: bool = True


@router.post("")
async def create_my_bot(
    body: BotIn,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not body.app_id or not body.app_secret:
        raise HTTPException(400, "请填写 AppID 和 AppSecret")
    existing = (await db.execute(
        select(UserBot).where(
            UserBot.user_id == current_user.id,
            UserBot.platform == "qq",
        )
    )).scalars().first()
    if existing:
        raise HTTPException(409, "每个咕咕账号只能绑定一个 QQ 机器人")
    bot = UserBot(
        user_id=current_user.id, platform="qq",
        name=body.name or "我的 QQ 机器人",
        app_id=body.app_id.strip(), app_secret=body.app_secret.strip(),
        sandbox=body.sandbox, enabled=body.enabled,
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    from app.core import events
    await events.bump_context_revision(current_user.id, "im_channels")
    await _touch_supervisor()
    return _out(bot)


@router.post("/{bot_id}/qq-binding-code")
async def create_qq_binding_code(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """为尚未绑定 QQ 身份的 Bot 生成一次性绑定码。"""
    bot = await get_owned(db, UserBot, bot_id, current_user.id)
    if not bot or bot.platform != "qq":
        raise HTTPException(404, "机器人不存在")
    if bot.owner_platform_user_id:
        raise HTTPException(409, "QQ 身份已经绑定")
    from app.services.im_identity import create_qq_binding_code as create_code

    code, expires_in = await create_code(bot.id, current_user.id)
    return {"code": code, "expires_in": expires_in}


class BotUpdate(BaseModel):
    name: str | None = None
    app_id: str | None = None
    app_secret: str | None = None
    sandbox: bool | None = None
    enabled: bool | None = None
    group_chat_enabled: bool | None = None
    group_requires_at: bool | None = None
    group_read_enabled: bool | None = None
    group_response_mode: str | None = None
    group_allowed_tools: list[str] | None = None
    group_message_format: str | None = None
    private_message_format: str | None = None
    private_streaming_enabled: bool | None = None


@router.put("/{bot_id}")
async def update_my_bot(
    bot_id: int,
    body: BotUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    bot = await get_owned(db, UserBot, bot_id, current_user.id)
    if not bot:
        raise HTTPException(404, "机器人不存在")
    if body.name is not None:
        bot.name = body.name
    if body.app_id is not None:
        bot.app_id = body.app_id.strip()
    # 空 / 打码值不覆盖已存 secret
    if body.app_secret and "•" not in body.app_secret:
        bot.app_secret = body.app_secret.strip()
    if body.sandbox is not None:
        bot.sandbox = body.sandbox
    if body.enabled is not None:
        bot.enabled = body.enabled
    if body.group_chat_enabled is not None:
        bot.group_chat_enabled = body.group_chat_enabled
    if body.group_requires_at is not None:
        bot.group_requires_at = body.group_requires_at
    if body.group_read_enabled is not None:
        bot.group_read_enabled = body.group_read_enabled
    if body.group_response_mode is not None:
        if body.group_response_mode not in {"reply_all", "reply_mentions", "record_only"}:
            raise HTTPException(400, "无效的群聊回应方式")
        bot.group_requires_at = body.group_response_mode != "reply_all"
        bot.group_read_enabled = body.group_response_mode == "record_only"
    # 普通群聊模式默认接收并回复所有消息；只有显式选择静默记录时才保存后静默。
    if bot.group_requires_at is False and body.group_response_mode is None:
        bot.group_read_enabled = False
    if body.group_allowed_tools is not None:
        unsupported = set(body.group_allowed_tools) - {"web_search", "http_get", "image_search", "inspect_images", "send_file", "group_context_search"}
        if unsupported:
            raise HTTPException(400, "当前群成员只支持网页搜索、网页阅读、图片搜索、发网络图片和当前群上下文搜索")
        bot.group_allowed_tools = list(dict.fromkeys(body.group_allowed_tools))
    for field in ("group_message_format", "private_message_format"):
        value = getattr(body, field)
        if value is not None:
            if value not in {"compat", "smart", "markdown"}:
                raise HTTPException(400, "无效的 QQ 消息格式")
            setattr(bot, field, value)
    if body.private_streaming_enabled is not None:
        bot.private_streaming_enabled = body.private_streaming_enabled
    await db.commit()
    await db.refresh(bot)
    from app.core import events
    await events.bump_context_revision(current_user.id, "im_channels")
    await _touch_supervisor()
    return _out(bot)


@router.delete("/{bot_id}", status_code=204)
async def delete_my_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    bot = await get_owned(db, UserBot, bot_id, current_user.id)
    if not bot:
        raise HTTPException(404, "机器人不存在")
    platform = bot.platform
    await db.delete(bot)
    await db.commit()
    # 解绑即清可触达地址（保险一）→ 错勾该平台也不会发给旧账号
    try:
        from app import scheduled_tasks as ST
        await ST.clear_imreach(current_user.id, platform)
    except Exception:
        pass
    from app.core import events
    await events.bump_context_revision(current_user.id, "im_channels")
    await _touch_supervisor()
