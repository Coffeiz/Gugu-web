"""Telegram Inline Keyboard 的统一 Prompt Action 编码与渲染。"""
from __future__ import annotations

from typing import Any

_CALLBACK_DATA_LIMIT = 64
_KEYBOARD_ROW_BUDGET = 40
_KEYBOARD_BUTTON_CHROME = 4
_KEYBOARD_MAX_PER_ROW = 4


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


def _label_width_units(label: str) -> int:
    """近似计算按钮标签宽度：中文、全角字符和 emoji 按两个单位计。"""
    return sum(2 if ord(char) > 0x2E7F else 1 for char in label)


def _pack_button_rows(buttons: list[dict[str, str]]) -> list[list[dict[str, str]]]:
    """依据标签估算宽度分行，避免长按钮和短按钮挤在同一行。"""
    rows: list[list[dict[str, str]]] = []
    current: list[dict[str, str]] = []
    current_width = 0
    for button in buttons:
        width = _label_width_units(button["text"]) + _KEYBOARD_BUTTON_CHROME
        if current and (
            len(current) >= _KEYBOARD_MAX_PER_ROW
            or current_width + width > _KEYBOARD_ROW_BUDGET
        ):
            rows.append(current)
            current, current_width = [], 0
        current.append(button)
        current_width += width
    if current:
        rows.append(current)
    return rows


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
    return {"inline_keyboard": _pack_button_rows(buttons)}


__all__ = ["build_inline_keyboard", "decode_action_data", "encode_action_data"]
