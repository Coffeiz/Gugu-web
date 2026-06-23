"""IM 上下文透传：把「当前正在处理的 IM 消息」的平台/message_id/channel_id 带给工具层。

worker 是串行单任务（serve → run_once → handle），handle 里 set 之后，
run_collect → 工具循环 → 工具 handler 在同一异步任务内都能 get（contextvar 同任务传播）。
web 路径不 set，react 之类的 IM 工具据此判定「当前不在 IM 对话里」直接返回不可用。
"""
from __future__ import annotations

from contextvars import ContextVar

_im: ContextVar[dict | None] = ContextVar("im_ctx", default=None)


def set_im(platform: str, message_id: str | None,
           channel_id: str | None, chat_id: str | None) -> None:
    _im.set({
        "platform": platform, "message_id": message_id,
        "channel_id": channel_id, "chat_id": chat_id,
        "reacted": False,   # 本轮咕咕有没有用 react 工具点过表情（worker 收尾据此决定要不要兜底补一个）
    })


def get_im() -> dict | None:
    return _im.get()


def mark_reacted() -> None:
    c = _im.get()
    if c:
        c["reacted"] = True


def was_reacted() -> bool:
    c = _im.get()
    return bool(c and c.get("reacted"))


def clear() -> None:
    _im.set(None)
