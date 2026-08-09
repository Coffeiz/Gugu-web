"""IM 身份与工具权限编排门面。

底层 Bot 绑定查询仍由 ``app.services.im_identity`` 负责；本模块只决定当前
PlatformMessage 是否需要做平台权限解析，以及失败时由调用方降级为 unknown。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional


DEFAULT_GROUP_TOOLS = ["web_search", "http_get", "image_search", "send_file"]


def _parse_bot_db_id(value: Optional[str]) -> Optional[int]:
    """把内部 Bot 数据库主键与平台 Bot 标识明确分开。"""
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class ImAccess:
    role: Optional[str] = None
    allowed_tool_names: Optional[List[str]] = None


def filter_tool_names(profile_tool_names: List[str], allowed_tool_names: Optional[List[str]]) -> List[str]:
    """按请求权限裁剪模型可见工具，保留旧有白名单顺序。"""
    if allowed_tool_names is None:
        return profile_tool_names
    return [name for name in allowed_tool_names if name in profile_tool_names]


def can_use_tool(name: str, allowed_tool_names: Optional[List[str]]) -> bool:
    """dispatch 层的第二道权限门；None 表示完整工具集。"""
    return allowed_tool_names is None or name in allowed_tool_names


async def resolve_access(
    platform: str,
    chat_type: Optional[str],
    channel_id: Optional[str],
    owner_user_id,
    platform_user_id: str,
) -> ImAccess:
    """解析当前 IM 发言人的角色和工具白名单。

    当前只有 QQ 的 C2C/群聊接入了 Bot owner 权限；其他平台保留中性结果，
    不在这里擅自把平台身份升级成 owner。
    """
    if platform != "qq":
        # 飞书连接时会保存 owner open_id；群聊也必须按 Bot 作用域比较，不能
        # 因为 payload 带有 owner_user_id 就把任意群成员升级为 owner。微信当前
        # 只提供个人 Bot 私聊入口，群聊没有可验证 owner 身份时固定降级 unknown。
        if chat_type == "c2c":
            return ImAccess("owner", None)
        if chat_type == "group":
            import app.db.session as db_session
            from app.models import UserBot
            from app.services.im_identity import normalize_group_allowed_tools
            if db_session._engine is None:
                db_session._build_engine()
            bot_db_id = _parse_bot_db_id(channel_id)
            if bot_db_id is None:
                return ImAccess("unknown", list(DEFAULT_GROUP_TOOLS))
            async with db_session._SessionLocal() as db:
                bot = await db.get(UserBot, bot_db_id)
            if bot and bot.platform == platform and bot.user_id == owner_user_id:
                if bot.owner_platform_user_id and bot.owner_platform_user_id == platform_user_id:
                    return ImAccess("owner", None)
                return ImAccess("member", normalize_group_allowed_tools(bot.group_allowed_tools))
            return ImAccess("unknown", list(DEFAULT_GROUP_TOOLS))
        return ImAccess("unknown", list(DEFAULT_GROUP_TOOLS))
    if chat_type not in {"group", "c2c"}:
        return ImAccess("unknown", list(DEFAULT_GROUP_TOOLS))

    import app.db.session as db_session
    from app.services.im_identity import resolve_qq_group_access

    if db_session._engine is None:
        db_session._build_engine()
    bot_db_id = _parse_bot_db_id(channel_id)
    if bot_db_id is None:
        return ImAccess("unknown", list(DEFAULT_GROUP_TOOLS))
    async with db_session._SessionLocal() as db:
        access = await resolve_qq_group_access(
            db,
            bot_db_id,
            owner_user_id,
            platform_user_id,
        )
    return ImAccess(access.role, access.allowed_tool_names)


async def resolve_group_policy(bot_id: str) -> tuple[bool, bool, bool]:
    """读取 QQ 群消息策略：启用、是否要求 @、是否记录未 @ 消息。"""
    import app.db.session as db_session
    from app.models import UserBot

    if db_session._engine is None:
        db_session._build_engine()
    bot_db_id = _parse_bot_db_id(bot_id)
    if bot_db_id is None:
        return False, True, False
    async with db_session._SessionLocal() as db:
        bot = await db.get(UserBot, bot_db_id)
        if not bot:
            return False, True, False
        return bot.group_chat_enabled, bot.group_requires_at, (
            bot.group_read_enabled if bot.group_requires_at else False
        )
