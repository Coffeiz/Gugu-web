"""共享 Agent Runtime 使用的 IM 行为者上下文。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, List, Optional

from sqlalchemy.exc import SQLAlchemyError

from app.core.redaction import diag_log, redact


@dataclass(frozen=True)
class ActorContext:
    """身份、会话范围和工具权限的显式快照。

    ``owner_user_id`` 是 Bot 所属的 Gugu 账号；``platform_user_id`` 是当前
    发言人。两者必须保持分离，不能因为二者出现在同一个请求里就视为同一身份。
    """

    owner_user_id: Any
    platform: str
    platform_user_id: Optional[str] = None
    platform_user_name: Optional[str] = None
    role: Optional[str] = None
    chat_type: Optional[str] = None
    chat_id: Optional[str] = None
    allowed_tool_names: Optional[List[str]] = None

    @property
    def is_im(self) -> bool:
        return self.platform in {"feishu", "qq", "wechat"}

    @property
    def is_owner(self) -> bool:
        return self.role == "owner"

    @property
    def is_restricted(self) -> bool:
        return self.role in {"member", "unknown"}


class ActorResolver:
    """IM 身份解析唯一入口，返回一次请求不可变的 ActorContext。"""

    def __init__(self, access_resolver: Optional[Callable[..., Awaitable[Any]]] = None):
        self._access_resolver = access_resolver

    async def resolve(self, platform_message, payload: dict, owner_user_id: Any) -> ActorContext:
        platform = platform_message.platform or "worker"
        platform_user_id = platform_message.sender.id or payload.get("platform_user_id")
        chat_type = platform_message.chat.type or payload.get("chat_type")
        role = None
        allowed_tool_names = None
        if platform in {"feishu", "qq", "wechat"}:
            try:
                resolver = self._access_resolver
                if resolver is None:
                    from agent.im.permissions import resolve_access
                    resolver = resolve_access
                access = await resolver(
                    platform,
                    chat_type,
                    payload.get("channel_id") or platform_message.bot_id,
                    owner_user_id,
                    platform_user_id or "",
                )
                role = access.role or "unknown"
                allowed_tool_names = access.allowed_tool_names
                if role == "unknown" and allowed_tool_names is None:
                    allowed_tool_names = ["web_search", "image_search", "send_file"]
            except (ValueError, TypeError, SQLAlchemyError) as exc:
                diag_log("im.actor_resolver", exc)
                print(
                    f"[im] {platform} 身份权限解析失败，按最小权限继续: {redact(type(exc).__name__)}",
                    flush=True,
                )
                role = "unknown"
                allowed_tool_names = ["web_search", "image_search", "send_file"]
        actor = ActorContext(
            owner_user_id=owner_user_id,
            platform=platform,
            platform_user_id=platform_user_id,
            platform_user_name=payload.get("platform_user_name") or platform_message.sender.name,
            role=role,
            chat_type=chat_type,
            chat_id=platform_message.chat.id if chat_type == "group" else None,
            allowed_tool_names=allowed_tool_names,
        )
        return actor
