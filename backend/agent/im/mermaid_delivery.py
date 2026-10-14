"""Mermaid 回复的图文顺序交付与失败回退。"""
from __future__ import annotations

import re
from collections.abc import Callable

_MERMAID_SOURCE_FENCE_RE = re.compile(
    r"```mermaid[ \t]*\r?\n[\s\S]*?```", re.IGNORECASE,
)


async def send_mermaid_reply_text(
    payload: dict,
    text: str,
    *,
    send_text: Callable,
    try_send_png_image: Callable,
    send_qq_mermaid_text: Callable,
) -> str | None:
    """按生成顺序发送文字与图；图片失败时退回 Mermaid 源码。"""
    from agent.im.mermaid import render_reply

    platform = payload.get("platform")
    parts = await render_reply(
        text, theme_preferences=payload.get("mermaid_theme_preferences")
    )
    if platform == "qq":
        for index, part in enumerate(parts):
            if not part.text:
                continue
            previous = parts[index - 1] if index > 0 else None
            following = parts[index + 1] if index + 1 < len(parts) else None
            previous_diagram = bool(previous and (
                previous.png is not None
                or _MERMAID_SOURCE_FENCE_RE.fullmatch(previous.text)
            ))
            next_diagram = bool(following and (
                following.png is not None
                or _MERMAID_SOURCE_FENCE_RE.fullmatch(following.text)
            ))
            text_value = part.text
            if previous_diagram:
                text_value = text_value.lstrip()
            if next_diagram:
                text_value = text_value.rstrip()
            parts[index] = type(part)(
                text=text_value,
                png=part.png,
                source=part.source,
                placeholder_emitted=part.placeholder_emitted,
            )
    elif platform == "wechat":
        # 微信把图片与相邻文字作为独立消息，去掉图片边界空行。
        for index, part in enumerate(parts):
            if not part.text:
                continue
            previous_image = index > 0 and parts[index - 1].png is not None
            next_image = index + 1 < len(parts) and parts[index + 1].png is not None
            text_value = part.text
            if previous_image:
                text_value = text_value.lstrip()
            if next_image:
                text_value = text_value.rstrip()
            parts[index] = type(part)(
                text=text_value,
                png=part.png,
                source=part.source,
                placeholder_emitted=part.placeholder_emitted,
            )

    delivered: list[str] = []
    visible = False
    for part in parts:
        if part.png is not None:
            visible = True
            if not await try_send_png_image(payload, part.png) and part.source:
                fallback = (
                    send_qq_mermaid_text
                    if platform == "qq"
                    else send_text
                )
                if not await fallback(payload, part.source):
                    return None
                delivered.append(part.source)
            continue
        if part.text.strip():
            visible = True
            fallback = send_qq_mermaid_text if platform == "qq" else send_text
            if not await fallback(payload, part.text):
                return None
            delivered.append(part.text)
    if platform == "qq" and not visible:
        return None
    return "".join(delivered).strip() or text.strip()


async def send_completed_parts(
    payload: dict,
    parts,
    *,
    send_text: Callable,
    try_send_png_image: Callable,
) -> bool:
    """按解析顺序发送完成的文字与图片 part。"""
    for part in parts:
        if part.png is not None:
            if not await try_send_png_image(payload, part.png) and part.source:
                if not await send_text(payload, part.source):
                    return False
        elif part.text.strip() and not await send_text(payload, part.text):
            return False
    return True
