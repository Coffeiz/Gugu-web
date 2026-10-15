"""QQ Gateway 稳定调用入口。"""
from .client import QQAPIError, close_qq_http_session, start_qq_http_session
from .outbound import (
    create_private_text_stream,
    send_c2c,
    send_file,
    send_group,
    send_keyboard,
    send_link_keyboard,
)
from .runtime import serve

__all__ = [
    "QQAPIError",
    "close_qq_http_session",
    "create_private_text_stream",
    "send_c2c",
    "send_file",
    "send_group",
    "send_keyboard",
    "send_link_keyboard",
    "serve",
    "start_qq_http_session",
]
