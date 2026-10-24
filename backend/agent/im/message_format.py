"""QQ 文本消息格式策略：配置读取、格式判定与兼容提示词。"""

from __future__ import annotations

MESSAGE_FORMATS = frozenset({"compat", "markdown"})
DEFAULT_GROUP_FORMAT = "compat"
DEFAULT_PRIVATE_FORMAT = "markdown"


def default_message_format(chat_type: str | None) -> str:
    return DEFAULT_GROUP_FORMAT if chat_type == "group" else DEFAULT_PRIVATE_FORMAT


def message_type(_text: str, mode: str | None) -> int:
    """返回 QQ 文本消息类型；未传策略时保留旧调用的 Markdown 行为。"""
    return 0 if mode == "compat" else 2


def compatibility_prompt() -> str:
    return (
        "## 当前消息格式约束\n\n"
        "当前 QQ 会话使用兼容格式。回复必须使用普通纯文本；不要使用 Markdown 标记，"
        "包括标题、列表标记、表格、代码围栏、反引号、加粗、斜体、删除线或 Markdown 链接。"
        "用自然的纯文本和换行表达内容。"
    )


async def resolve_message_format(bot_id: str, chat_type: str | None) -> str:
    """按用户绑定的 QQ Bot 读取会话格式策略。"""
    import app.db.session as db_session
    from app.models import UserBot

    if db_session._engine is None:
        db_session._build_engine()
    fallback = default_message_format(chat_type)
    try:
        bot_db_id = int(bot_id)
    except (TypeError, ValueError):
        return fallback
    async with db_session._SessionLocal() as db:
        bot = await db.get(UserBot, bot_db_id)
    if not bot:
        return fallback
    value = bot.group_message_format if chat_type == "group" else bot.private_message_format
    return value if value in MESSAGE_FORMATS else fallback


async def resolve_private_streaming_enabled(bot_id: str) -> bool:
    """读取 QQ Bot 的私聊实时流式开关；缺少有效 Bot 时按关闭处理。"""
    import app.db.session as db_session
    from app.models import UserBot

    if db_session._engine is None:
        db_session._build_engine()
    try:
        bot_db_id = int(bot_id)
    except (TypeError, ValueError):
        return False
    async with db_session._SessionLocal() as db:
        bot = await db.get(UserBot, bot_db_id)
    return bool(
        bot
        and bot.private_streaming_enabled
        and bot.private_message_format == "markdown"
    )
