"""把逐条 Gateway 事实与会话快照交给纯注意力决策器。"""
from __future__ import annotations

from datetime import UTC, datetime

from dataclasses import replace

from agent.im.auto_reply.attention import (
    AttentionDecision,
    AttentionInputError,
    AttentionKind,
    AttentionMessage,
    AttentionMode,
    AttentionSnapshot,
    BotReplyFact,
    build_logical_candidates,
    decide_attention,
)


def batch_attention_messages(payload: dict) -> tuple[AttentionMessage, ...]:
    items = payload.get("_batch_messages")
    if not isinstance(items, list) or not items:
        items = [payload]
    messages = []
    for item in items:
        if not isinstance(item, dict):
            raise AttentionInputError("群聊批次包含无效消息")
        event_id = item.get("event_id") or item.get("_redis_stream_id")
        if not event_id:
            raise AttentionInputError("群聊消息缺少 Redis Stream ID")
        normalized = dict(item)
        normalized.setdefault("event_id", event_id)
        normalized.setdefault("platform", payload.get("platform"))
        normalized.setdefault("bot_id", item.get("channel_id") or payload.get("channel_id"))
        normalized.setdefault("chat_id", payload.get("chat_id"))
        normalized.setdefault("text", item.get("attention_raw_text", item.get("text", "")))
        messages.append(AttentionMessage.from_payload(str(event_id), normalized))
    return tuple(messages)


async def load_attention_snapshot(session_id: int, messages: tuple[AttentionMessage, ...]) -> AttentionSnapshot:
    """从同一 IM 会话及入站 Stream 读取完整观察窗口；缺少覆盖证明时标记不完整。"""
    from sqlalchemy import select
    import app.db.session as db_session
    from app.models import ConversationMessage

    if db_session._engine is None:
        db_session._build_engine()
    now = datetime.now(UTC)
    now_ms = int(now.timestamp() * 1000)
    cutoff = now_ms - 60_000
    answered_cutoff = now_ms - 300_000
    current_ids = {message.event_id for message in messages}
    scope = messages[0] if messages else None
    history: list[AttentionMessage] = []
    answer_history: list[AttentionMessage] = []
    complete = False
    window_truncated: bool | None = None
    try:
        async with db_session._SessionLocal() as db:
            rows = (await db.execute(
                select(ConversationMessage).where(
                    ConversationMessage.session_id == session_id,
                    ConversationMessage.created_at >= datetime.fromtimestamp(cutoff / 1000, UTC),
                ).order_by(ConversationMessage.created_at, ConversationMessage.id)
            )).scalars().all()
            answer_rows = (await db.execute(
                select(ConversationMessage).where(
                    ConversationMessage.session_id == session_id,
                    ConversationMessage.role == "user",
                    ConversationMessage.created_at >= datetime.fromtimestamp(answered_cutoff / 1000, UTC),
                ).order_by(ConversationMessage.created_at, ConversationMessage.id)
            )).scalars().all()
        for row in rows:
            event_id = str(row.client_message_id or f"db-{row.id}-0")
            if event_id in current_ids:
                continue
            received_ms = int(
                row.im_event_received_ms or row.created_at.timestamp() * 1000
            )
            sender_id = row.platform_user_id
            if row.role == "user" and not sender_id:
                complete = False
            mention_facts = row.im_mention_facts if isinstance(row.im_mention_facts, dict) else {}
            history.append(AttentionMessage(
                event_id=event_id,
                platform=scope.platform if scope else "",
                bot_id=scope.bot_id if scope else "",
                group_id=scope.group_id if scope else "",
                platform_message_id=row.im_platform_message_id,
                sender_id=str(sender_id) if sender_id else None,
                event_received_ms=received_ms,
                platform_sent_ms=None,
                raw_text=row.content or "",
                media_only=not bool(row.content) and bool(row.files),
                media_kinds=tuple(row.im_media_kinds or ()),
                processable_media=row.im_media_processable,
                mentioned_current_bot=mention_facts.get("current_bot"),
                mentioned_other_bot=mention_facts.get("other_bot"),
                mentioned_other_member=mention_facts.get("other_member"),
                has_unresolved_mention=False,
                reply_to_platform_message_id=(
                    row.im_reply_to_message_id
                    or ("__unknown_reply__" if row.quoted_text else None)
                ),
                reply_target_sender_id=row.im_reply_target_sender_id,
                reply_target_is_bot=row.im_reply_target_is_bot,
                quote_text=row.quoted_text,
                sender_is_bot=(row.im_sender_is_bot if row.im_sender_is_bot is not None else row.role != "user"),
            ))
        answer_history = [
            _row_to_attention_message(row, scope)
            for row in answer_rows
            if str(row.client_message_id or "") not in current_ids
        ]
        stream_history, stream_covers_window, window_truncated = await _recent_stream_messages(
            scope=scope,
            cutoff_ms=cutoff,
            watermark_ms=now_ms,
            current_ids=current_ids,
        )
        by_event_id = {item.event_id: item for item in (*history, *stream_history)}
        history = list(by_event_id.values())
        complete = stream_covers_window and all(
            item.sender_id and item.sender_is_bot is not None for item in messages
        )
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.attention.snapshot", exc)
        complete = False
        history = []

    owners = {
        item.platform_message_id: item.sender_id
        for item in (*history, *messages)
        if item.platform_message_id and item.sender_id
    }
    resolved_ids = {
        item.reply_to_platform_message_id
        for item in (*history, *messages)
        if item.reply_to_platform_message_id
        and item.reply_target_sender_id == item.sender_id
        and item.sender_id
        and any(phrase in item.raw_text for phrase in ("解决了", "已解决", "搞定了", "问题解决", "不用了", "已经好了"))
        and not any(mark in item.raw_text for mark in ("?", "？"))
    }
    bot_replies = {}
    answered_question_ids: set[str] = set()
    answered_question_texts: set[str] = set()
    try:
        from agent.im.auto_reply.budget import recent_proactive_acceptances

        redis = R.get_redis()
        bot_replies = await _load_bot_reply_facts(
            redis,
            (*history, *messages),
            platform=scope.platform,
            bot_id=scope.bot_id,
            group_id=scope.group_id,
        )
        answer_stream_history, _, _ = await _recent_stream_messages(
            scope=scope,
            cutoff_ms=answered_cutoff,
            watermark_ms=now_ms,
            current_ids=current_ids,
        )
        answer_candidates = {
            item.event_id: item
            for item in (*answer_history, *answer_stream_history)
            if item.sender_is_bot is False
        }
        answered_question_ids, answered_question_texts = await _load_answered_question_facts(
            redis,
            answer_candidates.values(),
            platform=scope.platform,
            bot_id=scope.bot_id,
            group_id=scope.group_id,
            now_ms=now_ms,
        )

        proactive_acceptances = await recent_proactive_acceptances(
            redis,
            platform=scope.platform,
            bot_id=scope.bot_id,
            group_id=scope.group_id,
            since_ms=now_ms - 180_000,
            until_ms=now_ms,
        )
        bot_replies = merge_proactive_reply_facts(bot_replies, proactive_acceptances)
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.attention.outbound_facts", exc)
        complete = False
    return AttentionSnapshot(
        messages=tuple((*history, *messages)),
        complete=complete,
        window_truncated=window_truncated,
        watermark_ms=now_ms,
        batch_messages=messages,
        question_owners=owners,
        resolved_question_ids=frozenset(resolved_ids),
        bot_replies=bot_replies,
        answered_question_ids=frozenset(answered_question_ids),
        answered_question_texts=frozenset(answered_question_texts),
    )


def merge_proactive_reply_facts(
    bot_replies: dict[str, BotReplyFact],
    acceptances: tuple[tuple[str, int], ...],
) -> dict[str, BotReplyFact]:
    """合并主动预算的接受事实，保留按平台消息 ID 索引的 Bot 回复。"""
    merged = dict(bot_replies)
    merged.update({
        f"attention-run:{run_id}": BotReplyFact(
            platform_message_id=f"attention-run:{run_id}",
            sent_at_ms=accepted_at_ms,
            recipient_sender_id=None,
            accepted=True,
            proactive=True,
        )
        for run_id, accepted_at_ms in acceptances
    })
    return merged


def _receipt_value(receipt: dict, name: str) -> str | None:
    """兼容 Redis 客户端返回 str 或 bytes 的哈希字段。"""
    value = receipt.get(name)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value) if value is not None else None


def _row_to_attention_message(row, scope) -> AttentionMessage:
    event_id = str(row.client_message_id or f"db-{row.id}-0")
    received_ms = int(row.im_event_received_ms or row.created_at.timestamp() * 1000)
    mention_facts = row.im_mention_facts if isinstance(row.im_mention_facts, dict) else {}
    return AttentionMessage(
        event_id=event_id,
        platform=scope.platform if scope else "",
        bot_id=scope.bot_id if scope else "",
        group_id=scope.group_id if scope else "",
        platform_message_id=row.im_platform_message_id,
        sender_id=str(row.platform_user_id) if row.platform_user_id else None,
        event_received_ms=received_ms,
        platform_sent_ms=None,
        raw_text=row.content or "",
        media_only=not bool(row.content) and bool(row.files),
        media_kinds=tuple(row.im_media_kinds or ()),
        processable_media=row.im_media_processable,
        mentioned_current_bot=mention_facts.get("current_bot"),
        mentioned_other_bot=mention_facts.get("other_bot"),
        mentioned_other_member=mention_facts.get("other_member"),
        has_unresolved_mention=False,
        reply_to_platform_message_id=(
            row.im_reply_to_message_id or ("__unknown_reply__" if row.quoted_text else None)
        ),
        reply_target_sender_id=row.im_reply_target_sender_id,
        reply_target_is_bot=row.im_reply_target_is_bot,
        quote_text=row.quoted_text,
        sender_is_bot=(row.im_sender_is_bot if row.im_sender_is_bot is not None else row.role != "user"),
    )


async def _load_bot_reply_facts(redis, messages, *, platform: str, bot_id: str,
                                group_id: str) -> dict[str, BotReplyFact]:
    """仅恢复同群、同 Bot、发给同一成员且已确认的原生回复收据。"""
    from agent.im.auto_reply.delivery import lookup_bot_reply

    references = {
        (str(item.reply_to_platform_message_id), str(item.sender_id))
        for item in messages
        if item.reply_to_platform_message_id
        and item.reply_target_is_bot is True
        and item.sender_id
    }
    facts = {}
    for platform_message_id, sender_id in references:
        receipt = await lookup_bot_reply(
            redis,
            platform=platform,
            bot_id=bot_id,
            group_id=group_id,
            platform_message_id=platform_message_id,
        )
        if not receipt or _receipt_value(receipt, "status") != "ACCEPTED":
            continue
        recipient = _receipt_value(receipt, "recipient_sender_id")
        accepted_at = _receipt_value(receipt, "accepted_at_ms")
        try:
            accepted_at_ms = int(accepted_at)
        except (TypeError, ValueError):
            continue
        if recipient != sender_id:
            continue
        facts[platform_message_id] = BotReplyFact(
            platform_message_id=platform_message_id,
            sent_at_ms=accepted_at_ms,
            recipient_sender_id=recipient,
            accepted=True,
            proactive=_receipt_value(receipt, "proactive") == "1",
        )
    return facts


async def _load_answered_question_facts(redis, messages, *, platform: str, bot_id: str,
                                        group_id: str, now_ms: int) -> tuple[set[str], set[str]]:
    """把已接受回答关联回 300 秒内的问题，用规范化文本内存匹配而不存正文索引。"""
    from agent.im.auto_reply.attention import normalize_text
    from agent.im.auto_reply.delivery import lookup_answer_for_source_event

    answered_ids: set[str] = set()
    answered_texts: set[str] = set()
    for item in messages:
        if item.sender_is_bot is not False:
            continue
        receipt = await lookup_answer_for_source_event(
            redis,
            platform=platform,
            bot_id=bot_id,
            group_id=group_id,
            source_event_id=item.event_id,
        )
        if not receipt or _receipt_value(receipt, "status") != "ACCEPTED":
            continue
        try:
            accepted_at_ms = int(_receipt_value(receipt, "accepted_at_ms") or "")
        except (TypeError, ValueError):
            continue
        if not item.event_received_ms <= accepted_at_ms <= now_ms:
            continue
        if item.platform_message_id:
            answered_ids.add(item.platform_message_id)
        normalized = normalize_text(item.raw_text)
        if len(normalized) >= 8:
            answered_texts.add(normalized)
    return answered_ids, answered_texts


async def _recent_stream_messages(*, scope, cutoff_ms: int, watermark_ms: int,
                                  current_ids: set[str]) -> tuple[list[AttentionMessage], bool, bool | None]:
    """补入尚未落库的入站消息，并证明 Redis Stream 覆盖了完整 60 秒窗口。"""
    import json
    from app.core import redis as R

    redis = R.get_redis()
    first_entries = await redis.xrange(R.IM_INBOUND_STREAM, min="-", max="+", count=1)
    if not first_entries:
        return [], False, None
    first_id = str(first_entries[0][0])
    try:
        first_ms = int(first_id.partition("-")[0])
    except (TypeError, ValueError):
        return [], False, None
    covers_window = first_ms <= cutoff_ms
    window_truncated = first_ms > cutoff_ms
    rows = await redis.xrange(
        R.IM_INBOUND_STREAM,
        min=f"{cutoff_ms}-0",
        max=f"{watermark_ms}-9999999",
    )
    output: list[AttentionMessage] = []
    for event_id, fields in rows:
        event_id = str(event_id)
        if event_id in current_ids:
            continue
        raw = fields.get("data") if isinstance(fields, dict) else None
        try:
            payload = json.loads(raw) if raw else None
        except (TypeError, ValueError):
            covers_window = False
            continue
        if not isinstance(payload, dict):
            covers_window = False
            continue
        if (
            str(payload.get("platform") or "") != str(scope.platform if scope else "")
            or str(payload.get("channel_id") or payload.get("bot_id") or "")
            != str(scope.bot_id if scope else "")
            or str(payload.get("chat_id") or "") != str(scope.group_id if scope else "")
            or payload.get("chat_type") != "group"
        ):
            continue
        try:
            output.append(AttentionMessage.from_payload(event_id, payload))
        except AttentionInputError:
            covers_window = False
    return output, covers_window, window_truncated


async def evaluate_group_attention(request, payload: dict) -> tuple[bool, AttentionDecision | None, dict | None]:
    """返回是否进入 Run、最优决策以及主动预算预留 ID。"""
    from app.core import redis as R
    from agent.im.auto_reply.budget import (
        get_soft_anchor,
        reserve_proactive_slot,
        reserve_soft_slot,
    )

    messages = build_logical_candidates(batch_attention_messages(payload))
    if not messages:
        return False, None, None
    raw_mode = str(payload.get("group_attention_mode") or "autonomous")
    mode = AttentionMode(raw_mode) if raw_mode in {item.value for item in AttentionMode} else AttentionMode.AUTONOMOUS
    if mode is AttentionMode.AUTONOMOUS:
        payload["_attention_snapshot_complete"] = None
        return True, decide_attention(messages[0], AttentionSnapshot(complete=False), mode), None
    if request.session_id is None:
        from agent.im.dispatch import _ensure_im_session

        request.session_id = await _ensure_im_session(request)
    snapshot = await load_attention_snapshot(int(request.session_id), messages)
    payload["_attention_snapshot_complete"] = snapshot.complete
    payload["_attention_window_truncated"] = snapshot.window_truncated
    bot_aliases = tuple(
        str(value) for value in payload.get("bot_aliases", ())
        if isinstance(value, str) and value.strip()
    ) or ("咕咕",)
    decisions = []
    soft_candidates = []
    redis = R.get_redis()
    for message in messages:
        soft_anchor_id = await get_soft_anchor(
            redis,
            platform=message.platform,
            bot_id=message.bot_id,
            group_id=message.group_id,
            sender_id=str(message.sender_id or ""),
        )
        scoped_snapshot = replace(
            snapshot,
            messages=tuple(item for item in snapshot.messages if item.event_id != message.event_id),
            soft_request_anchor_id=soft_anchor_id,
        )
        decision = decide_attention(
            message,
            scoped_snapshot,
            mode,
            budget_available=True,
            bot_aliases=bot_aliases,
        )
        decisions.append(decision)
        if decision.kind is AttentionKind.SOFT_CONTINUE and soft_anchor_id:
            soft_candidates.append((message, decision, soft_anchor_id))
    eligible = [
        decision for decision in decisions
        if decision.kind in {AttentionKind.DIRECT, AttentionKind.CONTINUE}
    ]
    proactive = [decision for decision in decisions if decision.kind is AttentionKind.PROACTIVE]
    if eligible:
        return True, eligible[0], None
    if soft_candidates:
        message, decision, anchor_id = soft_candidates[0]
        batch_key = str(request.inbound_batch_key or message.event_id)
        reserved = await reserve_soft_slot(
            redis,
            platform=message.platform,
            bot_id=message.bot_id,
            group_id=message.group_id,
            sender_id=str(message.sender_id or ""),
            run_id=batch_key,
            anchor_id=anchor_id,
            now_ms=snapshot.watermark_ms,
        )
        if reserved:
            return True, decision, {
                "kind": "soft",
                "run_id": batch_key,
                "sender_id": str(message.sender_id or ""),
                "anchor_id": anchor_id,
            }
        return False, replace(
            decision, kind=AttentionKind.PASSIVE,
            reasons=(*decision.reasons, "soft_budget_unavailable"),
        ), None
    if not proactive:
        return False, max(decisions, key=lambda item: item.score), None

    batch_key = str(request.inbound_batch_key or messages[-1].event_id)
    reserved = await reserve_proactive_slot(
        redis,
        platform=messages[-1].platform,
        bot_id=messages[-1].bot_id,
        group_id=messages[-1].group_id,
        run_id=batch_key,
        mode=mode.value,
        now_ms=snapshot.watermark_ms,
    )
    if not reserved:
        best = max(proactive, key=lambda item: item.score)
        return False, replace(best, kind=AttentionKind.PASSIVE,
                              reasons=(*best.reasons, "proactive_budget_unavailable")), None
    return True, max(proactive, key=lambda item: item.score), {
        "kind": "proactive",
        "run_id": batch_key,
        "sender_id": None,
        "anchor_id": None,
    }


__all__ = ["batch_attention_messages", "evaluate_group_attention", "load_attention_snapshot"]
