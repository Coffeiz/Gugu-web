"""平台身份注册选择动作。

这里不实现按钮发送和选择状态机，只把已有的首次 sender 绑定能力收进统一
selection 动作。后续 Keyboard 回调应提交同一个 action_id/value。
"""
from __future__ import annotations

from typing import Optional

from agent.selection.models import SelectionOption, SelectionPrompt

IDENTITY_REGISTER_ACTION = "identity.register_platform_user"


def build_platform_user_registration(payload: dict) -> Optional[SelectionPrompt]:
    """为可注册的当前平台身份生成确认选择。"""
    if (
        payload.get("platform") != "qqbot"
        or payload.get("chat_type") != "c2c"
        or not payload.get("owner_user_id")
        or not payload.get("platform_user_id")
        or not payload.get("channel_id")
    ):
        return None
    return SelectionPrompt(
        action_id=IDENTITY_REGISTER_ACTION,
        title="要把这个 QQ 身份绑定到当前咕咕账号吗？",
        options=[
            SelectionOption(label="确认绑定", value="confirm"),
            SelectionOption(label="暂不绑定", value="cancel"),
        ],
        context={
            "platform": "qqbot",
            "platform_user_id": str(payload["platform_user_id"]),
            "bot_id": str(payload["channel_id"]),
        },
    )


async def register_platform_user_id(payload: dict) -> bool:
    """注册当前 QQ 私聊身份，复用现有 owner 绑定服务。"""
    prompt = build_platform_user_registration(payload)
    if prompt is None:
        return False

    import app.db.session as db_session
    from app.services.im_identity import bind_qq_owner_if_empty

    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        return await bind_qq_owner_if_empty(
            db,
            int(payload["channel_id"]),
            payload["owner_user_id"],
            str(payload["platform_user_id"]),
        )
