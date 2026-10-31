"""群聊自动回复的确定性注意力分类与评分。"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Mapping

ATTENTION_ALGORITHM_VERSION = "attention-v3.0.6"
MEMBER_ACTIVE_TTL_MS = 180_000
DEFAULT_ACTIVE_THRESHOLD = 55
DEFAULT_NATURAL_THRESHOLD = 65
DEFAULT_QUIET_THRESHOLD = 85


class AttentionMode(StrEnum):
    QUIET = "quiet"
    NATURAL = "natural"
    ACTIVE = "active"
    AUTONOMOUS = "autonomous"


class AttentionKind(StrEnum):
    ALLOW_RUN = "ALLOW_RUN"
    DIRECT = "DIRECT"
    CONTINUE = "CONTINUE"
    CAPABILITY_ACTION = "CAPABILITY_ACTION"
    MEMBER_ACTIVE = "MEMBER_ACTIVE"
    PROACTIVE = "PROACTIVE"
    EXCLUDED = "EXCLUDED"
    PASSIVE = "PASSIVE"


@dataclass(frozen=True, slots=True)
class AttentionMessage:
    """单条入站消息的注意力事实；字段只能来自平台结构或 Redis Stream。"""

    event_id: str
    platform: str
    bot_id: str
    group_id: str
    platform_message_id: str | None
    sender_id: str | None
    event_received_ms: int
    platform_sent_ms: int | None
    raw_text: str
    media_only: bool
    media_kinds: tuple[str, ...]
    processable_media: bool | None
    mentioned_current_bot: bool | None
    mentioned_other_bot: bool | None
    mentioned_other_member: bool | None
    has_unresolved_mention: bool
    reply_to_platform_message_id: str | None
    reply_target_sender_id: str | None
    reply_target_is_bot: bool | None
    quote_text: str | None
    sender_is_bot: bool | None = None
    candidate_text: str | None = None

    @classmethod
    def from_payload(cls, event_id: str, payload: Mapping[str, object]) -> "AttentionMessage":
        """从已规范化 Gateway payload 构造输入。事件时间只接受 Redis Stream ID。"""
        stream_ms = _stream_event_ms(event_id)
        text = str(payload.get("attention_raw_text", payload.get("text")) or "")
        attachments = payload.get("attachments")
        explicit_media_kinds = payload.get("media_kinds")
        media_kinds = (
            tuple(sorted({str(item).lower() for item in explicit_media_kinds if item}))
            if isinstance(explicit_media_kinds, (list, tuple))
            else _media_kinds(attachments)
        )
        explicit_media_only = payload.get("media_only")
        media_only = (
            bool(explicit_media_only)
            if isinstance(explicit_media_only, bool)
            else not text.strip() and bool(media_kinds)
        )
        processable = payload.get("processable_media")
        if not isinstance(processable, bool):
            processable = None
        platform = str(payload.get("platform") or "")
        bot_id = str(payload.get("bot_id") or payload.get("channel_id") or "")
        group_id = str(payload.get("chat_id") or "")
        if not platform or not bot_id or not group_id:
            raise AttentionInputError("注意力门控缺少平台、Bot 或群作用域")
        return cls(
            event_id=str(event_id),
            platform=platform,
            bot_id=bot_id,
            group_id=group_id,
            platform_message_id=_optional_text(payload.get("platform_message_id") or payload.get("message_id")),
            sender_id=_optional_text(payload.get("platform_user_id")),
            event_received_ms=stream_ms,
            platform_sent_ms=_optional_millis(
                payload.get("platform_sent_ms", payload.get("_platform_sent_ms"))
            ),
            raw_text=text,
            media_only=media_only,
            media_kinds=media_kinds,
            processable_media=processable,
            mentioned_current_bot=_optional_bool(payload.get("native_bot_mentioned")),
            mentioned_other_bot=_optional_bool(payload.get("mentions_other_bot")),
            mentioned_other_member=_optional_bool(payload.get("mentions_other_member")),
            has_unresolved_mention=(
                payload.get("has_unresolved_mention") is True
                or (
                    payload.get("native_bot_mentioned") is None
                    and bool(re.search(r"(?<![A-Za-z0-9_])@[A-Za-z0-9_]+", text))
                )
            ),
            reply_to_platform_message_id=_optional_text(
                payload.get("reply_to_platform_message_id") or payload.get("reply_to_message_id")
            ),
            reply_target_sender_id=_optional_text(payload.get("reply_target_sender_id")),
            reply_target_is_bot=_optional_bool(payload.get("reply_target_is_bot")),
            quote_text=_optional_text(payload.get("quoted_text")),
            sender_is_bot=_optional_bool(payload.get("sender_is_bot")),
            candidate_text=text,
        )


@dataclass(frozen=True, slots=True)
class BotReplyFact:
    platform_message_id: str
    sent_at_ms: int
    recipient_sender_id: str | None
    accepted: bool
    proactive: bool = False
    source_attention_kind: str | None = None
    final_text: str | None = None
    delivery_id: str | None = None


@dataclass(frozen=True, slots=True)
class AttentionSnapshot:
    """单一稳定水位上的可用历史；缺失资料不等同于否定事实。"""

    messages: tuple[AttentionMessage, ...] = ()
    complete: bool = False
    bot_replies: Mapping[str, BotReplyFact] = field(default_factory=dict)
    window_truncated: bool | None = None
    # 只允许由出站投递账本的确定性链接填充；assistant 历史行不可代替。
    latest_accepted_final: BotReplyFact | None = None
    accepted_outbound_facts: tuple[BotReplyFact, ...] = ()


@dataclass(frozen=True, slots=True)
class AttentionDecision:
    kind: AttentionKind
    score: float | None
    threshold: int | None
    reasons: tuple[str, ...]
    score_breakdown: tuple[tuple[str, float], ...] = ()
    state: str | None = None
    scene_type: str | None = None
    scene_score: float = 0.0
    topic_score: float = 0.0
    topic_raw_score: float = 0.0
    anchor_event_id: str | None = None
    topic_match_event_id: str | None = None
    matched_span_lengths: tuple[int, int] | None = None
    ask_raw_score: float = 0.0
    ask_position_weight: float = 1.0
    ask_punctuation_weight: float = 1.0
    ask_adjusted_score: float = 0.0
    ask_span_start: int | None = None
    ask_span_end: int | None = None
    capability_strength: str | None = None
    capability_span_start: int | None = None
    capability_span_end: int | None = None
    capability_position_weight: float | None = None


class AttentionInputError(ValueError):
    """输入缺少可信 Redis 事件 ID 或无法解析事件时间。"""


def _stream_event_ms(event_id: str) -> int:
    head, separator, tail = str(event_id).partition("-")
    if not separator or not tail:
        raise AttentionInputError("Redis Stream event_id 格式无效")
    try:
        value = int(head)
        int(tail)
    except (TypeError, ValueError) as exc:
        raise AttentionInputError("Redis Stream event_id 缺少可信到达时间") from exc
    if value <= 0:
        raise AttentionInputError("Redis Stream event_id 缺少可信到达时间")
    return value


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_bool(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _optional_millis(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        result = int(value) if value is not None else 0
    except (TypeError, ValueError):
        return None
    if result <= 0:
        return None
    return result * 1000 if result < 10_000_000_000 else result


def _media_kinds(value: object) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    result = set()
    for item in value:
        if isinstance(item, dict):
            raw = str(item.get("media_kind") or item.get("media_type") or item.get("type") or "").lower()
            mime = str(item.get("mime_type") or "").lower()
            aliases = {"photo": "image", "picture": "image", "document": "file", "voice": "audio", "animation": "video"}
            result.add(aliases.get(raw, raw or mime.split("/", 1)[0] or "unknown"))
        elif isinstance(item, str):
            result.add("unknown")
    return tuple(sorted(result))


def build_logical_candidates(*args, **kwargs):
    from agent.im.auto_reply.attention_algorithm import build_logical_candidates as implementation
    return implementation(*args, **kwargs)


def decide_attention(*args, **kwargs):
    from agent.im.auto_reply.attention_algorithm import decide_attention as implementation
    return implementation(*args, **kwargs)


def normalize_text(*args, **kwargs):
    from agent.im.auto_reply.attention_algorithm import normalize_text as implementation
    return implementation(*args, **kwargs)


def score_attention(*args, **kwargs):
    from agent.im.auto_reply.attention_algorithm import score_attention as implementation
    return implementation(*args, **kwargs)

__all__ = [
    "AttentionDecision", "AttentionInputError", "AttentionKind", "AttentionMessage",
    "AttentionMode", "AttentionSnapshot", "BotReplyFact", "ATTENTION_ALGORITHM_VERSION",
    "DEFAULT_ACTIVE_THRESHOLD", "DEFAULT_NATURAL_THRESHOLD", "DEFAULT_QUIET_THRESHOLD",
    "MEMBER_ACTIVE_TTL_MS",
    "build_logical_candidates", "decide_attention", "normalize_text", "score_attention",
]
