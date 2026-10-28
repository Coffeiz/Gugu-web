"""控制命令文本的轻量归一化。

只服务 ``agent.router`` 的命令识别：网关在入队前做取消/状态快捷判定时，
原始群消息还带着 ``@咕咕`` 前缀，需要先剥掉才能看清是不是命令。

IM 命令执行链不走这里——那条链路用 ``agent.im.mentions.payload_semantic_text``
在网关确认 @ 指向本 bot 后剥 mention，再把语义文本交给 ``agent.commands``。
两处规则不同：本模块要求 mention 后紧跟斜杠（避免把 ``@用户 顺便说说 /compact``
误判成命令），IM 层则已在平台层确认过 mention 归属，可以放宽。
"""

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
