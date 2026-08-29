"""IM 出站回复映射。

这里把平台无关的 ``PlatformReply`` 转成 Gateway 的发送调用，是"该调哪个平台
发送接口"这个判断的唯一位置——文本、流式和文件回复都经这里分发，不再各自
维护一份 if/elif。文件的元数据解析、大小限制和 DB/存储读取仍属于
``agent.im.files`` 的职责，只是最终"调哪个 Gateway 函数发送"收到这里来。
"""
from __future__ import annotations

import json
import re
from collections.abc import Set
from typing import Tuple

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


async def send_text(payload: dict, text: str) -> bool:
    """构造并发送一条平台无关的文本回复。"""
    return await send_reply(payload, PlatformReply.from_text(payload, text))


async def send_interaction(payload: dict, prompt: dict) -> bool:
    """统一发送交互提示。

    QQ 使用 Keyboard，飞书使用交互卡片；两者失败后都复用同一份文本降级。
    """
    from agent.interactions.qq import format_text_fallback

    platform = payload.get("platform")
    if platform == "feishu" and prompt.get("options"):
        from agent.gateway import feishu

        target_id = payload.get("chat_id") or payload.get("platform_user_id")
        if target_id and await feishu.send_interaction_card(
            target_id, prompt, channel_id=payload.get("channel_id")
        ):
            return True
        return await send_text(payload, format_text_fallback(prompt, platform="feishu"))
    if platform != "qq":
        return await send_text(payload, format_text_fallback(prompt, platform=platform))

    text = format_text_fallback(prompt)
    if prompt.get("options"):
        from agent.gateway import qq

        target_id = payload.get("chat_id") if payload.get("chat_type") == "group" else payload.get("platform_user_id")
        keyboard_prompt = {
            **prompt,
            "platform_user_id": payload.get("platform_user_id"),
            "native_keyboard": True,
        }
        # 键盘发送失败时复用同一份 QQ 降级文案，明确告诉用户可以回复序号；
        # 不能退回平台无关的“请在网页点击”，否则 QQ 端没有可用恢复路径。
        text = format_text_fallback(keyboard_prompt)
        if target_id and await qq.send_keyboard(
            target_id,
            format_text_fallback(keyboard_prompt),
            keyboard_prompt,
            channel_id=payload.get("channel_id") or "",
            msg_id=payload.get("message_id"),
            group=payload.get("chat_type") == "group",
            message_format=payload.get("message_format"),
        ):
            return True
    return await send_text(payload, text)


def _tool_result_summary(result: object, limit: int = 320) -> str:
    """生成适合 IM 展示的短结果摘要，不把工具参数或内部结构直接发给用户。"""
    if result is None:
        return ""
    if isinstance(result, str):
        text = result
    else:
        try:
            text = json.dumps(result, ensure_ascii=False)
        except (TypeError, ValueError):
            text = str(result)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _tool_code_block(value: object, *, language: str = "json", limit: int = 1600) -> str:
    """把工具输入/输出放入有限长度的代码块，避免结构化内容破坏消息排版。"""
    if isinstance(value, str):
        text = value
        language = "text"
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            text = str(value)
    if len(text) > limit:
        text = text[:limit - 1] + "…"
    return f"```{language}\n{text}\n```"


def format_tool_event(event: dict, *, markdown: bool = True) -> str:
    """把工具事件转换成统一语义块，再按平台能力渲染。"""
    label = str(event.get("label") or event.get("name") or "工具").strip()
    event_type = str(event.get("type") or "")
    status = str(event.get("status") or "")
    if not markdown:
        if event_type == "tool_call":
            return ""
        if status in {"success", "ok"}:
            return f"✅ {label}完成"
        if status == "waiting":
            return f"⏳ {label}等待确认"
        return f"⚠️ {label}未完成"

    title = f"### 🔧 {label}"
    if event_type == "tool_call":
        body = [title, "**状态**：执行中"]
        if "input" in event:
            body.extend(("**输入**", _tool_code_block(event.get("input"))))
        return "\n\n".join(body)
    if status == "waiting":
        return f"{title}\n\n**状态**：等待确认"
    status_text = "已完成" if status in {"success", "ok"} else "未完成"
    body = [title, f"**状态**：{status_text}"]
    if event.get("result") is not None:
        body.extend(("**输出**", _tool_code_block(event.get("result"))))
    return "\n\n".join(body)


async def send_tool_event(payload: dict, event: dict) -> bool:
    """独立发送一条工具状态消息；显示策略由 IM Loop 在调用前决定。"""
    from agent.outbound import sanitize_outbound
    is_qq_plain = (
        payload.get("platform") == "qq"
        and payload.get("message_format") != "markdown"
    )
    text = format_tool_event(event, markdown=not is_qq_plain)
    if not text:
        return True
    return await send_text(payload, sanitize_outbound(text))


async def send_reply(payload: dict, reply: PlatformReply) -> bool:
    """将统一回复交给对应 Gateway。"""
    platform = payload.get("platform")
    from agent.outbound import sanitize_im_links
    text = sanitize_im_links(reply.text) if platform in {"qq", "feishu", "wechat"} else reply.text
    unsupported = reply.unsupported_capabilities(platform or "")
    if unsupported and platform in {"qq", "feishu", "wechat"}:
        from agent.security import logsafe
        print(
            f"[im] {platform} 不支持回复能力: {','.join(unsupported)} "
            f"fp={logsafe.fingerprint(reply.text)}",
            flush=True,
        )
        return False
    if platform == "feishu" and reply.target.id:
        from agent.gateway import feishu
        result = await feishu.send_text(reply.target.id, text, payload.get("channel_id"))
        return result is not False
    elif platform == "qq" and reply.target.id:
        from agent.gateway import qq
        if reply.target.type == "group":
            mention_user_id = payload.get("platform_user_id")
            args = (
                reply.target.id,
                text,
                reply.reply_to_message_id,
                payload.get("channel_id"),
                payload.get("message_format"),
            )
            if mention_user_id:
                return await qq.send_group(*args, mention_user_id)
            return await qq.send_group(*args)
        return await qq.send_c2c(
            reply.target.id,
            text,
            reply.reply_to_message_id,
            payload.get("channel_id"),
            payload.get("message_format"),
        )
    elif platform == "wechat" and reply.target.id:
        from agent.gateway import wechat
        result = await wechat.send_text(
            reply.target.id,
            text,
            payload.get("channel_id"),
            payload.get("context_token", ""),
        )
        return result is not False
    else:
        from agent.security import logsafe
        print(
            f"[im] (无发送通道) {platform}: len={len(reply.text)} "
            f"fp={logsafe.fingerprint(reply.text)}",
            flush=True,
        )
        return False


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
    if platform == "qq":
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
    from agent.security import logsafe
    print(
        f"[im] wechat 发{label} fp={logsafe.fingerprint(fname)}: "
        f"{'ok' if ok else '失败'}（{len(data)} bytes）",
        flush=True,
    )
    return ok


async def _send_file_feishu(payload: dict, ext: str, data: bytes, fname: str) -> bool:
    from agent.gateway import feishu
    from agent.security import logsafe

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


def _fix_loose_bold(text: str) -> str:
    """修正 IM markdown 渲染器不接受的宽松加粗写法，代码片段保持原样。"""
    parts = _CODE_SPLIT_RE.split(text)
    for i in range(0, len(parts), 2):
        parts[i] = _BOLD_LEAD_WS_RE.sub(r'**\1**', parts[i])
        parts[i] = _BOLD_TRAIL_WS_RE.sub(r'**\1**', parts[i])
    return ''.join(parts)


async def send_agent_response(
    payload: dict,
    response: AgentResponse,
    *,
    already_sent_rounds: int | Set[int] = 0,
) -> str | None:
    """统一收尾一轮 AgentResponse：先发送附件，再按 round 发送文本说明。

    IM Loop 不再分别判断平台、文件和文本入口；平台 capability 由
    ``send_reply``/``send_file`` 统一检查，返回最终实际发送的文本。
    """
    from agent.im.files import send_files

    result = await send_files(payload, response.files)
    if result.failed:
        texts = [result.reason or "附件没有成功发出，你可以去网页或文件库查看。"]
    else:
        texts = [
            _fix_loose_bold(text)
            for text in (response.round_texts or [])
            if str(text or "").strip()
        ]
        if not texts:
            fallback = _fix_loose_bold(response.text or "")
            texts = [fallback] if fallback.strip() else (["给你～"] if response.files else ["嗯~在的，你说～"])

    # 每个 round 独立发送；返回值仍使用最后一条，供 trace/日志兼容。
    last_text = texts[-1]
    if isinstance(already_sent_rounds, int):
        sent_indices = set(range(max(0, already_sent_rounds)))
    else:
        sent_indices = {index for index in already_sent_rounds if index >= 0}
    for index, text in enumerate(texts):
        if index in sent_indices:
            continue
        if not await send_text(payload, text):
            return None
    return last_text
