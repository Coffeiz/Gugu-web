"""控制命令文本的轻量归一化。"""

from __future__ import annotations

import re


_LEADING_MENTION = re.compile(
    r"^\s*(?:<@!?[^>\s]+>|[@＠][^\s/／]+)\s+(?=[/／])"
)


def normalize_command_text(text: str | None) -> str:
    """去掉命令前的机器人 mention，保留其余正文原样。

    QQ 群消息通常会以 ``@咕咕 /compact`` 或 ``<@bot-id> /compact`` 进入
    worker。只有 mention 后紧跟斜杠命令时才处理，避免把普通聊天中的 ``@用户``
    内容误改成命令。
    """
    value = (text or "").strip()
    return _LEADING_MENTION.sub("", value, count=1)
