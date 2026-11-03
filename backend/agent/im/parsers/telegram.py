"""Telegram Bot API 消息/命令解析，不执行网络请求或身份授权。"""
from __future__ import annotations

import re
from typing import Any


def _utf16_index(text: str, offset: int) -> int:
    """Telegram entity 的 UTF-16 code-unit offset 转 Python 字符索引。"""
    units = 0
    for index, char in enumerate(text):
        if units >= offset:
            return index
        units += 2 if ord(char) > 0xFFFF else 1
    return len(text)


def entity_text(text: str, entity: dict[str, Any]) -> str:
    try:
        offset = max(0, int(entity.get("offset", 0)))
        length = max(0, int(entity.get("length", 0)))
    except (TypeError, ValueError):
        return ""
    start = _utf16_index(text, offset)
    end = _utf16_index(text, offset + length)
    return text[start:end]


def normalize_command(text: str, entities: list[dict[str, Any]], bot_username: str) -> tuple[str, str] | None:
    """解析首个 bot_command；其他 Bot 的定向命令拒绝消费。"""
    for entity in entities:
        if entity.get("type") != "bot_command":
            continue
        command = entity_text(text, entity)
        match = re.fullmatch(r"/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?", command)
        if not match:
            return None
        target = match.group(2)
        if target and target.casefold() != str(bot_username or "").lstrip("@").casefold():
            return None
        remainder = text[_utf16_index(text, int(entity.get("offset", 0)) + int(entity.get("length", 0))):].strip()
        return match.group(1).casefold(), remainder
    # 兼容带 command entity 缺失的模拟器/旧事件，但仍限定完整首段格式。
    match = re.match(r"^/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+|$)", text or "")
    if not match:
        return None
    target = match.group(2)
    if target and target.casefold() != str(bot_username or "").lstrip("@").casefold():
        return None
    return match.group(1).casefold(), text[match.end():].strip()


def display_name(sender: Any) -> str | None:
    if not isinstance(sender, dict):
        return None
    parts = [str(sender.get(key) or "").strip() for key in ("first_name", "last_name")]
    name = " ".join(part for part in parts if part)
    return name or (f"@{sender['username']}" if sender.get("username") else None)


def _normalize_bot_mention(text: str, bot_username: str) -> str:
    """把当前 Bot 的 Telegram 用户名统一显示为咕咕，其他 Bot 名称保持原样。"""
    username = str(bot_username or "").strip().lstrip("@")
    if not username:
        return text
    pattern = re.compile(rf"(?<![A-Za-z0-9_])@{re.escape(username)}(?![A-Za-z0-9_])", re.IGNORECASE)
    return pattern.sub("@咕咕", text)


def _message_key(bot_id: str, chat_id: Any, message_id: Any) -> str:
    """Telegram message_id 仅在 chat 内唯一；暂存引用键必须包含 Bot 与 chat。"""
    return f"{bot_id}:{chat_id}:{message_id}"


def _media_item(message: dict[str, Any]) -> dict[str, Any] | None:
    """把 Bot API 的单种媒体字段映射为下载所需的最小元数据。"""
    def file_size(item: dict[str, Any]) -> int:
        value = item.get("file_size")
        return value if isinstance(value, int) and not isinstance(value, bool) else 0

    photo = message.get("photo")
    if isinstance(photo, list) and photo:
        candidates = [item for item in photo if isinstance(item, dict) and item.get("file_id")]
        if candidates:
            selected = max(candidates, key=file_size)
            return {
                "file_id": selected["file_id"],
                "file_size": selected.get("file_size"),
                "file_name": "图片.jpg",
                "mime_type": "image/jpeg",
                "media_type": "photo",
            }

    for field, default_name, default_mime, media_type in (
        ("document", "文件", "application/octet-stream", "document"),
        ("audio", "音频", "audio/mpeg", "audio"),
        ("voice", "语音.ogg", "audio/ogg", "voice"),
        ("video", "视频.mp4", "video/mp4", "video"),
        ("animation", "动画.mp4", "video/mp4", "animation"),
        ("video_note", "视频消息.mp4", "video/mp4", "video_note"),
    ):
        item = message.get(field)
        if isinstance(item, dict) and item.get("file_id"):
            name = str(item.get("file_name") or default_name)
            mime = str(item.get("mime_type") or default_mime)
            return {
                "file_id": item["file_id"],
                "file_size": item.get("file_size"),
                "file_name": name,
                "mime_type": mime,
                "media_type": media_type,
            }
    return None


def native_bot_is_mentioned(message: dict[str, Any], *, bot_id: str, bot_username: str) -> bool:
    """只判断原生 mention/命令；引用 Bot 回复另作为可信 CONTINUE 关系处理。"""
    text = str(message.get("text") or message.get("caption") or "")
    entities = message.get("entities") or message.get("caption_entities") or []
    username = str(bot_username or "").lstrip("@").casefold()
    for entity in entities if isinstance(entities, list) else []:
        if not isinstance(entity, dict):
            continue
        kind = entity.get("type")
        if kind == "text_mention":
            user = entity.get("user")
            if isinstance(user, dict) and str(user.get("id")) == str(bot_id):
                return True
        elif kind == "mention" and username:
            if entity_text(text, entity).lstrip("@").casefold() == username:
                return True
        elif kind == "bot_command":
            command = entity_text(text, entity)
            match = re.fullmatch(r"/[^@\s]+@([A-Za-z0-9_]+)", command)
            if not match:
                # Telegram 只会把 Privacy Mode 下可见的通用命令投递给相关 Bot
                # （例如最近一次发言的 Bot）；收到它本身就是有效触发信号。
                return True
            if username and match.group(1).casefold() == username:
                return True
    return False


def bot_is_mentioned(message: dict[str, Any], *, bot_id: str, bot_username: str) -> bool:
    """兼容既有 reply_mentions 路由：原生 mention 或直接回复 Bot 都可触发。"""
    if native_bot_is_mentioned(message, bot_id=bot_id, bot_username=bot_username):
        return True
    reply = message.get("reply_to_message")
    reply_sender = reply.get("from") if isinstance(reply, dict) else None
    return bool(isinstance(reply_sender, dict) and str(reply_sender.get("id")) == str(bot_id))


def _other_mention_facts(message: dict[str, Any], *, bot_id: str, bot_username: str) -> tuple[bool | None, bool | None]:
    entities = message.get("entities") or message.get("caption_entities")
    if not isinstance(entities, list):
        return None, None
    text = str(message.get("text") or message.get("caption") or "")
    username = str(bot_username or "").lstrip("@").casefold()
    other_target = False
    other_bot = False
    recognized = False
    unresolved = False
    for entity in entities:
        if not isinstance(entity, dict):
            continue
        kind = entity.get("type")
        if kind == "text_mention":
            target = entity.get("user")
            if not isinstance(target, dict) or target.get("id") is None:
                continue
            recognized = True
            if str(target.get("id")) != str(bot_id):
                other_target = True
                other_bot = other_bot or target.get("is_bot") is True
        elif kind == "mention":
            target_name = entity_text(text, entity).lstrip("@").casefold()
            if not target_name:
                continue
            recognized = True
            if not username or target_name != username:
                unresolved = True
        elif kind == "bot_command":
            target_name = entity_text(text, entity)
            match = re.fullmatch(r"/[^@\s]+@([A-Za-z0-9_]+)", target_name)
            if match:
                recognized = True
                if username and match.group(1).casefold() != username:
                    other_target = True
                    other_bot = True
    if unresolved:
        return (other_target if other_target else None), (other_bot if other_bot else None)
    return (other_target if recognized else None), (other_bot if recognized else None)


def _attention_mention_facts(
    message: dict[str, Any], *, bot_id: str, bot_username: str,
) -> tuple[bool | None, bool | None, bool | None, bool]:
    entities = message.get("entities")
    if entities is None:
        entities = message.get("caption_entities")
    text = str(message.get("text") or message.get("caption") or "")
    unresolved_text_mention = bool(re.search(r"(?<![A-Za-z0-9_])@[A-Za-z0-9_]+", text))
    if not isinstance(entities, list):
        return (None if unresolved_text_mention else False), None, None, unresolved_text_mention
    current = False
    other_bot = False
    other_member = False
    unresolved = False
    username = str(bot_username or "").lstrip("@").casefold()
    for entity in entities:
        if not isinstance(entity, dict):
            unresolved = True
            continue
        kind = entity.get("type")
        if kind == "text_mention":
            target = entity.get("user")
            if not isinstance(target, dict) or target.get("id") is None:
                unresolved = True
                continue
            if str(target.get("id")) == str(bot_id):
                current = True
            else:
                other_member = True
                if target.get("is_bot") is True:
                    other_bot = True
        elif kind == "mention":
            target_name = entity_text(text, entity).lstrip("@").casefold()
            if not target_name:
                unresolved = True
            elif username and target_name == username:
                current = True
            else:
                unresolved = True
        elif kind == "bot_command":
            command = entity_text(text, entity)
            match = re.fullmatch(r"/[^@\s]+@([A-Za-z0-9_]+)", command)
            if match and username and match.group(1).casefold() != username:
                other_bot = True
    if unresolved:
        return (current if current else None), (other_bot if other_bot else None), (other_member if other_member else None), True
    return current, other_bot, other_member, False


def normalize_message(update: dict[str, Any], *, bot_id: str, owner_id: str,
                      bot_username: str, bot_platform_id: str | None = None) -> dict[str, Any] | None:
    """返回 IM 入站 payload；非用户消息和不支持的空事件不触发 Agent。"""
    message = update.get("message") or update.get("edited_message")
    if not isinstance(message, dict):
        return None
    chat = message.get("chat") or {}
    sender = message.get("from")
    if not isinstance(chat, dict) or not isinstance(sender, dict):
        return None
    sender_id = sender.get("id")
    if sender.get("is_bot") or sender_id is None:
        return None
    media = _media_item(message)
    text = message.get("text") or message.get("caption") or ""
    if not isinstance(text, str):
        text = ""
    if not text.strip() and media is None:
        return None
    chat_type = str(chat.get("type") or "")
    if chat_type not in {"private", "group", "supergroup"}:
        return None
    entities = message.get("entities") or message.get("caption_entities") or []
    if not isinstance(entities, list):
        entities = []
    parsed_command = (
        normalize_command(text, entities, bot_username)
        if isinstance(message.get("text"), str) else None
    )
    if text.lstrip().startswith("/") and parsed_command is None:
        return None
    content = _normalize_bot_mention(text, bot_username)
    if parsed_command:
        command, args = parsed_command
        content = f"/{command} {args}".strip()
    reply = message.get("reply_to_message")
    native_mentioned = native_bot_is_mentioned(
        message, bot_id=str(bot_platform_id or ""), bot_username=bot_username
    )
    # Telegram 的实际更新只包含平台投递给当前 Bot 的命令。命令实体缺失时
    # 仍使用已校验目标 Bot 的 parser 结果，不把定向给其他 Bot 的命令当触发。
    mentioned = native_mentioned or parsed_command is not None or bot_is_mentioned(
        message, bot_id=str(bot_platform_id or ""), bot_username=bot_username
    )
    other_mention, other_bot_mention = _other_mention_facts(
        message, bot_id=str(bot_platform_id or ""), bot_username=bot_username,
    )
    attention_mentions = _attention_mention_facts(
        message, bot_id=str(bot_platform_id or ""), bot_username=bot_username,
    )
    chat_id = chat.get("id") or ""
    attachments = [{**media, "source_attachment_index": 0}] if media else []
    quoted_attachments = []
    if isinstance(reply, dict):
        quoted_media = _media_item(reply)
        if quoted_media and reply.get("message_id") is not None:
            quoted_attachments.append({
                **quoted_media,
                "source_platform_message_id": _message_key(
                    bot_id, chat_id, reply["message_id"]
                ),
                "source_attachment_index": 0,
            })
    quoted_text = str(reply.get("text") or reply.get("caption") or "").strip() if isinstance(reply, dict) else ""
    if not quoted_text and isinstance(reply, dict):
        quoted_media = _media_item(reply)
        if quoted_media:
            quoted_text = f"[{quoted_media['media_type']} 附件]"
    return {
        "platform": "telegram",
        "channel_id": str(bot_id),
        "bot_id": str(bot_id),
        "owner_user_id": str(owner_id),
        "chat_type": "c2c" if chat_type == "private" else "group",
        "chat_id": str(chat_id),
        "platform_user_id": str(sender_id),
        "platform_user_name": display_name(sender),
        "message_id": str(message.get("message_id") or ""),
        "platform_event_id": str(update.get("update_id") or ""),
        "text": content,
        "attention_raw_text": text,
        "attachments": attachments,
        "quoted_attachments": quoted_attachments,
        "attachment_source_message_id": (
            _message_key(bot_id, chat_id, message.get("message_id"))
            if media and message.get("message_id") is not None else None
        ),
        "bot_mentioned": mentioned,
        "native_bot_mentioned": True if native_mentioned or parsed_command is not None else attention_mentions[0],
        "mentions_other_member": attention_mentions[2] if attention_mentions[2] is not None else other_mention,
        "mentions_other_bot": attention_mentions[1] if attention_mentions[1] is not None else other_bot_mention,
        "has_unresolved_mention": attention_mentions[3],
        "group_mentioned": mentioned if chat_type != "private" else False,
        "reply_to_message_id": str(reply.get("message_id")) if isinstance(reply, dict) and reply.get("message_id") is not None else None,
        "reply_to_platform_message_id": str(reply.get("message_id")) if isinstance(reply, dict) and reply.get("message_id") is not None else None,
        "reply_target_sender_id": str(reply.get("from", {}).get("id")) if isinstance(reply, dict) and isinstance(reply.get("from"), dict) and reply.get("from", {}).get("id") is not None else None,
        "reply_target_is_bot": reply.get("from", {}).get("is_bot") if isinstance(reply, dict) and isinstance(reply.get("from", {}).get("is_bot"), bool) else None,
        "platform_sent_ms": int(message.get("date") * 1000) if isinstance(message.get("date"), (int, float)) and not isinstance(message.get("date"), bool) and message.get("date") > 0 else None,
        "sender_is_bot": False,
        "quoted_text": quoted_text[:2000] or None,
        "telegram_command": parsed_command[0] if parsed_command else None,
        "received_at": message.get("date"),
    }
