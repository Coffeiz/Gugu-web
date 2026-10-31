"""把逐条 Gateway 事实与会话快照交给纯注意力决策器。"""
from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

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


def batch_attention_messages(
    payload: dict, transcripts: dict[str, str] | None = None,
) -> tuple[AttentionMessage, ...]:
    return _batch_attention_messages(payload, transcripts or {})


def _set_attention_subject(payload: dict, message: AttentionMessage) -> None:
    """把本次准入绑定到唯一成员和原始入站事件。"""
    payload["_attention_conversation_subject_sender_id"] = str(message.sender_id or "")
    payload["_attention_source_event_ids"] = [message.event_id]


async def _decide_attention_message(
    message: AttentionMessage,
    snapshot: AttentionSnapshot,
    mode: AttentionMode,
    *,
    bot_aliases: tuple[str, ...],
) -> tuple[AttentionDecision, str | None]:
    """对单条消息执行结构路由、成员激活和 v3 双通道评分。"""
    scoped_snapshot = replace(
        snapshot,
        messages=tuple(item for item in snapshot.messages if item.event_id != message.event_id),
    )
    decision = decide_attention(
        message,
        scoped_snapshot,
        mode,
        bot_aliases=bot_aliases,
    )
    return decision, None


async def transcribe_voice_for_attention(request, payload: dict) -> dict[str, str]:
    """预转写已暂存的群语音；结果供注意力判定和本轮 Run 复用。"""
    from agent.voice_config import voice_recognition_profile
    from app.core import chat_attach
    from app.core.config import get_settings

    items = payload.get("_batch_messages")
    if not isinstance(items, list) or not items:
        items = [payload]
    user_id = getattr(request, "user_id", None)
    if not user_id:
        return {}

    attachment_ids_by_event, all_attachment_ids = _attention_attachment_ids(items)
    if not all_attachment_ids:
        return {}
    metas = await chat_attach.get_meta_many(user_id, all_attachment_ids)
    metas = {
        attach_id: meta for attach_id, meta in metas.items()
        if meta.get("kind") in {"voice", "audio"}
    }
    if not metas:
        return {}

    profile = await voice_recognition_profile(request.user_id)
    if not profile.configured or not profile.resolved:
        return {}
    settings = get_settings()
    transcripts: dict[str, str] = {}
    for event_id, attachment_ids in attachment_ids_by_event.items():
        parts = [
            transcript
            for attach_id in attachment_ids
            if (transcript := await _transcribe_attention_attachment(
                metas.get(attach_id), profile, settings, user_id,
            ))
        ]
        if parts:
            transcripts[event_id] = "\n".join(parts)
    return transcripts


def _attention_attachment_ids(items: list) -> tuple[dict[str, list[str]], list[str]]:
    attachment_ids_by_event: dict[str, list[str]] = {}
    all_attachment_ids: list[str] = []
    for item in items:
        if not isinstance(item, dict) or not (item.get("event_id") or item.get("_redis_stream_id")):
            continue
        event_id = str(item.get("event_id") or item.get("_redis_stream_id"))
        ids = [
            str(attachment.get("attach_id") if isinstance(attachment, dict) else attachment)
            for attachment in (item.get("attachments") or [])
            if isinstance(attachment, str) or (
                isinstance(attachment, dict) and attachment.get("attach_id")
            )
        ]
        attachment_ids_by_event[event_id] = ids
        all_attachment_ids.extend(ids)
    return attachment_ids_by_event, list(dict.fromkeys(all_attachment_ids))


async def _transcribe_attention_attachment(meta, profile, settings, user_id) -> str | None:
    if not meta or meta.get("kind") not in {"voice", "audio"}:
        return None
    size = int(meta.get("size") or 0)
    if size <= 0 or size > profile.max_file_bytes:
        return None
    try:
        from agent.media import audio
        from agent import voice
        from app.core import chat_attach

        raw = await chat_attach.read_bytes(meta)
        ext = str(meta.get("ext") or "").lower()
        mime = str(meta.get("mime") or f"audio/{ext or 'mpeg'}")
        duration = await audio.preflight_duration(
            raw, ext, profile.max_duration_s,
            profile.provider_label or "语音识别服务",
        )
        import app.db.session as db_session

        if db_session._engine is None:
            db_session._build_engine()
        async with db_session._SessionLocal() as db:
            result = await voice.transcribe(
                [{
                    "type": "audio", "mime": mime, "ext": ext,
                    "raw": raw, "duration": duration,
                }],
                settings,
                db=db,
                user_id=user_id,
                raise_errors=True,
            )
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.attention.voice_transcription", exc)
        return None
    return result.strip() if result and result.strip() else None


def _batch_attention_messages(
    payload: dict, transcripts: dict[str, str],
) -> tuple[AttentionMessage, ...]:
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
        raw_text = str(item.get("attention_raw_text", item.get("text", "")) or "")
        transcript = transcripts.get(str(event_id), "")
        candidate_text = "\n".join(
            part for part in (raw_text, transcript) if part
        )
        normalized.pop("attention_raw_text", None)
        normalized["text"] = candidate_text
        if transcript.strip():
            normalized["media_only"] = False
        messages.append(AttentionMessage.from_payload(str(event_id), normalized))
    return tuple(messages)


async def load_attention_snapshot(session_id: int, messages: tuple[AttentionMessage, ...]) -> AttentionSnapshot:
    """从同一 IM 会话及入站 Stream 读取完整观察窗口；缺少覆盖证明时标记不完整。"""
    from sqlalchemy import select
    import app.db.session as db_session
    from app.models import ConversationMessage
    from app.core import redis as R

    if db_session._engine is None:
        db_session._build_engine()
    now = datetime.now(UTC)
    now_ms = int(now.timestamp() * 1000)
    cutoff = now_ms - 600_000
    current_ids = {message.event_id for message in messages}
    scope = messages[0] if messages else None
    history: list[AttentionMessage] = []
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
        stream_history, stream_covers_window, window_truncated = await _recent_stream_messages(
            scope=scope,
            cutoff_ms=cutoff,
            watermark_ms=now_ms,
            current_ids=current_ids,
        )
        by_event_id = {item.event_id: item for item in (*history, *stream_history)}
        history = list(by_event_id.values())
        # Bot 身份缺失只会让依赖该特征的评分项不可用，不应让整批消息失去资格。
        complete = stream_covers_window and all(item.sender_id for item in messages)
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.attention.snapshot", exc)
        complete = False
        history = []

    bot_replies = {}
    latest_accepted_final = None
    try:
        redis = R.get_redis()
        bot_replies = await _load_bot_reply_facts(
            redis,
            (*history, *messages),
            platform=scope.platform,
            bot_id=scope.bot_id,
            group_id=scope.group_id,
        )
        from agent.im.auto_reply.delivery import accepted_finals_before

        accepted = await accepted_finals_before(
            redis,
            platform=scope.platform,
            bot_id=scope.bot_id,
            group_id=scope.group_id,
            watermark_ms=min((item.event_received_ms for item in messages), default=now_ms),
            limit=32,
        )
        accepted_facts = []
        for latest in accepted:
            def fact_value(name):
                return _receipt_value(latest, name)
            try:
                accepted_at = int(fact_value("accepted_at_ms") or 0)
            except (TypeError, ValueError):
                accepted_at = 0
            fact = None
            if accepted_at and fact_value("status") == "ACCEPTED":
                fact = BotReplyFact(
                    platform_message_id=fact_value("platform_message_id") or "",
                    sent_at_ms=accepted_at,
                    recipient_sender_id=fact_value("recipient_sender_id") or None,
                    accepted=fact_value("status") == "ACCEPTED",
                    proactive=fact_value("proactive") == "1",
                    source_attention_kind=fact_value("source_attention_kind"),
                    final_text=_validated_receipt_payload(latest),
                    delivery_id=fact_value("delivery_id"),
                )
                accepted_facts.append(fact)
                if latest_accepted_final is None:
                    latest_accepted_final = fact
        from agent.im.auto_reply.delivery import member_activation_before

        active_facts_by_delivery = {fact.delivery_id: fact for fact in accepted_facts if fact.delivery_id}
        for message in messages:
            if not message.sender_id:
                continue
            latest_member_reply = await member_activation_before(
                redis,
                platform=scope.platform,
                bot_id=scope.bot_id,
                group_id=scope.group_id,
                sender_id=message.sender_id,
                watermark_ms=message.event_received_ms,
            )
            if not latest_member_reply or _receipt_value(latest_member_reply, "status") != "ACCEPTED":
                continue
            try:
                accepted_at = int(_receipt_value(latest_member_reply, "accepted_at_ms") or 0)
            except (TypeError, ValueError):
                continue
            delivery_id = _receipt_value(latest_member_reply, "delivery_id")
            if not accepted_at or not delivery_id or delivery_id in active_facts_by_delivery:
                continue
            active_facts_by_delivery[delivery_id] = BotReplyFact(
                platform_message_id=_receipt_value(latest_member_reply, "platform_message_id") or "",
                sent_at_ms=accepted_at,
                recipient_sender_id=_receipt_value(latest_member_reply, "recipient_sender_id") or None,
                accepted=True,
                proactive=_receipt_value(latest_member_reply, "proactive") == "1",
                source_attention_kind=_receipt_value(latest_member_reply, "source_attention_kind"),
                final_text=_validated_receipt_payload(latest_member_reply),
                delivery_id=delivery_id,
            )
        accepted_facts = list(active_facts_by_delivery.values())
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.attention.outbound_facts", exc)
        complete = False
    return AttentionSnapshot(
        messages=tuple((*history, *messages)),
        complete=complete,
        window_truncated=window_truncated,
        bot_replies=bot_replies,
        latest_accepted_final=latest_accepted_final,
        accepted_outbound_facts=tuple(accepted_facts),
    )


def _receipt_value(receipt: dict, name: str) -> str | None:
    """兼容 Redis 客户端返回 str 或 bytes 的哈希字段。"""
    value = receipt.get(name)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value) if value is not None else None


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
            source_attention_kind=_receipt_value(receipt, "source_attention_kind"),
            final_text=_validated_receipt_payload(receipt),
            delivery_id=_receipt_value(receipt, "delivery_id"),
        )
    return facts


def _validated_receipt_payload(receipt: dict) -> str | None:
    """正文只能进入 scorer 前通过确定性摘要校验，日志不接触正文。"""
    from hashlib import sha256

    text = _receipt_value(receipt, "final_payload_text")
    expected = _receipt_value(receipt, "final_payload_hash")
    if not text or not expected:
        return None
    return text if sha256(text.encode("utf-8")).hexdigest() == expected else None




async def _recent_stream_messages(*, scope, cutoff_ms: int, watermark_ms: int,
                                  current_ids: set[str]) -> tuple[list[AttentionMessage], bool, bool | None]:
    """补入尚未落库的入站消息，并证明 Redis Stream 覆盖了完整话题 TTL 窗口。"""
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


async def _resolve_bot_aliases(request, payload: dict) -> tuple[str, ...]:
    aliases = [
        str(value).strip() for value in payload.get("bot_aliases", ())
        if isinstance(value, str) and value.strip()
    ]
    try:
        bot_id = int(payload.get("channel_id") or payload.get("bot_id") or 0)
    except (TypeError, ValueError):
        bot_id = 0
    user_id = getattr(request, "user_id", None)
    platform = str(payload.get("platform") or "")
    if bot_id and user_id is not None and platform:
        try:
            import app.db.session as db_session
            from app.models import UserBot
            if db_session._engine is None:
                db_session._build_engine()
            async with db_session._SessionLocal() as db:
                bot = await db.get(UserBot, bot_id)
                if (bot and bot.user_id == user_id and bot.platform == platform
                        and bot.enabled and str(bot.name or "").strip()):
                    aliases.append(str(bot.name).strip())
        except Exception as exc:
            from app.core.redaction import diag_log
            diag_log("agent.im.attention.bot_aliases", exc)
    # 当前产品暂不支持自定义称呼；所有已接入 Bot 统一响应“咕咕”。
    aliases.append("咕咕")
    return tuple(dict.fromkeys(aliases))


async def evaluate_group_attention(request, payload: dict) -> tuple[bool, AttentionDecision | None]:
    """返回是否进入 Run；不施加主动发言频率额度。"""
    inbound_messages = batch_attention_messages(payload)
    if not inbound_messages:
        return False, None
    raw_mode = str(payload.get("group_attention_mode") or "autonomous")
    mode = AttentionMode(raw_mode) if raw_mode in {item.value for item in AttentionMode} else AttentionMode.AUTONOMOUS
    if mode is AttentionMode.AUTONOMOUS:
        payload["_attention_snapshot_complete"] = None
        decision = decide_attention(inbound_messages[0], AttentionSnapshot(complete=False), mode)
        should_run = decision.kind in {
            AttentionKind.ALLOW_RUN, AttentionKind.DIRECT,
            AttentionKind.CONTINUE, AttentionKind.CAPABILITY_ACTION,
        }
        if should_run:
            from agent.im.auto_reply.pending_ask import cancel_pending_ask

            await cancel_pending_ask(payload)
            _set_attention_subject(payload, inbound_messages[0])
            payload["_attention_decision_kind"] = (
                decision.kind.value if decision.kind is not AttentionKind.ALLOW_RUN else "autonomous"
            )
        return should_run, decision
    try:
        transcripts = await transcribe_voice_for_attention(request, payload)
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.im.attention.voice_transcription", exc)
        transcripts = {}
    request.im_attention_transcripts = transcripts
    messages = build_logical_candidates(batch_attention_messages(payload, transcripts))
    if payload.get("_pending_ask_resume") is True:
        # 延迟消息仍复用原事件身份和正文，但评分以到期重入时刻为准，
        # 使 TOPIC/成员续聊检查能看到 60–180 秒观察期内的最新上下文。
        resume_ms = int(datetime.now(UTC).timestamp() * 1000)
        messages = tuple(
            replace(message, event_received_ms=resume_ms)
            for message in messages
        )
    if request.session_id is None:
        from agent.im.dispatch import _ensure_im_session

        request.session_id = await _ensure_im_session(request)
    snapshot = await load_attention_snapshot(int(request.session_id), messages)
    payload["_attention_snapshot_complete"] = snapshot.complete
    payload["_attention_window_truncated"] = snapshot.window_truncated
    bot_aliases = await _resolve_bot_aliases(request, payload)
    decisions = []
    decision_messages = []
    for message in messages:
        decision, _unused_anchor = await _decide_attention_message(
            message,
            snapshot,
            mode,
            bot_aliases=bot_aliases,
        )
        decisions.append(decision)
        decision_messages.append((message, decision))
    eligible = [
        (message, decision) for message, decision in decision_messages
        if decision.kind in {
            AttentionKind.DIRECT, AttentionKind.CONTINUE,
            AttentionKind.CAPABILITY_ACTION, AttentionKind.MEMBER_ACTIVE,
        }
    ]
    if eligible:
        message, decision = eligible[0]
        from agent.im.auto_reply.pending_ask import cancel_pending_ask

        await cancel_pending_ask(payload)
        _set_attention_subject(payload, message)
        payload["_attention_decision_kind"] = (
            "DIRECT" if decision.kind is AttentionKind.DIRECT
            else "member_CONTINUE" if decision.kind is AttentionKind.CONTINUE
            else "CAPABILITY_ACTION" if decision.kind is AttentionKind.CAPABILITY_ACTION
            else "member_ACTIVE"
        )
        return True, decision
    if not any(decision.kind is AttentionKind.PROACTIVE for _, decision in decision_messages):
        return False, max(decisions, key=lambda item: item.score)
    message, decision = next(
        (message, decision) for message, decision in decision_messages
        if decision.kind is AttentionKind.PROACTIVE
    )
    if decision.scene_type == "ASK" and not payload.get("_pending_ask_resume"):
        from agent.im.auto_reply.attention_algorithm import normalize_text
        from agent.im.auto_reply.pending_ask import register_pending_ask

        text = normalize_text(message.candidate_text or message.raw_text)
        aliases = tuple(normalize_text(alias) for alias in bot_aliases if normalize_text(alias))
        explicitly_targeted = (
            message.mentioned_current_bot is True
            or any(text.startswith(alias) for alias in aliases)
        )
        if not explicitly_targeted:
            try:
                if request.session_id is None:
                    from agent.im.request_preparation import _ensure_im_session

                    await _ensure_im_session(request)
                payload["session_id"] = int(request.session_id)
                pending_scope = await register_pending_ask(
                    payload,
                    event_ms=message.event_received_ms,
                    session_id=request.session_id,
                )
            except Exception as exc:
                from app.core.redaction import diag_log

                diag_log("agent.im.attention.pending_ask_register", exc)
                pending_scope = None
            if pending_scope:
                decision = replace(
                    decision,
                    reasons=(*decision.reasons, "pending_ask_waiting"),
                )
                return False, decision
    from agent.im.auto_reply.pending_ask import cancel_pending_ask

    await cancel_pending_ask(payload)
    _set_attention_subject(payload, message)
    payload["_attention_decision_kind"] = "proactive"
    return True, decision


__all__ = [
    "batch_attention_messages", "evaluate_group_attention",
    "load_attention_snapshot",
]
