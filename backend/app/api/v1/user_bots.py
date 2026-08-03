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
from app.core.security import get_current_user
from app.core.ownership import get_owned
from app.db.session import get_db
from app.models import User, UserBot

router = APIRouter(prefix="/me/bots", tags=["user-bots"])


def _mask(s: str) -> str:
    if not s:
        return ""
    return s[:3] + "•" * 6 + s[-2:] if len(s) > 6 else "•" * 6


def _out(b: UserBot) -> dict:
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
        "group_allowed_tools": b.group_allowed_tools or ["web_search"],
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
            UserBot.platform == "qqbot",
        )
    )).scalars().first()
    if existing:
        raise HTTPException(409, "每个咕咕账号只能绑定一个 QQ 机器人")
    bot = UserBot(
        user_id=current_user.id, platform="qqbot",
        name=body.name or "我的 QQ 机器人",
        app_id=body.app_id.strip(), app_secret=body.app_secret.strip(),
        sandbox=body.sandbox, enabled=body.enabled,
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    await _touch_supervisor()
    return _out(bot)


class BotUpdate(BaseModel):
    name: str | None = None
    app_id: str | None = None
    app_secret: str | None = None
    sandbox: bool | None = None
    enabled: bool | None = None
    group_chat_enabled: bool | None = None
    group_requires_at: bool | None = None
    group_read_enabled: bool | None = None
    group_allowed_tools: list[str] | None = None


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
    if body.group_allowed_tools is not None:
        unsupported = set(body.group_allowed_tools) - {"web_search", "group_context_search"}
        if unsupported:
            raise HTTPException(400, "当前群成员只支持网页搜索和当前群上下文搜索")
        bot.group_allowed_tools = list(dict.fromkeys(body.group_allowed_tools))
    await db.commit()
    await db.refresh(bot)
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
    await _touch_supervisor()
