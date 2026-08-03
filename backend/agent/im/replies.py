"""IM 出站回复映射。

这里把平台无关的 ``PlatformReply`` 转成 Gateway 的发送调用，是"该调哪个平台
发送接口"这个判断的唯一位置——文本、流式和文件回复都经这里分发，不再各自
维护一份 if/elif。文件的元数据解析、大小限制和 DB/存储读取仍属于
``agent.im.files`` 的职责，只是最终"调哪个 Gateway 函数发送"收到这里来。
"""
from __future__ import annotations

import re
from typing import AsyncIterator, Tuple

from agent.im.models import PlatformReply
from agent.models import AgentResponse

_CODE_SPLIT_RE = re.compile(r'(```[\s\S]*?```|`[^`\n]*`)')
_BOLD_LEAD_WS_RE = re.compile(r'\*\*[ \t]+([^*\n]+?)\*\*')
_BOLD_TRAIL_WS_RE = re.compile(r'\*\*([^*\n]+?)[ \t]+\*\*')

_FEISHU_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}
_FEISHU_IMAGE_MAX = 10 * 1024 * 1024
_FEISHU_FILE_MAX = 30 * 1024 * 1024
_WECHAT_FILE_MAX = 30 * 1024 * 1024
_QQ_FILE_MAX = 10 * 1024 * 1024


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


async def send_file(payload: dict, *, storage_key: str, ext: str, display_name: str, fname: str) -> bool:
    """把一个文件按目标平台发送，返回是否成功。

    调用方（``agent.im.files``）负责解析文件元数据和读取存储；这里只负责
    "这个平台该调哪个 Gateway 函数"这一步，跟文本/流式共用同一个分发入口。
    """
    platform = payload.get("platform")
    if platform == "wechat":
        return await _send_file_wechat(payload, storage_key, ext, fname)
    if platform == "feishu":
        from app.services.storage import get_storage
        data = await get_storage().get(storage_key)
        return await _send_file_feishu(payload, ext, data, fname)
    if platform == "qqbot":
        return await _send_file_qq(payload, storage_key, ext, display_name, fname)
    return False


async def _send_file_wechat(payload: dict, storage_key: str, ext: str, fname: str) -> bool:
    from agent.gateway import wechat
    from app.services.storage import get_storage

    openid = payload.get("platform_user_id")
    if not openid:
        return False
    data = await get_storage().get(storage_key)
    if len(data) > _WECHAT_FILE_MAX:
        return False
    context_token = payload.get("context_token", "")
    is_image = (ext or "").lower() in _FEISHU_IMAGE_EXTS
    if is_image:
        ok = await wechat.send_image(openid, data, context_token, payload.get("channel_id"))
        label = "图片"
    else:
        ok = await wechat.send_file(openid, data, fname, context_token, payload.get("channel_id"))
        label = "文件"
    from agent import logsafe
    print(
        f"[im] wechat 发{label} fp={logsafe.fingerprint(fname)}: "
        f"{'ok' if ok else '失败'}（{len(data)} bytes）",
        flush=True,
    )
    return ok


async def _send_file_feishu(payload: dict, ext: str, data: bytes, fname: str) -> bool:
    from agent.gateway import feishu
    from agent import logsafe

    is_image = (ext or "").lower() in _FEISHU_IMAGE_EXTS
    limit = _FEISHU_IMAGE_MAX if is_image else _FEISHU_FILE_MAX
    if len(data) > limit:
        mb, lim_mb = len(data) / 1048576, limit // 1048576
        print(
            f"[im] feishu 发文件 fp={logsafe.fingerprint(fname)}: "
            f"跳过（{mb:.1f}MB > {lim_mb}MB 上限）",
            flush=True,
        )
        return False
    display_name = fname.rsplit(".", 1)[0] if "." in fname else fname
    ok = await feishu.send_file(
        payload.get("chat_id"), data, display_name, ext, payload.get("channel_id")
    )
    print(f"[im] feishu 发文件 fp={logsafe.fingerprint(fname)}: {'ok' if ok else '失败'}", flush=True)
    return ok


async def _send_file_qq(
    payload: dict,
    storage_key: str,
    ext: str,
    display_name: str,
    fname: str,
) -> bool:
    from agent.gateway import qq
    from app.services.storage import get_storage

    is_group = payload.get("chat_type") == "group"
    openid = payload.get("chat_id") if is_group else payload.get("platform_user_id")
    if not openid:
        return False
    storage = get_storage()
    data = await storage.get(storage_key)
    if len(data) > _QQ_FILE_MAX:
        return False
    ok = await qq.send_file(
        openid, data, display_name, ext, payload.get("channel_id"),
        payload.get("message_id"), group=is_group,
    )
    return ok


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
