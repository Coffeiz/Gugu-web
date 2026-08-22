"""QQ Keyboard 交互边界。

这里故意只编码不敏感的 ``prompt_id:token`` 动作标识。用户身份、session 和工具
上下文都留在服务端，QQ payload 不携带这些字段。真实 QQ interaction event 的
字段由 adapter 解析，避免网关主循环依赖某一种 SDK 对象形状。
"""
from __future__ import annotations

import json
from typing import Any


def encode_action_data(prompt_id: int, token: str) -> str:
    if not token or ":" in token:
        raise ValueError("动作 token 格式无效")
    return f"{int(prompt_id)}:{token}"


def decode_action_data(value: str) -> tuple[int, str]:
    prompt, sep, token = str(value or "").partition(":")
    if not sep or not prompt.isdigit() or not token:
        raise ValueError("QQ 动作数据无效")
    return int(prompt), token


def build_keyboard_payload(prompt: dict[str, Any]) -> dict[str, Any]:
    """生成统一的按钮动作数据；QQ adapter 再把它转换为官方 wire payload。"""
    buttons = []
    for option in prompt.get("options") or []:
        token = str(option.get("token") or "")
        if not token:
            continue
        buttons.append({
            "label": str(option.get("label") or option.get("id") or "选择"),
            "action_data": encode_action_data(int(prompt["prompt_id"]), token),
        })
    return {"kind": "qq_keyboard", "prompt_id": int(prompt["prompt_id"]), "buttons": buttons}


def parse_interaction_event(payload: dict[str, Any]) -> dict[str, Any] | None:
    """解析 QQ interaction 样本的常见嵌套形状，返回受控字段。"""
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    action = data.get("action") if isinstance(data.get("action"), dict) else data
    resolved = data.get("resolved") if isinstance(data.get("resolved"), dict) else {}
    # QQ 官方 interaction event 把按钮数据放在 data.resolved.button_data；
    # 旧适配器/测试样本则可能直接放在 action_data/data，按优先级兼容两种形状。
    raw = (
        resolved.get("button_data")
        or action.get("action_data")
        or action.get("data")
        or action.get("custom_data")
        or ""
    )
    if isinstance(raw, dict):
        raw = raw.get("action_data") or raw.get("data") or ""
    try:
        prompt_id, token = decode_action_data(str(raw))
    except ValueError:
        return None
    actor = data.get("user") if isinstance(data.get("user"), dict) else data.get("author")
    actor = actor if isinstance(actor, dict) else {}
    # QQ 官方 INTERACTION_CREATE 的 C2C 回调通常把操作者直接放在
    # data.user_openid（而不是 data.user.user_openid）；群回调也可能使用
    # group_member_openid。优先读取官方顶层字段，再兼容旧的嵌套样本。
    platform_user_id = (
        data.get("user_openid")
        or data.get("group_member_openid")
        or actor.get("user_openid")
        or actor.get("openid")
        or actor.get("id")
        or resolved.get("user_id")
    )
    return {
        "prompt_id": prompt_id,
        "token": token,
        "event_id": str(payload.get("id") or data.get("id") or "") or None,
        "platform_user_id": str(platform_user_id or "") or None,
        "channel_id": str(data.get("channel_id") or payload.get("channel_id") or "") or None,
        "chat_type": "group" if data.get("group_openid") or data.get("group_id") else "c2c",
        "chat_id": str(data.get("group_openid") or data.get("group_id") or "") or None,
    }


def format_text_fallback(prompt: dict[str, Any]) -> str:
    title = str(prompt.get("title") or "需要确认")
    body = str(prompt.get("body") or "")
    options = [
        str(item.get("label") or item.get("id") or "选项")
        for item in prompt.get("options") or []
    ]
    if options:
        choices = "\n".join(f"{index}. {label}" for index, label in enumerate(options, 1))
        instruction = "请在网页点击选项。"
        if prompt.get("native_keyboard"):
            instruction = "请点击下方按钮；若未显示按钮，可回复选项序号或选项文字。"
        if prompt.get("allow_text_input"):
            instruction = "请回复选项序号或选项文字。"
        return f"{title}\n{body}\n{choices}\n{instruction}"
    return f"{title}\n{body}\n请在网页中填写后提交。"


__all__ = ["build_keyboard_payload", "decode_action_data", "encode_action_data", "format_text_fallback", "parse_interaction_event"]
