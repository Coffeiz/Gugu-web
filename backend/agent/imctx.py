"""IM 上下文透传：把「当前正在处理的 IM 消息」的平台/message_id/channel_id 带给工具层。

worker 并发处理（run_once 把每条消息派发成独立 asyncio 任务，见 _dispatch）。
ContextVar 在 create_task 时按任务复制、set 在任务内调用，故每条消息有自己隔离的
上下文 dict——并发下不同用户互不串；handle 里 set 之后，run_collect → 工具循环 →
工具 handler 在同一任务内都能 get。web 路径不 set，react 之类 IM 工具据此判定「当前不在 IM 对话里」返回不可用；
`to_send_payload()` 同理据此把当前上下文转成能直接塞给 `worker._send()` 的形状，供工具派发时主动推送
中间消息用（如慢工具进度声明，见 tools/base.py dispatch + docs/agent/proposals/IM慢工具进度声明-设计.md）。
"""
from __future__ import annotations

from contextvars import ContextVar

_im: ContextVar[dict | None] = ContextVar("im_ctx", default=None)


def set_im(platform: str, message_id: str | None,
           channel_id: str | None, chat_id: str | None,
           puid: str | None = None, chat_type: str | None = None,
           context_token: str = "") -> None:
    _im.set({
        "platform": platform, "message_id": message_id,
        "channel_id": channel_id, "chat_id": chat_id,
        "puid": puid,       # 平台用户 id，State Manager 据此打细粒度状态 / 检查取消标志
        "chat_type": chat_type,        # QQ 群聊(group)/私聊 区分，决定 _send 走哪条发送分支
        "context_token": context_token,  # 微信 iLink 回复必需，其余平台空串
        "reacted": False,   # 本轮咕咕有没有用 react 工具点过表情（worker 收尾据此决定要不要兜底补一个）
        "announced": False,  # 本轮（一个 Busy Session）有没有发过慢工具进度声明，见 tools/base.py dispatch
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


def mark_announced() -> None:
    c = _im.get()
    if c:
        c["announced"] = True


def was_announced() -> bool:
    c = _im.get()
    return bool(c and c.get("announced"))


def to_send_payload() -> dict | None:
    """把当前 IM 上下文转成 worker._send() 能直接用的 payload 形状，供工具层需要在最终回复
    之前主动推一条消息的场景用（如慢工具进度声明）。web 路径没 set_im 过，返回 None。"""
    c = _im.get()
    if not c:
        return None
    return {
        "platform": c["platform"],
        "message_id": c.get("message_id"),
        "channel_id": c.get("channel_id"),
        "chat_id": c.get("chat_id"),
        "platform_user_id": c.get("puid"),
        "chat_type": c.get("chat_type"),
        "context_token": c.get("context_token", ""),
    }


def clear() -> None:
    _im.set(None)
