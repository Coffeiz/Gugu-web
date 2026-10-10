"""IM 身份与工具权限编排门面。

底层 Bot 绑定查询仍由 ``app.services.im_identity`` 负责；本模块只决定当前
PlatformMessage 是否需要做平台权限解析，以及失败时由调用方降级为 unknown。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional


DEFAULT_GROUP_TOOLS = ["web_search", "http_get", "image_search", "read_file", "send_file"]

# 纯时间查询不读取用户数据，也不产生外部副作用；它属于系统 utility，
# 不应因为群成员的业务工具白名单而无法发现或执行。
SAFE_ALWAYS_ALLOWED_TOOLS = frozenset({"get_current_time"})
# 固定 Adapter 和 Skill 生命周期入口只负责发现、委派或维护用户的 Prompt Skill；
# 业务工具的实际调用仍会在 call_tool 的内层 dispatch 再走一次白名单校验。
FIXED_ADAPTER_TOOLS = frozenset({"call_tool", "get_tool_schema", "use_skill", "ask_user"})
SKILL_MANAGEMENT_TOOLS = frozenset({"list_skills", "create_skill", "update_skill", "delete_skill"})


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


def filter_tool_names(system_tool_names: List[str], allowed_tool_names: Optional[List[str]]) -> List[str]:
    """按请求权限裁剪模型可见工具，保留白名单顺序。"""
    if allowed_tool_names is None:
        return system_tool_names
    result = [name for name in allowed_tool_names if name in system_tool_names]
    for name in system_tool_names:
        if name in SAFE_ALWAYS_ALLOWED_TOOLS and name not in result:
            result.append(name)
    return result


def can_use_tool(
    name: str,
    allowed_tool_names: Optional[List[str]],
    *,
    im_role: str | None = None,
    platform: str | None = None,
) -> bool:
    """dispatch 层的第二道权限门；Skill 管理仅网页用户和已认证 owner 可用。"""
    if name == "present_file" and platform:
        return False
    if name in SKILL_MANAGEMENT_TOOLS:
        return im_role in {None, "owner"}
    return (
        name in SAFE_ALWAYS_ALLOWED_TOOLS
        or name in FIXED_ADAPTER_TOOLS
        or allowed_tool_names is None
        or name in allowed_tool_names
    )


async def _resolve_telegram_access(
    chat_type: Optional[str],
    channel_id: Optional[str],
    owner_user_id,
    platform_user_id: str,
) -> ImAccess:
    if chat_type not in {"group", "c2c"}:
        return ImAccess("unknown", list(DEFAULT_GROUP_TOOLS))
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
    if not bot or bot.platform != "telegram" or bot.user_id != owner_user_id:
        return ImAccess("unknown", list(DEFAULT_GROUP_TOOLS))
    if platform_user_id and bot.owner_platform_user_id == platform_user_id:
        return ImAccess("owner", None)
    if chat_type == "group" and platform_user_id:
        return ImAccess("member", normalize_group_allowed_tools(bot.group_allowed_tools))
    return ImAccess("unknown", list(DEFAULT_GROUP_TOOLS))


async def resolve_access(
    platform: str,
    chat_type: Optional[str],
    channel_id: Optional[str],
    owner_user_id,
    platform_user_id: str,
) -> ImAccess:
    """解析当前 IM 发言人的角色和工具白名单。

    QQ 与 Telegram 通过各自 Bot 作用域内的平台 ID 确认 owner；其他平台保留
    既有中性/平台专属行为，不在这里擅自把未验证的平台身份升级成 owner。
    """
    if platform == "telegram":
        return await _resolve_telegram_access(
            chat_type, channel_id, owner_user_id, platform_user_id
        )

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


async def resolve_group_owner_memory(actor, bot_id: str) -> bool:
    """只读服务端 Bot 设置；载荷不能授权私人记忆进入群聊。"""
    if not actor.is_owner or actor.chat_type != "group":
        return False
    bot_db_id = _parse_bot_db_id(bot_id)
    if bot_db_id is None:
        return False
    import app.db.session as db_session
    from app.models import UserBot

    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        bot = await db.get(UserBot, bot_db_id)
        return bool(bot and bot.user_id == actor.owner_user_id
                    and bot.platform == actor.platform and bot.group_owner_memory_enabled)


async def resolve_group_policy(bot_id: str, platform: str = "qq") -> tuple[bool, bool, bool, bool, bool]:
    """读取指定 IM Bot 的群策略；未知 Bot 或平台不匹配时关闭群聊。"""
    import app.db.session as db_session
    from app.models import UserBot

    if db_session._engine is None:
        db_session._build_engine()
    bot_db_id = _parse_bot_db_id(bot_id)
    if bot_db_id is None:
        return False, True, False, True, True
    async with db_session._SessionLocal() as db:
        bot = await db.get(UserBot, bot_db_id)
        if not bot or bot.platform != platform:
            return False, True, False, True, True
        enabled = (
            bot.group_chat_enabled if platform in {"qq", "telegram"}
            else (bot.feishu_group_chat_enabled is not False if platform == "feishu" else False)
        )
        return enabled, bot.group_requires_at, (
            bot.group_read_enabled if bot.group_requires_at else False
        ), bot.group_memory_enabled, bot.member_memory_enabled
