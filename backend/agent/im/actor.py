"""共享 Agent Runtime 使用的 IM 行为者上下文。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Optional


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
        return self.platform in {"feishu", "qqbot", "wechat"}

    @property
    def is_owner(self) -> bool:
        return self.role == "owner"

    @property
    def is_restricted(self) -> bool:
        return self.role in {"member", "unknown"}
