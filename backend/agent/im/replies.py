"""IM 出站文本回复映射。

这里把平台无关的 ``PlatformReply`` 转成 Gateway 的发送调用。文件发送由同级的
``agent.im.files`` 负责，避免文本与媒体协议混在同一个入口。
"""
from __future__ import annotations

import re
from typing import AsyncIterator, Tuple

from agent.im.models import PlatformReply
from agent.models import AgentResponse

_CODE_SPLIT_RE = re.compile(r'(```[\s\S]*?```|`[^`\n]*`)')
_BOLD_LEAD_WS_RE = re.compile(r'\*\*[ \t]+([^*\n]+?)\*\*')
_BOLD_TRAIL_WS_RE = re.compile(r'\*\*([^*\n]+?)[ \t]+\*\*')


async def send_text(payload: dict, text: str) -> None:
    """构造并发送一条平台无关的文本回复。"""
    await send_reply(payload, PlatformReply.from_text(payload, text))


async def send_reply(payload: dict, reply: PlatformReply) -> None:
    """将统一回复交给对应 Gateway。"""
    platform = payload.get("platform")
    unsupported = reply.unsupported_capabilities(platform or "")
    if unsupported and platform in {"qqbot", "feishu", "wechat"}:
        from agent import logsafe
        print(
            f"[im] {platform} 不支持回复能力: {','.join(unsupported)} "
            f"fp={logsafe.fingerprint(reply.text)}",
            flush=True,
        )
        return
    if platform == "feishu" and reply.target.id:
        from agent.gateway import feishu
        await feishu.send_text(reply.target.id, reply.text, payload.get("channel_id"))
    elif platform == "qqbot" and reply.target.id:
        from agent.gateway import qq
        if reply.target.type == "group":
            await qq.send_group(
                reply.target.id,
                reply.text,
                reply.reply_to_message_id,
                payload.get("channel_id"),
            )
        else:
            await qq.send_c2c(
                reply.target.id,
                reply.text,
                reply.reply_to_message_id,
                payload.get("channel_id"),
            )
    elif platform == "wechat" and reply.target.id:
        from agent.gateway import wechat
        await wechat.send_text(
            reply.target.id,
            reply.text,
            payload.get("channel_id"),
            payload.get("context_token", ""),
        )
    else:
        from agent import logsafe
        print(
            f"[im] (无发送通道) {platform}: len={len(reply.text)} "
            f"fp={logsafe.fingerprint(reply.text)}",
            flush=True,
        )


async def send_stream(payload: dict, token_iter: AsyncIterator[tuple[str, object]]) -> Tuple[bool, object]:
    """发送飞书流式回复，返回发送是否成功及 Gateway 收集的最终响应。"""
    stream_reply = PlatformReply.from_parts(payload, [{"type": "stream"}])
    if stream_reply.unsupported_capabilities(payload.get("platform") or ""):
        return False, None
    from agent.gateway import feishu

    receive_id = payload.get("chat_id") or payload.get("platform_user_id")
    return await feishu.send_text_stream(
        receive_id,
        token_iter,
        payload.get("channel_id"),
    )


def _fix_loose_bold(text: str) -> str:
    """修正 IM markdown 渲染器不接受的宽松加粗写法，代码片段保持原样。"""
    parts = _CODE_SPLIT_RE.split(text)
    for i in range(0, len(parts), 2):
        parts[i] = _BOLD_LEAD_WS_RE.sub(r'**\1**', parts[i])
        parts[i] = _BOLD_TRAIL_WS_RE.sub(r'**\1**', parts[i])
    return ''.join(parts)


async def send_stream_with_fallback(
    payload: dict,
    token_iter: AsyncIterator[tuple[str, object]],
) -> Tuple[bool, AgentResponse, str]:
    """发送流式回复；流式卡片失败时在同一回复层补发普通文本。"""
    stream_sent, response = await send_stream(payload, token_iter)
    if response is None:
        response = AgentResponse(text="", session_id=None, tokens_in=0, tokens_out=0)

    reply_text = _fix_loose_bold(response.text or "")
    if not reply_text.strip():
        reply_text = "给你～" if response.files else "嗯~在的，你说～"
    if not stream_sent and reply_text.strip():
        await send_text(payload, reply_text)
    return bool(stream_sent), response, reply_text
