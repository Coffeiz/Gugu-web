"""IM 命令入口。"""
from __future__ import annotations

from typing import Optional


async def handle_im_command(user_id, message: str, session_id: Optional[int] = None,
                            *, allow_leading_mention: bool = False,
                            locale: str | None = None) -> Optional[str]:
    """处理不需要模型的 IM 命令，返回回复文本或 ``None``。"""
    from agent import commands

    return await commands.handle(
        user_id,
        message,
        session_id=session_id,
        allow_leading_mention=allow_leading_mention,
        locale=locale,
    )
