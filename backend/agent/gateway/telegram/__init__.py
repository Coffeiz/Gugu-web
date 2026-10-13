"""Telegram Gateway 的跨模块出站 API。"""

from .runtime import send_file, send_message

__all__ = ["send_file", "send_message"]
