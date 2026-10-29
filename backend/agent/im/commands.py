"""IM 命令入口。"""
from __future__ import annotations

from typing import Optional


def group_command_requires_mention(payload: dict) -> bool:
    """群里命令必须确证是对咕咕说的才生效。

    QQ / 飞书没有 bot 作用域：群里裸打 ``/命令`` 无法判断是在叫哪个 bot，
    可能是别家的命令，不该由咕咕抢答执行。Telegram 的 ``group_mentioned``
    已包含命令触发（parser 只把发给本 bot 的命令投递进来），天然满足。
    """
    if payload.get("chat_type") != "group":
        return False
    return not payload.get("group_mentioned")


async def handle_im_command(user_id, message: str, session_id: Optional[int] = None,
                            *, locale: str | None = None) -> Optional[str]:
    """处理不需要模型的 IM 命令，返回回复文本或 ``None``。

    ``message`` 必须是语义文本（mention 前缀已在 IM 层剥掉）。
    """
    from agent import commands

    return await commands.handle(
        user_id,
        message,
        session_id=session_id,
        locale=locale,
    )
