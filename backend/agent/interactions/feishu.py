"""飞书交互卡片的无状态渲染与动作解析。

卡片只携带 Prompt ID 和一次性 action token。用户、会话和业务上下文始终留在服务端，
点击回调由飞书网关交给统一的 ``consume_action`` 消费。
"""
from __future__ import annotations

from typing import Any


def encode_action_value(prompt_id: int, token: str) -> dict[str, Any]:
    if int(prompt_id) <= 0 or not token:
        raise ValueError("飞书动作数据无效")
    return {"prompt_id": int(prompt_id), "token": str(token)}


def decode_action_value(value: Any) -> tuple[int, str]:
    if not isinstance(value, dict):
        raise ValueError("飞书动作数据无效")
    prompt_id = value.get("prompt_id")
    token = value.get("token")
    if isinstance(prompt_id, bool) or not isinstance(prompt_id, (int, str)):
        raise ValueError("飞书动作数据无效")
    try:
        prompt_id = int(prompt_id)
    except (TypeError, ValueError) as exc:
        raise ValueError("飞书动作数据无效") from exc
    if prompt_id <= 0 or not isinstance(token, str) or not token:
        raise ValueError("飞书动作数据无效")
    return prompt_id, token


def build_card_payload(prompt: dict[str, Any]) -> dict[str, Any]:
    """构造飞书旧版 interactive card payload，保持与现有文本卡片兼容。"""
    title = str(prompt.get("title") or "需要你的回答")[:120]
    body = str(prompt.get("body") or "")[:1000]
    elements: list[dict[str, Any]] = []
    content = f"**{title}**"
    if body:
        content += f"\n\n{body}"
    elements.append({"tag": "markdown", "content": content})
    buttons = []
    for option in prompt.get("options") or []:
        if not isinstance(option, dict) or not option.get("token"):
            continue
        buttons.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": str(option.get("label") or option.get("id") or "选择")[:40]},
            "type": "primary",
            "value": encode_action_value(int(prompt["prompt_id"]), str(option["token"])),
        })
    if buttons:
        elements.append({"tag": "action", "actions": buttons})
    return {"config": {"wide_screen_mode": True}, "elements": elements}


def build_completed_card_payload(message: str = "已收到选择，继续处理。") -> dict[str, Any]:
    """构造消费后的无按钮状态卡，避免客户端继续展示可点击动作。"""
    return {
        "config": {"wide_screen_mode": True},
        "elements": [{"tag": "markdown", "content": str(message)[:200]}],
    }


__all__ = [
    "build_card_payload",
    "build_completed_card_payload",
    "decode_action_value",
    "encode_action_value",
]
