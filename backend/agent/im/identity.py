"""IM 身份解析门面。

Gateway 只提供平台事件元数据；这里把 Bot 所属的 Gugu 账号和当前消息的
称呼字段整理成 Agent 入口需要的值。平台身份权限仍由 permissions 模块解析，
避免把 display name 当成身份主键。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

@dataclass(frozen=True)
class ImIdentity:
    """当前 IM 消息绑定到的 Gugu 账号。"""

    user_id: Any
    user_name: str


async def resolve_owner_account(payload: dict) -> Optional[ImIdentity]:
    """根据 Gateway 提供的 Bot owner 解析 Gugu 账号。

    当前 BYO Bot 的 owner_user_id 是可靠归属字段；platform_user_id 只代表
    当前发言人，不能用于反查 Gugu 用户或跨 Bot 合并身份。
    """
    owner = payload.get("owner_user_id")
    if not owner:
        return None

    import app.db.session as db_session
    if db_session._engine is None:
        db_session._build_engine()
    from app.models import User

    async with db_session._SessionLocal() as db:
        user = await db.get(User, owner)
    if not user:
        return None
    return ImIdentity(owner, user.display_name or "")


def display_name_for_message(identity: ImIdentity, payload: dict, role: Optional[str]) -> str:
    """为当前请求选择称呼；member/unknown 不注入 owner 账号名。"""
    if role in {"member", "unknown"}:
        return payload.get("platform_user_name") or "这位群友"
    return identity.user_name
