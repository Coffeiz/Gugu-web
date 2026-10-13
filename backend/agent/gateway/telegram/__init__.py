"""Telegram Gateway 的跨模块出站 API。"""

from .runtime import main, send_file, send_message, send_message_draft

__all__ = ["main", "send_file", "send_message", "send_message_draft"]
