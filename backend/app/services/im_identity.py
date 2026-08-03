"""IM 平台身份绑定服务。"""

from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.models import UserBot

DEFAULT_GROUP_ALLOWED_TOOLS = ["web_search"]


class QQGroupAccess:
    """当前 QQ Bot 内的一条群聊权限快照。"""

    def __init__(self, role: str, allowed_tool_names: list[str] | None):
        self.role = role
        self.allowed_tool_names = allowed_tool_names


async def bind_qq_owner_if_empty(
    db: AsyncSession,
    bot_id: int,
    owner_user_id: UUID,
    platform_user_id: str,
) -> bool:
    """仅在 Bot 尚未绑定 owner 时写入 QQ 身份，返回本次是否成功占用绑定。"""
    if not platform_user_id:
        return False
    result = await db.execute(
        update(UserBot)
        .where(
            UserBot.id == bot_id,
            UserBot.user_id == owner_user_id,
            UserBot.platform == "qqbot",
            UserBot.owner_platform_user_id.is_(None),
        )
        .values(
            owner_platform_user_id=platform_user_id,
            owner_bound_at=now_utc(),
        )
    )
    await db.commit()
    return result.rowcount == 1


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
            UserBot.platform == "qqbot",
        )
    )).scalars().first()
    if not bot or not bot.owner_platform_user_id:
        return QQGroupAccess("unknown", list(DEFAULT_GROUP_ALLOWED_TOOLS))
    if bot.owner_platform_user_id == platform_user_id:
        return QQGroupAccess("owner", None)
    configured = bot.group_allowed_tools
    allowed = configured if isinstance(configured, list) else DEFAULT_GROUP_ALLOWED_TOOLS
    return QQGroupAccess("member", [str(name) for name in allowed if isinstance(name, str)])
