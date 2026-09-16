"""链接按钮工具。

这是一个非常驻业务工具：通过固定 Adapter 按需获取 Schema，避免把链接按钮能力
放进 meta 固定入口或每轮 Provider 工具列表。
"""
from __future__ import annotations

from agent.tools.base import BaseSkill, Tool


async def _send_link_buttons(db, user_id, args: dict):
    """向当前会话发送链接按钮（PRD-LLM-24）；非阻塞出站，不创建待答交互。

    工具层只做校验并生成平台无关的按钮结构；QQ/飞书/微信的渲染与降级由
    ``agent.im.replies`` 承接，Web 经 _artifact 通道推送结构化按钮给前端。
    """
    from agent.im import imctx
    from agent.im.link_buttons import validate_link_buttons_payload

    message = str(args.get("message") or "").strip()
    normalized, error = validate_link_buttons_payload(message, args.get("buttons"))
    if normalized is None:
        return {"status": "rejected", "delivery": "none", "button_count": 0, "error": error}

    payload = imctx.to_send_payload()
    if payload:
        from agent.im.replies import send_link_button_message
        return await send_link_button_message(payload, message=message, buttons=normalized)

    # Web 对话：经 _artifact 通道推 link_buttons 事件，由前端渲染安全按钮（§8.4）。
    return {
        "status": "sent",
        "platform": "web",
        "delivery": "native",
        "button_count": len(normalized),
        "message": "入口已在对话窗口以按钮展示。",
        "_artifact": {"kind": "link_buttons", "message": message, "buttons": normalized},
    }


class LinkButtonsSkill(BaseSkill):
    name = "link_buttons"
    tools = [
        Tool(
            name="send_link_buttons", label="发送链接按钮",
            description_short="向当前会话发送网页/AppLink 入口按钮；不等待点击，不回传结果",
            description=(
                "向当前会话发送 1~5 个链接按钮，用户点击后打开 HTTPS 网页、系统入口或 AppLink。"
                "只做导航入口：不等待用户点击，点击结果不会返回给咕咕，也不会暂停任务。"
                "支持 HTTPS、HTTP、系统入口和自定义 App Scheme；危险 Scheme 会被服务端拒绝。"
                "删除、覆盖、授权、付款等需要服务端执行的动作不能用本工具，必须走对应工具的确认门；"
                "当前平台不支持原生按钮时会自动退回可复制的文本链接。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "message": {"type": "string", "minLength": 1, "maxLength": 2000},
                    "buttons": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 5,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "id": {"type": "string", "minLength": 1, "maxLength": 64},
                                "label": {"type": "string", "minLength": 1, "maxLength": 40},
                                "url": {"type": "string", "minLength": 1, "maxLength": 2048},
                            },
                            "required": ["id", "label", "url"],
                        },
                    },
                },
                "required": ["message", "buttons"],
                "additionalProperties": False,
            },
            handler=_send_link_buttons,
        ),
    ]


LinkButtonsSkill().register()
