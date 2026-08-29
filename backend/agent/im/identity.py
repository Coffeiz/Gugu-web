"""IM 身份解析门面。

Gateway 只提供平台事件元数据；这里把 Bot 所属的 Gugu 账号和当前消息的
称呼字段整理成 Agent 入口需要的值。平台身份权限仍由 permissions 模块解析，
避免把 display name 当成身份主键。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional
from uuid import UUID

from app.core.redaction import diag_log


@dataclass(frozen=True)
class ImIdentity:
    """当前 IM 消息绑定到的 Gugu 账号。"""

    user_id: Any
    user_name: str


async def remember_bot_platform_user_id(bot_id: str, platform_user_id: str) -> None:
    """在 IM 业务层记录当前 Bot 的平台身份，不让 Gateway 直接写数据库。"""
    if not bot_id or not platform_user_id:
        return
    try:
        numeric_bot_id = int(bot_id)
    except (TypeError, ValueError):
        return
    import app.db.session as db_session
    if db_session._engine is None:
        db_session._build_engine()
    from app.models import UserBot

    try:
        async with db_session._SessionLocal() as db:
            bot = await db.get(UserBot, numeric_bot_id)
            if not bot or bot.bot_platform_user_id == platform_user_id:
                return
            bot.bot_platform_user_id = platform_user_id
            await db.commit()
    except Exception as exc:
        # 身份回写是旁路同步，失败不能丢弃当前 IM 消息；原始异常只进诊断出口。
        diag_log("agent.im.identity.remember_bot_platform_user_id", exc)


async def resolve_owner_account(payload: dict) -> Optional[ImIdentity]:
    """根据 Gateway 提供的 Bot owner 解析 Gugu 账号。

    当前 BYO Bot 的 owner_user_id 是可靠归属字段；platform_user_id 只代表
    当前发言人，不能用于反查 Gugu 用户或跨 Bot 合并身份。
    """
    owner = payload.get("owner_user_id")
    if not owner:
        return None

    import app.db.session as db_session
    if db_session._engine is None:
        db_session._build_engine()
    from app.models import User

    try:
        owner_id = owner if isinstance(owner, UUID) else UUID(str(owner))
    except (TypeError, ValueError, AttributeError):
        return None

    async with db_session._SessionLocal() as db:
        user = await db.get(User, owner_id)
    if not user:
        return None
    # 网关 payload 中的 owner_user_id 通常是字符串；后续命令会和 ORM
    # 实体的 UUID 做 Python 层归属比较，因此必须返回数据库中的规范主键。
    return ImIdentity(user.id, user.display_name or "")


def display_name_for_message(identity: ImIdentity, payload: dict, role: Optional[str]) -> str:
    """为当前请求选择称呼；member/unknown 不注入 owner 账号名。"""
    if role in {"member", "unknown"}:
        return payload.get("platform_user_name") or "这位群友"
    return identity.user_name
