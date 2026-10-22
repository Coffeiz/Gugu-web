"""IM 工具状态和平台交互展示。"""
from __future__ import annotations


async def display_tool_event(
    payload: dict,
    event: dict,
    *,
    tool_display_mode: str,
    publish_web_event,
    feishu_tool_summary=None,
    stream_tool_events=None,
) -> None:
    """保持 Web 镜像独立，再按用户偏好选择 IM 工具状态呈现。"""
    await publish_web_event(event)
    # 飞书 ask_user 已由交互卡片承载等待与完成状态；再把 tool_done
    # 当普通工具消息发出会产生“暂停/完成”两条额外消息。Web 事件仍照常镜像。
    if payload.get("platform") == "feishu" and event.get("name") == "ask_user":
        return
    if tool_display_mode != "all":
        return
    if feishu_tool_summary is not None and await feishu_tool_summary.handle_tool_event(event):
        return
    if stream_tool_events is not None:
        if payload.get("platform") == "telegram" and event.get("type") == "tool_done":
            await stream_tool_events.put(("tool", dict(event)))
        return
    from agent.im.replies import send_tool_event
    if (
        payload.get("platform") == "feishu"
        and payload.get("chat_type") != "group"
        and feishu_tool_summary is not None
        and feishu_tool_summary.include_tool_details
    ):
        await send_tool_event(payload, event, include_details=True)
    else:
        await send_tool_event(payload, event)


def _create_feishu_tool_summary(platform: str, chat_type: str | None, enabled: bool):
    if platform != "feishu" or not enabled:
        return None
    from agent.gateway.feishu.tool_summary import FeishuToolSummaryStream

    return FeishuToolSummaryStream(include_tool_details=chat_type != "group")


async def _send_interaction_prompts(payload: dict, interactions: list[dict]) -> bool:
    """发送平台可理解的交互摘要；未接入原生按钮的平台使用文本摘要。"""
    from agent.im.replies import send_interaction

    sent = True
    for item in interactions:
        sent = bool(await send_interaction(payload, item)) and sent
    return sent


async def _im_display_preferences(user_id) -> tuple[str, bool]:
    from agent.interactions.preferences import im_display_preferences
    return await im_display_preferences(user_id)
