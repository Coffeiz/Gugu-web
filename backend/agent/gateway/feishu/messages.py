"""飞书同步 SDK 消息、卡片、文件和 reaction 出站能力。"""
from __future__ import annotations

import asyncio
import json
import lark_oapi as lark

from app.core.redaction import diag_log, redact
from .cards import _build_card_elements


def _do_react(client, message_id: str, emoji_type: str) -> bool:
    """给某条消息加表情回应（同步，给 asyncio.to_thread 用）。失败返回 False。"""
    try:
        from lark_oapi.api.im.v1 import (
            CreateMessageReactionRequest, CreateMessageReactionRequestBody, Emoji,
        )
        req = (CreateMessageReactionRequest.builder().message_id(message_id).request_body(
            CreateMessageReactionRequestBody.builder()
            .reaction_type(Emoji.builder().emoji_type(emoji_type).build()).build()).build())
        resp = client.im.v1.message_reaction.create(req)
        if not resp.success():
            print(f"[feishu] reaction 失败: emoji={emoji_type} code={resp.code} msg={resp.msg}", flush=True)
            return False
        return True
    except Exception as e:
        diag_log("agent.gateway.feishu.reaction", e)   # 原始 → 受限诊断出口
        print(f"[feishu] reaction 出错: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False


async def react(channel_id: str, message_id: str, emoji_type: str) -> bool:
    """给飞书某条消息加表情回应（咕咕 react 工具用，按 channel 取凭据）。"""
    if not message_id or not emoji_type:
        return False
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id:
        print(f"[feishu] react {channel_id} 无凭据，跳过", flush=True)
        return False
    if channel_id not in _clients:
        _clients[channel_id] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    return await asyncio.to_thread(_do_react, _clients[channel_id], message_id, emoji_type)

_clients: dict = {}


async def _creds_by_id(bot_id: str) -> tuple[str, str]:
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import UserBot
    async with _sess._SessionLocal() as db:
        b = await db.get(UserBot, int(bot_id))
        return (b.app_id, b.app_secret) if b else ("", "")


def _do_send(client, receive_id: str, text: str) -> bool:
    from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody

    # 按前缀判断收件人类型：ou_=open_id（连接时存的 owner 地址）、oc_=chat_id（消息学到的会话）
    rid_type = "open_id" if str(receive_id).startswith("ou_") else "chat_id"

    def _create(msg_type: str, content: str) -> bool:
        req = (
            CreateMessageRequest.builder()
            .receive_id_type(rid_type)
            .request_body(
                CreateMessageRequestBody.builder()
                .receive_id(receive_id).msg_type(msg_type)
                .content(content)
                .build()
            ).build()
        )
        resp = client.im.v1.message.create(req)
        if not resp.success():
            print(f"[feishu] 发送失败({msg_type}): code={resp.code} msg={resp.msg}", flush=True)
            return False
        return True

    # 优先发交互卡片（markdown 元素渲染粗体/列表/代码，表格走原生 table 组件）；失败回退纯文本
    card = json.dumps({"elements": _build_card_elements(text)}, ensure_ascii=False)
    if _create("interactive", card):
        return True
    return _create("text", json.dumps({"text": text}, ensure_ascii=False))


def _do_send_interaction_card(client, receive_id: str, prompt: dict) -> bool:
    """发送带按钮的 Prompt 卡片；失败由调用方退回文本选项。"""
    from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody
    from agent.interactions.feishu import build_card_payload

    rid_type = "open_id" if str(receive_id).startswith("ou_") else "chat_id"
    content = json.dumps(build_card_payload(prompt), ensure_ascii=False)
    req = (
        CreateMessageRequest.builder()
        .receive_id_type(rid_type)
        .request_body(
            CreateMessageRequestBody.builder()
            .receive_id(receive_id)
            .msg_type("interactive")
            .content(content)
            .build()
        ).build()
    )
    resp = client.im.v1.message.create(req)
    if not resp.success():
        print(f"[feishu] 交互卡片发送失败: code={resp.code} msg={resp.msg}", flush=True)
        return False
    return True


async def send_text(receive_id: str, text: str, channel_id: str | None = None) -> bool:
    """给指定收件人发文本（chat_id 或 open_id 都行，用该 bot 的凭据）。lark API 同步，丢线程跑。"""
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id:
        print(f"[feishu] user_bot {channel_id} 无凭据，发送跳过", flush=True)
        return False
    if channel_id not in _clients:
        _clients[channel_id] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    return await asyncio.to_thread(_do_send, _clients[channel_id], receive_id, text)


def _build_link_card_payload(message: str, buttons: list[dict]) -> dict:
    """链接按钮的飞书卡片（PRD-LLM-24 §8.3）：markdown 正文 + open_url 按钮组。

    behaviors 用 open_url，由客户端直接打开 HTTPS 地址；不注册
    card.action.trigger 回调，不生成任何 action token。
    """
    action_buttons = [
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": str(button["label"])},
            "type": "primary",
            "behaviors": [{"type": "open_url", "default_url": str(button["url"])}],
        }
        for button in buttons
    ]
    elements: list[dict] = []
    if message.strip():
        elements.append({"tag": "markdown", "content": message.strip()})
    elements.append({"tag": "action", "actions": action_buttons})
    return {"config": {"wide_screen_mode": True}, "elements": elements}


def _do_send_link_card(client, receive_id: str, message: str, buttons: list[dict]) -> bool:
    from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody

    rid_type = "open_id" if str(receive_id).startswith("ou_") else "chat_id"
    content = json.dumps(_build_link_card_payload(message, buttons), ensure_ascii=False)
    req = (
        CreateMessageRequest.builder()
        .receive_id_type(rid_type)
        .request_body(
            CreateMessageRequestBody.builder()
            .receive_id(receive_id)
            .msg_type("interactive")
            .content(content)
            .build()
        ).build()
    )
    resp = client.im.v1.message.create(req)
    if not resp.success():
        print(f"[feishu] 链接卡片发送失败: code={resp.code} msg={resp.msg}", flush=True)
        return False
    return True


async def send_link_card(receive_id: str, message: str, buttons: list[dict],
                         channel_id: str | None = None) -> bool:
    """发送链接按钮卡片；失败由统一出站层退回文本 URL。"""
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id or not receive_id:
        return False
    if channel_id not in _clients:
        _clients[channel_id] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    try:
        return await asyncio.to_thread(
            _do_send_link_card, _clients[channel_id], receive_id, message, buttons
        )
    except Exception as e:
        diag_log("agent.gateway.feishu.send_link_card", e)
        print(f"[feishu] 链接卡片发送异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False


async def send_interaction_card(receive_id: str, prompt: dict,
                                channel_id: str | None = None) -> bool:
    """发送飞书原生交互卡片。"""
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id or not receive_id:
        return False
    if channel_id not in _clients:
        _clients[channel_id] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    try:
        return await asyncio.to_thread(
            _do_send_interaction_card, _clients[channel_id], receive_id, prompt
        )
    except Exception as e:
        diag_log("agent.gateway.feishu.send_interaction_card", e)
        print(f"[feishu] 交互卡片发送异常: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False

_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}


def _feishu_file_type(ext: str) -> str:
    if ext in ("pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"):
        return {"docx": "doc", "xlsx": "xls", "pptx": "ppt"}.get(ext, ext)
    if ext in ("ogg", "opus"):
        return "opus"
    if ext == "mp4":
        return "mp4"
    return "stream"


def _do_send_file(client, chat_id: str, data: bytes, name: str, ext: str) -> bool:
    import io
    from lark_oapi.api.im.v1 import (
        CreateImageRequest, CreateImageRequestBody,
        CreateFileRequest, CreateFileRequestBody,
        CreateMessageRequest, CreateMessageRequestBody,
    )
    ext_l = (ext or "").lower()
    fname = f"{name}.{ext_l}" if ext_l else name
    try:
        if ext_l in _IMAGE_EXTS:
            up = client.im.v1.image.create(CreateImageRequest.builder().request_body(
                CreateImageRequestBody.builder().image_type("message").image(io.BytesIO(data)).build()).build())
            if not up.success():
                print(f"[feishu] 图片上传失败: code={up.code} msg={up.msg}", flush=True)
                return False
            msg_type, content = "image", json.dumps({"image_key": up.data.image_key})
        else:
            up = client.im.v1.file.create(CreateFileRequest.builder().request_body(
                CreateFileRequestBody.builder().file_type(_feishu_file_type(ext_l)).file_name(fname)
                .file(io.BytesIO(data)).build()).build())
            if not up.success():
                print(f"[feishu] 文件上传失败: code={up.code} msg={up.msg}", flush=True)
                return False
            msg_type, content = "file", json.dumps({"file_key": up.data.file_key})
        req = (CreateMessageRequest.builder().receive_id_type("chat_id").request_body(
            CreateMessageRequestBody.builder().receive_id(chat_id).msg_type(msg_type).content(content).build()).build())
        resp = client.im.v1.message.create(req)
        if not resp.success():
            print(f"[feishu] 发文件消息失败: code={resp.code} msg={resp.msg}", flush=True)
            return False
        return True
    except Exception as e:
        diag_log("agent.gateway.feishu.send_file", e)   # 原始 → 受限诊断出口
        print(f"[feishu] 发文件出错: {redact(f'{type(e).__name__}: {e}')}", flush=True)
        return False


async def send_file(chat_id: str, data: bytes, name: str, ext: str, channel_id: str | None = None) -> bool:
    """把文件字节上传到飞书并发到会话（图片走 image、其余走 file）。"""
    app_id, app_secret = await _creds_by_id(channel_id)
    if not app_id:
        return False
    if channel_id not in _clients:
        _clients[channel_id] = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    return await asyncio.to_thread(_do_send_file, _clients[channel_id], chat_id, data, name, ext)
