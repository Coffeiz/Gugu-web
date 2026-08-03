"""IM 身份与工具权限编排门面。

底层 Bot 绑定查询仍由 ``app.services.im_identity`` 负责；本模块只决定当前
PlatformMessage 是否需要做平台权限解析，以及失败时由调用方降级为 unknown。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional


DEFAULT_GROUP_TOOLS = ["web_search"]


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
    if platform != "qqbot":
        # 当前飞书/微信 Bot 是单 owner 私聊入口；群聊还没有可靠的 owner
        # platform id 字段，先按 unknown 处理，不能因为 role 缺失而加载 owner 上下文。
        if chat_type == "c2c":
            return ImAccess("owner", None)
        if chat_type == "group":
            return ImAccess("unknown", list(DEFAULT_GROUP_TOOLS))
        return ImAccess("unknown", list(DEFAULT_GROUP_TOOLS))
    if chat_type not in {"group", "c2c"}:
        return ImAccess("unknown", list(DEFAULT_GROUP_TOOLS))

    import app.db.session as db_session
    from app.services.im_identity import resolve_qq_group_access

    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        access = await resolve_qq_group_access(
            db,
            int(channel_id or 0),
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
    async with db_session._SessionLocal() as db:
        bot = await db.get(UserBot, int(bot_id))
        if not bot:
            return False, True, False
        return bot.group_chat_enabled, bot.group_requires_at, bot.group_read_enabled
