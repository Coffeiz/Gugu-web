"""Telegram Inline Keyboard 的统一 Prompt Action 编码与渲染。"""
from __future__ import annotations

from typing import Any

_CALLBACK_DATA_LIMIT = 64


def encode_action_data(prompt_id: int, token: str) -> str:
    """只把 Prompt ID 和一次性 token 放入 callback_data。"""
    if int(prompt_id) <= 0 or not token or ":" in token:
        raise ValueError("Telegram 动作数据无效")
    value = f"{int(prompt_id)}:{token}"
    if len(value.encode("utf-8")) > _CALLBACK_DATA_LIMIT:
        raise ValueError("Telegram 动作数据过长")
    return value


def decode_action_data(value: str) -> tuple[int, str]:
    raw = str(value or "")
    if len(raw.encode("utf-8")) > _CALLBACK_DATA_LIMIT:
        raise ValueError("Telegram 动作数据过长")
    prompt, separator, token = raw.partition(":")
    if not separator or not prompt.isdigit() or int(prompt) <= 0 or not token or ":" in token:
        raise ValueError("Telegram 动作数据无效")
    return int(prompt), token


def build_inline_keyboard(prompt: dict[str, Any]) -> dict[str, Any]:
    """将任意统一交互选项渲染成 Telegram Inline Keyboard。"""
    prompt_id = int(prompt["prompt_id"])
    buttons = []
    for option in prompt.get("options") or []:
        if not isinstance(option, dict) or not option.get("token"):
            continue
        buttons.append({
            "text": str(option.get("label") or option.get("id") or "选择")[:64],
            "callback_data": encode_action_data(prompt_id, str(option["token"])),
        })
    rows = [buttons[index:index + 2] for index in range(0, len(buttons), 2)]
    return {"inline_keyboard": rows}


__all__ = ["build_inline_keyboard", "decode_action_data", "encode_action_data"]
