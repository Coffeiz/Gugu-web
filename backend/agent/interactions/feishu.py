"""飞书交互卡片的无状态渲染与动作解析。

卡片携带 Prompt ID、一次性 action token 和仅用于完成态展示的选项文本。业务上下文始终
留在服务端，点击回调由飞书网关交给统一的 ``consume_action`` 消费。
"""
from __future__ import annotations

from typing import Any


def encode_action_value(
    prompt_id: int,
    token: str,
    *,
    option_id: str | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    if int(prompt_id) <= 0 or not token:
        raise ValueError("飞书动作数据无效")
    value: dict[str, Any] = {"prompt_id": int(prompt_id), "token": str(token)}
    if isinstance(option_id, str) and option_id:
        value["option_id"] = option_id[:64]
    if isinstance(label, str) and label.strip():
        value["label"] = label.strip()[:120]
    return value


def action_presentation(value: Any) -> tuple[str, str]:
    """读取仅供完成卡展示的选项信息；它不参与 action 授权或消费。"""
    if not isinstance(value, dict):
        return "", ""
    option_id = value.get("option_id")
    label = value.get("label")
    return (
        option_id.strip()[:64] if isinstance(option_id, str) else "",
        label.strip()[:120] if isinstance(label, str) else "",
    )


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
            "value": encode_action_value(
                int(prompt["prompt_id"]),
                str(option["token"]),
                option_id=str(option.get("id") or ""),
                label=str(option.get("label") or option.get("id") or "选择"),
            ),
        })
    if buttons:
        elements.append({"tag": "action", "actions": buttons})
    return {"config": {"wide_screen_mode": True}, "elements": elements}


def build_completed_card_payload(message: str = "已收到选择，继续处理。") -> dict[str, Any]:
    """构造消费后的无按钮状态卡，避免客户端继续展示可点击动作。"""
    return {
        "config": {"wide_screen_mode": True},
        "elements": [{
            "tag": "div",
            "text": {"tag": "plain_text", "content": str(message)[:200]},
        }],
    }


__all__ = [
    "build_card_payload",
    "build_completed_card_payload",
    "action_presentation",
    "decode_action_value",
    "encode_action_value",
]
