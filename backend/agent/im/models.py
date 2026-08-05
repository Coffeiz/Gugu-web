"""IM 平台无关的入站/出站协议。

平台 adapter 仍可暂时保留旧 dict payload；``PlatformMessage`` 提供兼容转换，
让后续 IM Loop 不再依赖 QQ、飞书或微信 SDK 的事件对象。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple


REPLY_CAPABILITY_TEXT = "text"
REPLY_CAPABILITY_FILE = "file"
REPLY_CAPABILITY_IMAGE = "image"
REPLY_CAPABILITY_REPLY = "reply"
REPLY_CAPABILITY_KEYBOARD = "keyboard"
REPLY_CAPABILITY_STREAM = "stream"

_PLATFORM_REPLY_CAPABILITIES = {
    "qq": frozenset({
        REPLY_CAPABILITY_TEXT,
        REPLY_CAPABILITY_FILE,
        REPLY_CAPABILITY_IMAGE,
        REPLY_CAPABILITY_REPLY,
    }),
    "feishu": frozenset({
        REPLY_CAPABILITY_TEXT,
        REPLY_CAPABILITY_FILE,
        REPLY_CAPABILITY_IMAGE,
        REPLY_CAPABILITY_REPLY,
        REPLY_CAPABILITY_KEYBOARD,
        REPLY_CAPABILITY_STREAM,
    }),
    "wechat": frozenset({
        REPLY_CAPABILITY_TEXT,
        REPLY_CAPABILITY_FILE,
        REPLY_CAPABILITY_IMAGE,
        REPLY_CAPABILITY_REPLY,
    }),
}


def replace_mention_ids(text: str, names: Dict[str, str]) -> str:
    """只替换可见文本中的平台 mention，保留身份字段和未解析的 ID。"""
    result = text or ""
    for platform_user_id, name in names.items():
        if not platform_user_id or not name:
            continue
        escaped_id = re.escape(str(platform_user_id))
        result = re.sub(
            rf"<@!?{escaped_id}>|@{escaped_id}",
            lambda _match, display_name=name: f"@{display_name}",
            result,
        )
    return result

_PART_CAPABILITIES = {
    "text": REPLY_CAPABILITY_TEXT,
    "file": REPLY_CAPABILITY_FILE,
    "image": REPLY_CAPABILITY_IMAGE,
    "keyboard": REPLY_CAPABILITY_KEYBOARD,
    "stream": REPLY_CAPABILITY_STREAM,
}


def supported_reply_capabilities(platform: str) -> frozenset:
    """返回平台协议支持的出站能力，未知平台不默认放行。"""
    return _PLATFORM_REPLY_CAPABILITIES.get(platform, frozenset())


def extract_platform_user_id(payload: Dict[str, Any]) -> str:
    """从归一化或原始平台 payload 提取当前发言人的稳定平台 ID。"""
    direct = payload.get("platform_user_id")
    if direct:
        return str(direct)

    candidates = []
    sources = [payload.get("sender"), payload.get("author"), payload]
    nested_sources = []
    for source in sources:
        if not isinstance(source, dict):
            continue
        nested_sender_id = source.get("sender_id")
        if isinstance(nested_sender_id, dict):
            nested_sources.append(nested_sender_id)
    for source in (*sources, *nested_sources):
        if not isinstance(source, dict):
            continue
        candidates.extend(
            source.get(key)
            for key in (
                "user_openid", "member_openid", "open_id", "openid",
                "user_id", "id", "from_user",
            )
        )
    return next((str(value) for value in candidates if value and not isinstance(value, dict)), "")


def normalize_chat_type(platform: str, chat_type: Any) -> str:
    """将各平台的会话类型归一到 IM 内部协议。

    飞书私聊事件使用 ``p2p``，权限和会话路由内部统一使用 ``c2c``。
    """
    value = str(chat_type or "").strip().lower()
    if platform == "feishu" and value == "p2p":
        return "c2c"
    return value


@dataclass(frozen=True)
class ChatTarget:
    id: str
    type: str = "c2c"


@dataclass(frozen=True)
class PlatformSender:
    id: str
    name: Optional[str] = None


@dataclass(frozen=True)
class PlatformMessage:
    platform: str
    bot_id: Optional[str]
    message_id: str
    chat: ChatTarget
    sender: PlatformSender
    content: str = ""
    attachments: List[Dict[str, Any]] = field(default_factory=list)
    quoted_text: Optional[str] = None
    mentioned: bool = False
    received_at: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: Dict[str, Any]) -> "PlatformMessage":
        """从现有网关 dict 生成统一消息，不改变原 payload 的额外业务字段。"""
        platform = str(payload.get("platform") or "")
        group_id = payload.get("chat_id") or payload.get("wechat_group_id")
        chat_type = normalize_chat_type(
            platform,
            payload.get("chat_type") or ("group" if group_id else "c2c"),
        )
        chat_id = str(group_id or payload.get("platform_user_id") or "")
        sender_id = extract_platform_user_id(payload)
        bot_id = payload.get("bot_id") or payload.get("channel_id")
        attachments = payload.get("attachments") or []
        if not isinstance(attachments, list):
            attachments = []
        return cls(
            platform=platform,
            bot_id=str(bot_id) if bot_id is not None else None,
            message_id=str(payload.get("message_id") or ""),
            chat=ChatTarget(id=chat_id, type=chat_type),
            sender=PlatformSender(
                id=sender_id,
                name=payload.get("platform_user_name"),
            ),
            content=str(payload.get("text") or ""),
            attachments=list(attachments),
            quoted_text=payload.get("quoted_text"),
            mentioned=bool(payload.get("group_mentioned")),
            received_at=payload.get("received_at"),
            metadata={
                key: value
                for key, value in payload.items()
                if key not in {
                    "platform", "bot_id", "channel_id", "message_id", "chat_id", "chat_type",
                    "platform_user_id", "platform_user_name", "text", "attachments",
                    "quoted_text", "group_mentioned", "received_at",
                }
            },
        )

    def to_payload(self, original: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """转回兼容 payload，保留当前 worker 尚未迁移的字段。"""
        payload = dict(original or self.metadata)
        payload.update({
            "platform": self.platform,
            "bot_id": self.bot_id,
            "channel_id": self.bot_id,
            "message_id": self.message_id,
            "chat_type": self.chat.type,
            "platform_user_id": self.sender.id,
            "platform_user_name": self.sender.name,
            "text": self.content,
            "attachments": list(self.attachments),
            "quoted_text": self.quoted_text,
            "group_mentioned": self.mentioned,
        })
        # 私聊旧 payload 没有 chat_id；不要为了协议归一化改变旧 worker 的路由语义。
        if self.chat.type == "group" or "chat_id" in payload or (
            self.platform == "wechat" and payload.get("wechat_group_id")
        ):
            payload["chat_id"] = self.chat.id
            if self.platform == "wechat":
                payload["wechat_group_id"] = self.chat.id
        else:
            payload.pop("chat_id", None)
        return payload


def normalize_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """将旧 adapter payload 经统一协议校验后返回兼容 dict。"""
    return PlatformMessage.from_payload(payload).to_payload(payload)


@dataclass(frozen=True)
class PlatformReply:
    target: ChatTarget
    parts: List[Dict[str, Any]] = field(default_factory=list)
    reply_to_message_id: Optional[str] = None
    capabilities: Tuple[str, ...] = (REPLY_CAPABILITY_TEXT,)

    @classmethod
    def from_parts(
        cls,
        payload: Dict[str, Any],
        parts: List[Dict[str, Any]],
        *,
        reply_to_message_id: Optional[str] = None,
    ) -> "PlatformReply":
        """从统一 parts 构造回复，并根据 part 类型推导能力声明。"""
        group_id = payload.get("chat_id") or payload.get("wechat_group_id")
        chat_type = str(payload.get("chat_type") or ("group" if group_id else "c2c"))
        target_id = group_id if chat_type == "group" else payload.get("platform_user_id")
        inferred = tuple(
            dict.fromkeys(
                capability
                for part in parts
                if (capability := _PART_CAPABILITIES.get(str(part.get("type") or "")))
            )
        )
        reply_id = reply_to_message_id or payload.get("message_id")
        if reply_id:
            inferred = (*inferred, REPLY_CAPABILITY_REPLY)
        return cls(
            target=ChatTarget(id=str(target_id or ""), type=chat_type),
            parts=list(parts),
            reply_to_message_id=reply_id,
            capabilities=tuple(dict.fromkeys(inferred)),
        )

    @classmethod
    def from_text(cls, payload: Dict[str, Any], text: str) -> "PlatformReply":
        """从现有 worker payload 构造文本回复协议。"""
        return cls.from_parts(payload, [{"type": "text", "text": text}])

    @property
    def required_capabilities(self) -> Tuple[str, ...]:
        """从 parts 重新推导能力，避免手工声明漏掉新增 part 类型。"""
        return tuple(
            dict.fromkeys(
                capability
                for part in self.parts
                if (capability := _PART_CAPABILITIES.get(str(part.get("type") or "")))
            )
        )

    def unsupported_capabilities(self, platform: str) -> Tuple[str, ...]:
        """返回该回复在目标平台上未声明支持的能力。"""
        supported = supported_reply_capabilities(platform)
        required = (*self.capabilities, *self.required_capabilities)
        return tuple(dict.fromkeys(capability for capability in required if capability not in supported))

    @property
    def text(self) -> str:
        """兼容当前文本发送链路；非文本 part 不参与本属性。"""
        return "\n".join(
            str(part.get("text") or "")
            for part in self.parts
            if part.get("type") == "text"
        )
