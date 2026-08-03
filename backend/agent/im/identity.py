"""IM 身份解析门面。

Gateway 只提供平台事件元数据；这里把 Bot 所属的 Gugu 账号和当前消息的
称呼字段整理成 Agent 入口需要的值。平台身份权限仍由 permissions 模块解析，
避免把 display name 当成身份主键。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from app.core.redaction import diag_log, redact


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


async def ensure_owner_platform_binding(payload: dict) -> None:
    """在 IM Loop 身份阶段完成 QQ owner 的首次 sender 绑定。

    Gateway 只负责提供 sender 元数据；绑定属于账号身份业务，放在这里后网关
    不再依赖数据库或用户身份服务。
    """
    try:
        from agent.selection.identity import register_platform_user_id

        await register_platform_user_id(payload)
    except Exception as exc:
        diag_log("agent.im.identity.bind_owner", exc)
        print(
            f"[im] QQ owner 身份绑定失败，消息继续处理: {redact(type(exc).__name__)}",
            flush=True,
        )


def display_name_for_message(identity: ImIdentity, payload: dict, role: Optional[str]) -> str:
    """为当前请求选择称呼；member/unknown 不注入 owner 账号名。"""
    if role in {"member", "unknown"}:
        return payload.get("platform_user_name") or "这位群友"
    return identity.user_name
