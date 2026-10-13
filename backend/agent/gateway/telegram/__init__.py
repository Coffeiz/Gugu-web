"""Telegram Gateway 的稳定兼容入口。"""

from .runtime import main, send_file, send_message

__all__ = ["main", "send_file", "send_message"]
