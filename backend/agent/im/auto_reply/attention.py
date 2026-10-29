"""群聊自动回复的确定性注意力分类与评分。"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Mapping


class AttentionMode(StrEnum):
    QUIET = "quiet"
    NATURAL = "natural"
    ACTIVE = "active"
    AUTONOMOUS = "autonomous"


class AttentionKind(StrEnum):
    ALLOW_RUN = "ALLOW_RUN"
    DIRECT = "DIRECT"
    CONTINUE = "CONTINUE"
    SOFT_CONTINUE = "SOFT_CONTINUE"
    PROACTIVE = "PROACTIVE"
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


@dataclass(frozen=True, slots=True)
class AttentionSnapshot:
    """单一稳定水位上的可用历史；缺失资料不等同于否定事实。"""

    messages: tuple[AttentionMessage, ...] = ()
    complete: bool = False
    # 同一快照的评估水位；用于判断消息是否已自然等待超过阈值。
    watermark_ms: int = 0
    resolved_question_ids: frozenset[str] = frozenset()
    question_owners: Mapping[str, str] = field(default_factory=dict)
    bot_replies: Mapping[str, BotReplyFact] = field(default_factory=dict)
    answered_question_ids: frozenset[str] = frozenset()
    answered_question_texts: frozenset[str] = frozenset()
    batch_messages: tuple[AttentionMessage, ...] = ()
    soft_request_anchor_id: str | None = None
    window_truncated: bool | None = None


@dataclass(frozen=True, slots=True)
class AttentionDecision:
    kind: AttentionKind
    score: int | None
    threshold: int | None
    reasons: tuple[str, ...]
    score_breakdown: tuple[tuple[str, int], ...] = ()


class AttentionInputError(ValueError):
    """输入缺少可信 Redis 事件 ID 或无法解析事件时间。"""


_SHORT_REACTIONS = frozenset({
    "哈哈", "哈哈哈", "哈哈哈哈", "好", "好的", "收到", "谢谢", "嗯", "嗯嗯",
    "哦", "哦哦", "是的", "对", "对的", "没错", "666", "草", "笑死",
    "笑死了", "懂了", "可以", "行", "ok", "👍", "👌", "😂", "🤣",
})
_BROADCAST_RE = re.compile(r"(?:有(?:没有|人|谁)|大家|各位|群里(?:有|有没有))")
_ASK_RE = re.compile(r"(?:请教|求助|求推荐|推荐一下|推荐|帮(?:忙|我)?(?:看|查|找|解决|分析)|有人知道|谁知道|怎么(?:办|设置|解决|修复)|如何|为什么|为啥|能不能|有没有办法|哪里(?:能|可以)?|在什么位置)")
_QUESTION_RE = re.compile(r"[？?]|(?:怎么|如何|为什么|为啥|能否|是否|有没有|哪一个|哪个|多少|什么原因|哪里|在什么位置)")
_REQUEST_RE = re.compile(r"(?:帮我|麻烦|请|求|查一下|看一下|分析一下|推荐|设置|解决|修复|对比|比较|解释)")
_CONCRETE_RE = re.compile(
    r"(?:[A-Za-z][A-Za-z0-9_.+-]*|\d+(?:\.\d+)+(?:[A-Za-z]+)?|"
    r"(?:报错|错误|异常|配置|版本|型号|软件|应用|程序|设备|芯片|模型|文件|文档|笔记本|内存|连接池|超时|视频|图片|代码|接口|网络|账号|参数|日志|命令|方案|价格|延迟|温度|咖啡))",
    re.IGNORECASE,
)
_OBJECT_RE = re.compile(
    r"(?:[A-Za-z][A-Za-z0-9_.+-]*|咖啡|芯片|模型|文件|文档|笔记本|视频|图片|代码|接口|网络|账号|设备|软件|应用|程序|日志|参数|预算|地区|型号)",
    re.IGNORECASE,
)
_CONSTRAINT_RE = re.compile(
    r"(?:\d+(?:\.\d+)?\s*(?:元|块|天|小时|分钟|秒|℃|°c|gb|mb|%|核|g)|"
    r"预算|地区|系统|版本|型号|报错|错误码|日志|配置项|配置|连接池|超时|内存|延迟|温度|价格|比较|对比|区别|性能)",
    re.IGNORECASE,
)
_OPEN_AUDIENCE_RE = re.compile(
    r"(?:^[^，,。！？?]{1,48}(?:最近|目前|现状|进展)(?:怎么样|如何|怎样|什么情况|干什么|干啥)|"
    r"^[^，,。！？?]{1,48}(?:怎么|如何)(?:处理|解决|排查|修复|设置|使用|选择|挑选)|"
    r"^[^，,。！？?]{1,48}(?:是什么|为什么|怎么回事|有什么区别|哪个更好))[^。！？?]*[？?]?$",
    re.IGNORECASE,
)
_VAGUE_RE = re.compile(r"^(?:这个怎么搞|这个咋办|怎么弄|咋整|有懂的吗|有人吗|在吗)[。！!？? ]*$", re.IGNORECASE)
_VAGUE_CANDIDATE_RE = re.compile(
    r"^(?:(?:这个|那个|这件事|这问题|该问题)?(?:怎么回事|怎么弄|咋整|咋办|怎么处理)|"
    r"(?:有人吗|有懂的吗|在吗))[。！!？? ]*$",
    re.IGNORECASE,
)
_HIGH_CONFIDENCE_NO_REQUEST = frozenset({
    "笑死", "笑死了", "太好了", "确实", "离谱", "好家伙", "绷不住了",
    "这也太离谱了", "这个太好笑了", "这结果真让人笑死", "这也行?", "怎么这么离谱",
})
_MATERIAL_REVIEW_RE = re.compile(
    r"(?:帮我|麻烦|请|看看|看下|看一下|分析|判断|识别|解释|检查|排查).{0,12}"
    r"(?:这个|这张|这份|这段|该|附件|图片|文件|视频|截图|图|文档|内容|日志|报错)|"
    r"(?:这个|这张|这份|这段|附件|图片|文件|视频|截图|图|文档|日志|报错).{0,12}"
    r"(?:帮我|麻烦|请|看看|看下|看一下|分析|判断|识别|解释|检查|排查)",
    re.IGNORECASE,
)
_RHETORICAL_SOCIAL = frozenset({"这也行", "怎么这么离谱"})


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
    value = str(value).strip()
    return value or None


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
    # 平台字段可能是 Unix 秒，也可能已经是毫秒。
    return result * 1000 if result < 10_000_000_000 else result


def _media_kinds(value: object) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    kinds: set[str] = set()
    for item in value:
        if isinstance(item, dict):
            raw_kind = item.get("media_kind") or item.get("media_type") or item.get("type")
            mime = str(item.get("mime_type") or "").lower()
            if raw_kind:
                raw_kind = str(raw_kind).lower()
                aliases = {
                    "photo": "image", "picture": "image", "document": "file",
                    "voice": "audio", "animation": "video", "video_note": "video",
                }
                kinds.add(aliases.get(raw_kind, raw_kind))
            elif mime:
                kinds.add(mime.split("/", 1)[0])
            else:
                kinds.add("unknown")
        elif isinstance(item, str):
            kinds.add("unknown")
    return tuple(sorted(kinds))


def normalize_text(text: str) -> str:
    value = unicodedata.normalize("NFKC", str(text or "")).casefold()
    return re.sub(r"[\s\u3000]+", "", value).strip("，。！？!?；;、,.：:")


_SHORT_REACTION_NORMALIZED = frozenset(normalize_text(item) for item in _SHORT_REACTIONS)


def _explicit_call(message: AttentionMessage, aliases: tuple[str, ...] = ()) -> bool:
    text = normalize_text(message.raw_text)
    for alias in aliases:
        normalized_alias = normalize_text(alias)
        if normalized_alias and normalized_alias in text:
            return True
    return False


def build_logical_candidates(messages: tuple[AttentionMessage, ...]) -> tuple[AttentionMessage, ...]:
    """只合成同一发言人 8 秒内连续补充的评分文本；原消息和事件身份不变。"""
    ordered = sorted(messages, key=lambda item: _stream_order_key(item.event_id))
    deduped: list[AttentionMessage] = []
    seen: set[str] = set()
    for item in ordered:
        if item.event_id not in seen:
            seen.add(item.event_id)
            deduped.append(item)
    output: list[AttentionMessage] = []
    index = 0
    while index < len(deduped):
        first = deduped[index]
        end = index + 1
        if first.sender_id and first.sender_is_bot is not True:
            while end < len(deduped):
                previous, current = deduped[end - 1], deduped[end]
                if (
                    not current.sender_id
                    or current.sender_id != first.sender_id
                    or (current.platform, current.bot_id, current.group_id)
                    != (first.platform, first.bot_id, first.group_id)
                    or current.sender_is_bot is True
                    or current.event_received_ms - previous.event_received_ms > 8_000
                ):
                    break
                end += 1
        chain = deduped[index:end]
        combined = "\n".join(item.raw_text.strip() for item in chain if item.raw_text.strip())
        mention_unknown = any(item.has_unresolved_mention for item in chain)
        output.extend(
            replace(item, candidate_text=combined, has_unresolved_mention=mention_unknown)
            for item in chain
        )
        index = end
    return tuple(output)


def _stream_order_key(event_id: str) -> tuple[int, int]:
    head, _, sequence = str(event_id).partition("-")
    try:
        return int(head), int(sequence)
    except ValueError:
        return 0, 0


def _candidate_text(message: AttentionMessage) -> str:
    return message.candidate_text if message.candidate_text is not None else message.raw_text


def _trusted_bot_reply(message: AttentionMessage, snapshot: AttentionSnapshot) -> BotReplyFact | None:
    if (
        not message.reply_to_platform_message_id
        or message.reply_target_is_bot is not True
        or not snapshot.complete
    ):
        return None
    fact = snapshot.bot_replies.get(message.reply_to_platform_message_id)
    if fact is None or not fact.accepted or not message.sender_id:
        return None
    if fact.recipient_sender_id != message.sender_id:
        return None
    age_ms = message.event_received_ms - fact.sent_at_ms
    if age_ms < 0 or age_ms > 120_000:
        return None
    return fact


def _trusted_bot_continuation(message: AttentionMessage, snapshot: AttentionSnapshot) -> bool:
    fact = _trusted_bot_reply(message, snapshot)
    text = message.raw_text
    has_concrete_next_step = bool(_CONCRETE_RE.search(text))
    has_followup = bool(
        _QUESTION_RE.search(text)
        or _REQUEST_RE.search(text)
        or re.search(r"(?:补充|纠正|不对|实际是|还有一个|下一步|继续|再看|没解决|还是不行|仍然不行)", text)
    )
    return bool(fact and has_concrete_next_step and has_followup)


def _trusted_media_continuation(message: AttentionMessage, snapshot: AttentionSnapshot) -> bool:
    if (
        not message.media_only
        or message.processable_media is not True
        or not set(message.media_kinds).intersection({"image", "file"})
        or not snapshot.complete
    ):
        return False
    return _trusted_bot_reply(message, snapshot) is not None


def _soft_continuation_candidate(message: AttentionMessage, snapshot: AttentionSnapshot) -> bool:
    if (
        not snapshot.soft_request_anchor_id
        or not message.sender_id
        or message.reply_to_platform_message_id
        or message.has_unresolved_mention
        or message.mentioned_other_bot is True
        or message.mentioned_other_member is True
    ):
        return False
    if message.media_only:
        return (
            message.processable_media is True
            and bool(set(message.media_kinds).intersection({"image", "file", "audio", "video"}))
        )
    text = normalize_text(message.raw_text)
    if len(text) < 8 or text in _SHORT_REACTION_NORMALIZED:
        return False
    return bool(
        _QUESTION_RE.search(message.raw_text)
        or _REQUEST_RE.search(message.raw_text)
        or _CONCRETE_RE.search(message.raw_text)
    )


def _unscored_material_candidate(message: AttentionMessage) -> bool:
    """仅对可处理媒体及同批明示送审文字开放有界、无分兜底。"""
    if (
        message.processable_media is not True
        or not set(message.media_kinds).intersection({"image", "file"})
        or message.has_unresolved_mention
        or message.mentioned_other_bot is True
        or message.mentioned_other_member is True
    ):
        return False
    return bool(_MATERIAL_REVIEW_RE.search(_candidate_text(message).strip()))


def _hard_reject(message: AttentionMessage, snapshot: AttentionSnapshot, explicit_call: bool) -> str | None:
    text = normalize_text(message.raw_text)
    reaction_kinds = {"sticker", "emoji", "reaction"}
    if message.media_only and not text and set(message.media_kinds) and set(message.media_kinds) <= reaction_kinds:
        return "H01_reaction_only_media"
    if not message.media_kinds and (
        text in _SHORT_REACTION_NORMALIZED or message.raw_text.strip() in {"?", "？"}
    ):
        return "H02_short_reaction"
    if message.mentioned_current_bot is False and (
        message.mentioned_other_bot is True or message.mentioned_other_member is True
    ):
        return "H03_other_mention"
    if (
        message.reply_to_platform_message_id
        and message.reply_to_platform_message_id in snapshot.resolved_question_ids
        and message.sender_id
        and snapshot.question_owners.get(message.reply_to_platform_message_id) == message.sender_id
        and not _QUESTION_RE.search(message.raw_text)
        and bool(re.search(r"(?:解决了|已解决|搞定了|问题解决|不用了|已经好了)", message.raw_text))
    ):
        return "H08_question_resolved"
    if (
        not explicit_call
        and message.mentioned_current_bot is False
        and message.reply_to_platform_message_id
        and message.reply_target_is_bot is False
    ):
        return "H04_reply_to_other"
    if (
        message.mentioned_current_bot is False
        and not explicit_call
        and (
            text in {normalize_text(item) for item in _HIGH_CONFIDENCE_NO_REQUEST}
            or text in _RHETORICAL_SOCIAL
        )
    ):
        return "H06_social_expression"
    return None


def _implicit_open_audience(message: AttentionMessage, text: str) -> bool:
    if message.has_unresolved_mention or message.mentioned_other_bot is True or message.mentioned_other_member is True:
        return False
    if re.search(r"(?:^|[，,。\s])(?:你|您|你们|您们|咱们)(?:[，,。\s]|$)", text):
        return False
    return bool(_OPEN_AUDIENCE_RE.search(text))


def _is_open_candidate(message: AttentionMessage) -> bool:
    text = _candidate_text(message).strip()
    if not text or message.media_only:
        return False
    if _implicit_open_audience(message, text):
        return True
    concrete = bool(_CONCRETE_RE.search(text))
    question = bool(_QUESTION_RE.search(text))
    broadcast_request = bool(_BROADCAST_RE.search(text) and _ASK_RE.search(text))
    if message.has_unresolved_mention:
        return False
    return (broadcast_request and concrete) or (question and concrete)


def _peer_exchange(messages: tuple[AttentionMessage, ...], message: AttentionMessage) -> str | None:
    if not message.sender_id:
        return None
    recent = [item for item in messages if item.sender_is_bot is False and item.sender_id and
              0 <= message.event_received_ms - item.event_received_ms <= 60_000]
    if any(item.reply_to_platform_message_id and not item.reply_target_sender_id for item in recent):
        return None
    recent.sort(key=lambda item: (item.event_received_ms, item.event_id))
    recent.append(message)
    senders = []
    for item in recent:
        if not senders or senders[-1] != item.sender_id:
            senders.append(item.sender_id)
    if len(set(senders[-3:])) == 2 and len(senders) >= 3 and senders[-3] == senders[-1]:
        exchange = recent[-3:]
        if (
            exchange[0].platform_message_id
            and exchange[1].reply_to_platform_message_id == exchange[0].platform_message_id
            and exchange[1].platform_message_id
            and exchange[2].reply_to_platform_message_id == exchange[1].platform_message_id
        ):
            return "N01_strong_peer_exchange"
    counts: dict[str, int] = {}
    for item in recent:
        counts[item.sender_id] = counts.get(item.sender_id, 0) + 1
    ranked = sorted(counts.items(), key=lambda pair: pair[1], reverse=True)
    if len(ranked) >= 2:
        first, second = ranked[:2]
        human_count = max(1, len(recent))
        if first[1] + second[1] >= human_count * 0.7 and len(senders) >= 3:
            if len(set(senders[-3:])) == 2 and senders[-3] == senders[-1]:
                return "N02_weak_peer_exchange"
    return None


_SCORE_WEIGHTS = {
    "P01_group_broadcast_request": 35,
    "P02_substantive_question": 30,
    "P03_concrete_context": 15,
    "P05_quiet_conversation": 10,
    "P06_multiple_independent_askers": 10,
    "P07_implicit_open_audience": 15,
    "N01_strong_peer_exchange": -45,
    "N02_weak_peer_exchange": -20,
    "N03_human_answer_confirmed": -45,
    "N04_recent_proactive_bot_reply": -25,
    "N05_busy_group": -10,
    "N06_vague_question": -25,
    "N07_bot_already_answered": -40,
}


def score_open_candidate(message: AttentionMessage, snapshot: AttentionSnapshot) -> tuple[int, tuple[str, ...]]:
    """依据 PRD 的固定 P/N 权重评分，不读取正文以外的非结构化推测。"""
    if not snapshot.complete:
        return 0, ("snapshot_incomplete",)
    reasons: list[str] = []
    text = _candidate_text(message)
    if _BROADCAST_RE.search(text) and _ASK_RE.search(text) and _CONCRETE_RE.search(text):
        reasons.append("P01_group_broadcast_request")
    if _QUESTION_RE.search(text) and _CONCRETE_RE.search(text):
        reasons.append("P02_substantive_question")
    if _OBJECT_RE.search(text) and _CONSTRAINT_RE.search(text):
        reasons.append("P03_concrete_context")
    if "P01_group_broadcast_request" not in reasons and _implicit_open_audience(message, text):
        reasons.append("P07_implicit_open_audience")
    recent_context = [
        item for item in snapshot.messages
        if 0 <= message.event_received_ms - item.event_received_ms <= 60_000
    ]
    prior_humans = [
        item for item in recent_context
        if item.sender_is_bot is False and item.sender_id
    ]
    relations_known = all(
        not item.reply_to_platform_message_id or item.reply_target_sender_id
        for item in recent_context
    )
    exchange = _peer_exchange(snapshot.messages, message)
    if (
        snapshot.complete
        and relations_known
        and (not recent_context or all(item.sender_id and item.sender_is_bot is False for item in recent_context))
        and exchange is None
    ):
        reasons.append("P05_quiet_conversation")
    if any(
        item.sender_id and item.sender_id != message.sender_id
        and normalize_text(_candidate_text(item)) == normalize_text(text)
        and item.sender_is_bot is False
        for item in (*snapshot.messages, *snapshot.batch_messages)
    ):
        reasons.append("P06_multiple_independent_askers")
    if exchange:
        reasons.append(exchange)
    if (
        message.reply_to_platform_message_id in snapshot.resolved_question_ids
        and message.sender_id
        and snapshot.question_owners.get(message.reply_to_platform_message_id) == message.sender_id
    ):
        reasons.append("N03_human_answer_confirmed")
    if any(
        fact.accepted and fact.proactive and 0 <= message.event_received_ms - fact.sent_at_ms <= 180_000
        for fact in snapshot.bot_replies.values()
    ):
        reasons.append("N04_recent_proactive_bot_reply")
    recent_batch_humans = [
        item for item in snapshot.batch_messages
        if item.sender_is_bot is False and item.sender_id
        and 0 <= message.event_received_ms - item.event_received_ms <= 60_000
    ]
    effective_humans = {
        item.event_id for item in (*prior_humans, *recent_batch_humans, message)
        if item.sender_is_bot is False and item.sender_id
        and 0 <= message.event_received_ms - item.event_received_ms <= 60_000
    }
    if len(effective_humans) >= 8:
        reasons.append("N05_busy_group")
    if _VAGUE_RE.fullmatch(text.strip()) or _VAGUE_CANDIDATE_RE.fullmatch(text.strip()):
        reasons.append("N06_vague_question")
    normalized = normalize_text(text)
    if message.platform_message_id in snapshot.answered_question_ids or normalized in snapshot.answered_question_texts:
        reasons.append("N07_bot_already_answered")
    return max(0, min(100, sum(_SCORE_WEIGHTS[item] for item in reasons))), tuple(reasons)


def decide_attention(
    message: AttentionMessage,
    snapshot: AttentionSnapshot,
    mode: AttentionMode,
    *,
    budget_available: bool = True,
    bot_aliases: tuple[str, ...] = (),
) -> AttentionDecision:
    """自主模式直接放行；其他模式按 DIRECT→CONTINUE→H→开放候选评分执行。"""
    if mode is AttentionMode.AUTONOMOUS:
        return AttentionDecision(
            AttentionKind.ALLOW_RUN, None, None, ("autonomous_bypass",)
        )
    explicit_call = _explicit_call(message, bot_aliases)
    if message.mentioned_current_bot is True or explicit_call:
        return AttentionDecision(AttentionKind.DIRECT, 100, None, ("DIRECT_invitation",))
    if _trusted_media_continuation(message, snapshot):
        return AttentionDecision(AttentionKind.CONTINUE, 100, None, ("CONTINUE_verified_media_reply",))
    if _trusted_bot_continuation(message, snapshot):
        return AttentionDecision(AttentionKind.CONTINUE, 100, None, ("CONTINUE_verified_reply",))
    hard_reason = _hard_reject(message, snapshot, explicit_call)
    if hard_reason:
        return AttentionDecision(AttentionKind.PASSIVE, 0, None, (hard_reason,))
    if mode in {AttentionMode.NATURAL, AttentionMode.ACTIVE} and _soft_continuation_candidate(message, snapshot):
        return AttentionDecision(
            AttentionKind.SOFT_CONTINUE, 100, None,
            ("SOFT_CONTINUE_verified_material_request",),
        )
    if mode in {AttentionMode.NATURAL, AttentionMode.ACTIVE} and _unscored_material_candidate(message):
        if not budget_available:
            return AttentionDecision(
                AttentionKind.PASSIVE, None, None,
                ("UNSCORED_FALLBACK_material_budget_unavailable",),
            )
        return AttentionDecision(
            AttentionKind.PROACTIVE, None, None,
            ("UNSCORED_FALLBACK_processable_media_with_explicit_request",),
        )
    if not _is_open_candidate(message):
        if message.media_only or message.media_kinds:
            return AttentionDecision(AttentionKind.PASSIVE, None, None, ("media_unresolved",))
        return AttentionDecision(AttentionKind.PASSIVE, 0, None, ("not_open_candidate",))
    if mode is AttentionMode.QUIET:
        return AttentionDecision(AttentionKind.PASSIVE, 0, None, ("quiet_mode_suppresses_open_candidate",))
    score, reasons = score_open_candidate(message, snapshot)
    score_breakdown = tuple(
        (reason, _SCORE_WEIGHTS[reason])
        for reason in reasons
        if reason in _SCORE_WEIGHTS
    )
    threshold = 70 if mode is AttentionMode.NATURAL else 55
    if not snapshot.complete:
        return AttentionDecision(
            AttentionKind.PASSIVE, score, threshold, reasons, score_breakdown,
        )
    if score < threshold:
        return AttentionDecision(
            AttentionKind.PASSIVE, score, threshold, reasons, score_breakdown,
        )
    if not budget_available:
        return AttentionDecision(
            AttentionKind.PASSIVE, score, threshold,
            (*reasons, "proactive_budget_unavailable"), score_breakdown,
        )
    return AttentionDecision(
        AttentionKind.PROACTIVE, score, threshold, reasons, score_breakdown,
    )
