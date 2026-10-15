"""微信 Gateway 的跨模块出站 API。"""

from .outbound import send_file, send_image, send_text, start_typing, stop_typing

__all__ = [
    "send_file",
    "send_image",
    "send_text",
    "start_typing",
    "stop_typing",
]
