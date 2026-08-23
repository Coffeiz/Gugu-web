"""/compact 命令。"""
from __future__ import annotations

import logging

from agent.commands.help import command_help, is_help_arg

logger = logging.getLogger(__name__)


async def handle(user_id, session_id: int | None, arg: str) -> str:
    if is_help_arg(arg):
        return command_help("compact")
    if not session_id:
        return "当前还没有可压缩的对话。"
    from app.core.config import get_settings
    from agent.context import compress_conv

    settings = get_settings()
    try:
        compacted = await compress_conv.compress_if_needed(
            session_id,
            user_id,
            settings,
            settings.ai.context_tokens,
            force=True,
        )
    except Exception:
        logger.exception("手动压缩会话失败 session=%s", session_id)
        return "这次压缩没有完成，请稍后再试。"
    if compacted:
        return "上下文已经整理好了，旧对话已压缩为摘要。"
    return "当前历史还不够长，暂时无需整理上下文。"
