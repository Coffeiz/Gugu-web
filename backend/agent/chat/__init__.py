"""聊天会话域：附件装配进本轮消息。"""
from __future__ import annotations

from .attachments import build_user_content, resolve_for_message

__all__ = ["build_user_content", "resolve_for_message"]
