"""Telegram Bot API 长轮询 Gateway（每个已启用 Bot 独立子进程）。"""
from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import signal
import time

from app.core import redis as R
from app.core.redaction import diag_log
from app.services.telegram_bot_api import TelegramBotApiError, call, validate_bot_token
from agent.im.parsers.telegram import normalize_message

_log = logging.getLogger("agent.gateway.telegram")
_STOP = asyncio.Event()
_DEDUP_TTL = 48 * 60 * 60
_CURSOR_TTL = 6 * 24 * 60 * 60
_CHAT_LOCKS: dict[tuple[str, str], asyncio.Lock] = {}
_CHAT_NEXT_SEND: dict[tuple[str, str], float] = {}
_BOT_LOCKS: dict[str, asyncio.Lock] = {}
_BOT_NEXT_SEND: dict[str, float] = {}
_ENQUEUE_UPDATE_LUA = """
local stream, dedup, cursor = KEYS[1], KEYS[2], KEYS[3]
local update_id, payload, dedup_ttl, cursor_ttl = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
if redis.call('EXISTS', dedup) == 0 then
  if payload ~= '' then
    redis.call('XADD', stream, 'MAXLEN', '~', 10000, '*', 'data', payload)
  end
  redis.call('SET', dedup, '1', 'EX', dedup_ttl)
end
redis.call('SET', cursor, update_id, 'EX', cursor_ttl)
return 1
"""


def _cursor_key(bot_id: str) -> str:
    return f"im:telegram:{bot_id}:last-enqueued-update"


def _dedup_key(bot_id: str, update_id: int) -> str:
    return f"im:telegram:{bot_id}:update:{update_id}"


def _send_failure_receipt(*, return_receipt: bool, outcome: str) -> bool | dict:
    if not return_receipt:
        return False
    return {"accepted": False, "outcome": outcome}


def _is_new_message_update(update: dict) -> bool:
    """编辑消息不能重新触发 Agent 或有副作用的工具调用。"""
    return isinstance(update.get("message"), dict)


async def _persist_update(bot_id: str, update_id: int, payload: dict | None) -> None:
    import json

    redis = R.get_redis()
    await redis.eval(
        _ENQUEUE_UPDATE_LUA,
        3,
        R.IM_INBOUND_STREAM,
        _dedup_key(bot_id, update_id),
        _cursor_key(bot_id),
        str(update_id),
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) if payload is not None else "",
        str(_DEDUP_TTL),
        str(_CURSOR_TTL),
    )


async def _call_for_chat(
    token: str,
    method: str,
    payload: dict,
    *,
    channel_id: str,
    chat_id: str,
    is_group: bool,
    files: dict | None = None,
) -> object:
    """按 Telegram 每 chat 发送限制串行出站，并有限遵循 429 Retry-After。"""
    key = (str(channel_id), str(chat_id))
    lock = _CHAT_LOCKS.setdefault(key, asyncio.Lock())
    bot_key = str(channel_id)
    bot_lock = _BOT_LOCKS.setdefault(bot_key, asyncio.Lock())
    interval = 3.0 if is_group else 1.0
    async with bot_lock, lock:
        for attempt in range(3):
            now = time.monotonic()
            delay = max(
                _CHAT_NEXT_SEND.get(key, 0.0) - now,
                _BOT_NEXT_SEND.get(bot_key, 0.0) - now,
            )
            if delay > 0:
                await asyncio.sleep(delay)
            try:
                call_kwargs = {"payload": payload}
                if files:
                    call_kwargs["files"] = files
                result = await call(token, method, **call_kwargs)
            except TelegramBotApiError as exc:
                if exc.error_code != 429 or not exc.retry_after or attempt == 2:
                    raise
                next_send = time.monotonic() + max(float(exc.retry_after), interval)
                _CHAT_NEXT_SEND[key] = next_send
                _BOT_NEXT_SEND[bot_key] = next_send
                continue
            next_send = time.monotonic() + interval
            _CHAT_NEXT_SEND[key] = next_send
            _BOT_NEXT_SEND[bot_key] = time.monotonic() + (1.0 / 30.0)
            return result
    raise TelegramBotApiError(method)


async def _bot_token(channel_id: str) -> str | None:
    import app.db.session as S
    from app.models import UserBot
    from sqlalchemy import select

    if S._engine is None:
        S._build_engine()
    async with S._SessionLocal() as db:
        bot = (await db.execute(select(UserBot).where(
            UserBot.id == int(channel_id),
            UserBot.platform == "telegram",
            UserBot.enabled.is_(True),
        ))).scalars().first()
        return bot.app_secret if bot else None


async def send_message(chat_id: str, text: str, *, channel_id: str,
                       reply_to_message_id: str | None = None,
                       return_receipt: bool = False) -> bool | dict:
    """通过数据库取凭据发送文本；异常只进入受限诊断，不泄露 URL。"""
    return await _send_chat_message(
        chat_id, text, channel_id=channel_id,
        reply_to_message_id=reply_to_message_id,
        return_receipt=return_receipt,
        diagnostic_operation="agent.gateway.telegram.send_message",
    )


async def _send_chat_message(
    chat_id: str,
    text: str,
    *,
    channel_id: str,
    reply_to_message_id: str | None = None,
    prompt: dict | None = None,
    return_receipt: bool = False,
    diagnostic_operation: str,
) -> bool | dict:
    try:
        token = await _bot_token(channel_id)
        if not token:
            return _send_failure_receipt(return_receipt=return_receipt, outcome="FAILED_CONFIRMED")
        from agent.im.telegram_format import split_markdown_v2

        chunks = split_markdown_v2(text)
        if not chunks:
            return _send_failure_receipt(return_receipt=return_receipt, outcome="FAILED_CONFIRMED")
        reply_markup = None
        if prompt is not None:
            from agent.interactions.telegram import build_inline_keyboard

            reply_markup = build_inline_keyboard(prompt)
        platform_message_ids = []
        for index, chunk in enumerate(chunks):
            body = {"chat_id": chat_id, "text": chunk, "parse_mode": "MarkdownV2"}
            if index == 0 and reply_to_message_id:
                body["reply_to_message_id"] = int(reply_to_message_id)
            if index == len(chunks) - 1 and reply_markup:
                body["reply_markup"] = reply_markup
            result = await _call_for_chat(
                token, "sendMessage", body, channel_id=channel_id, chat_id=chat_id,
                is_group=chat_id.startswith("-"),
            )
            message_id = result.get("message_id") if isinstance(result, dict) else None
            if message_id is not None:
                platform_message_ids.append(str(message_id))
        if return_receipt:
            return {
                "accepted": True,
                "platform_message_id": platform_message_ids[-1] if platform_message_ids else None,
                "platform_message_ids": platform_message_ids,
            }
        return True
    except Exception as exc:
        diag_log(diagnostic_operation, exc)
        outcome = (
            "FAILED_CONFIRMED"
            if isinstance(exc, TelegramBotApiError)
            and exc.status_code is not None
            and 300 <= exc.status_code < 500
            else "UNKNOWN"
        )
        return _send_failure_receipt(return_receipt=return_receipt, outcome=outcome)


async def send_interaction_message(
    chat_id: str,
    text: str,
    prompt: dict,
    *,
    channel_id: str,
) -> bool:
    """发送带 Inline Keyboard 的统一交互 Prompt。"""
    return await _send_chat_message(
        chat_id,
        text,
        channel_id=channel_id,
        prompt=prompt,
        diagnostic_operation="agent.gateway.telegram.send_interaction_message",
    )


async def _answer_callback_query(token: str, callback_query_id: str, *,
                                 text: str | None = None, show_alert: bool = False) -> None:
    if not callback_query_id:
        return
    payload: dict[str, object] = {"callback_query_id": callback_query_id}
    if text:
        payload["text"] = str(text)[:200]
    if show_alert:
        payload["show_alert"] = True
    try:
        await call(token, "answerCallbackQuery", payload=payload, timeout=5)
    except Exception as exc:
        diag_log("agent.gateway.telegram.answer_callback_query", exc)


async def _remove_callback_keyboard(
    token: str, bot_id: str, chat_id: str, message_id: int,
) -> None:
    try:
        await _call_for_chat(
            token,
            "editMessageReplyMarkup",
            {"chat_id": chat_id, "message_id": message_id, "reply_markup": {"inline_keyboard": []}},
            channel_id=bot_id,
            chat_id=chat_id,
            is_group=chat_id.startswith("-"),
        )
    except Exception as exc:
        diag_log("agent.gateway.telegram.remove_interaction_keyboard", exc)


async def _handle_callback_query(
    callback_query: dict,
    *,
    token: str,
    bot_id: str,
    owner_id: str,
) -> bool:
    """由 owner 身份校验后消费统一 Action，并恢复等待中的 Agent Run。"""
    from agent.interactions.telegram import decode_action_data

    query_id = str(callback_query.get("id") or "")
    actor = callback_query.get("from")
    message = callback_query.get("message")
    chat = message.get("chat") if isinstance(message, dict) else None
    if not query_id or not isinstance(actor, dict) or not isinstance(chat, dict):
        await _answer_callback_query(token, query_id, text="这个按钮无效。", show_alert=True)
        return True
    try:
        prompt_id, action_token = decode_action_data(str(callback_query.get("data") or ""))
    except (TypeError, ValueError):
        await _answer_callback_query(token, query_id, text="这个按钮无效。", show_alert=True)
        return True

    actor_id = str(actor.get("id") or "")
    chat_id = str(chat.get("id") or "")
    chat_kind = str(chat.get("type") or "")
    if not actor_id or not chat_id or chat_kind not in {"private", "group", "supergroup"}:
        await _answer_callback_query(token, query_id, text="无法识别操作者或会话。", show_alert=True)
        return True
    chat_type = "c2c" if chat_kind == "private" else "group"

    try:
        from uuid import UUID
        import app.db.session as db_session
        from app.models import UserBot
        from app.services.interactions import consume_action
        from app.services.mcp_secret_inputs import consume_mcp_secret_action
        from sqlalchemy import select

        if db_session._engine is None:
            db_session._build_engine()
        if db_session._SessionLocal is None:
            raise RuntimeError("数据库不可用")
        user_id = UUID(str(owner_id))
        async with db_session._SessionLocal() as db:
            bot = (await db.execute(select(UserBot).where(
                UserBot.id == int(bot_id),
                UserBot.user_id == user_id,
                UserBot.platform == "telegram",
                UserBot.enabled.is_(True),
                UserBot.owner_platform_user_id == actor_id,
            ))).scalars().first()
            if bot is None:
                await _answer_callback_query(
                    token, query_id, text="只有 Bot 绑定的所有者可以使用这些按钮。", show_alert=True,
                )
                return True
            result = await consume_mcp_secret_action(
                db,
                user_id=user_id,
                prompt_id=prompt_id,
                token=action_token,
                event_id=query_id,
                platform="telegram",
                bot_id=bot_id,
                platform_user_id=actor_id,
                chat_type=chat_type,
                chat_id=chat_id if chat_type == "group" else None,
            )
            if result is None:
                result = await consume_action(
                    db,
                    user_id=user_id,
                    prompt_id=prompt_id,
                    token=action_token,
                    event_id=query_id,
                )
    except (LookupError, ValueError) as exc:
        await _answer_callback_query(token, query_id, text="这个选项已过期或已经处理过了。", show_alert=True)
        diag_log("agent.gateway.telegram.interaction_expired", exc)
        return True
    except Exception as exc:
        if getattr(exc, "status_code", None) in {404, 409}:
            await _answer_callback_query(token, query_id, text="这个选项已过期或已经处理过了。", show_alert=True)
            return True
        diag_log("agent.gateway.telegram.interaction", exc)
        await _answer_callback_query(token, query_id, text="暂时无法处理这个选项，请稍后重试。", show_alert=True)
        return False

    await _answer_callback_query(token, query_id)
    message_id = message.get("message_id")
    if isinstance(message_id, int) and not isinstance(message_id, bool):
        await _remove_callback_keyboard(token, bot_id, chat_id, message_id)

    from agent.gateway.telegram import send_message as send_chat_message

    result_payload = result.get("result") if isinstance(result.get("result"), dict) else {}
    option_id = str(result.get("option_id") or "")
    if result_payload.get("status") == "awaiting_text":
        response = "请直接发送你的回复，咕咕会继续处理。"
    elif result.get("status") == "awaiting_secret":
        response = "请在当前私聊发送凭据字段值；回复“取消”可终止。"
    elif result.get("status") == "cancelled":
        response = "已取消。"
    elif result.get("status") == "duplicate":
        response = "这个操作已经处理过了。"
    elif option_id == "confirm":
        response = "已确认，任务继续执行。"
    elif option_id == "cancel":
        response = "已取消。"
    else:
        selected_text = str(result_payload.get("text") or option_id or "已选择")
        response = f"已选择：{selected_text}，继续处理。"
    await send_chat_message(chat_id, response, channel_id=bot_id)
    return True


async def _handle_callback_update(
    update: dict,
    *,
    bot_id: str,
    owner_id: str,
    token: str,
    update_id: int,
) -> bool:
    processed = await _handle_callback_query(
        update["callback_query"], token=token, bot_id=bot_id, owner_id=owner_id,
    )
    if processed:
        await _persist_update(bot_id, update_id, None)
    return processed


async def _process_update(
    update: dict,
    *,
    bot_id: str,
    owner_id: str,
    bot_username: str,
    bot_platform_id: str,
    token: str,
) -> bool:
    update_id = update.get("update_id")
    if not isinstance(update_id, int):
        return True
    if isinstance(update.get("callback_query"), dict):
        return await _handle_callback_update(
            update,
            bot_id=bot_id,
            owner_id=owner_id,
            token=token,
            update_id=update_id,
        )
    if not _is_new_message_update(update):
        await _persist_update(bot_id, update_id, None)
        return True
    normalized = normalize_message(
        update,
        bot_id=bot_id,
        owner_id=owner_id,
        bot_username=bot_username,
        bot_platform_id=bot_platform_id,
    )
    if normalized is not None:
        normalized["platform_event_id"] = str(update_id)
        normalized["message_id"] = str(normalized.get("message_id") or "")
        if not normalized.get("attachments"):
            from agent.im.shortcuts import apply_im_shortcut_cancel, decide_im_shortcut

            platform_user_id = str(normalized.get("platform_user_id") or "")
            dec = await decide_im_shortcut(
                "telegram",
                platform_user_id,
                str(normalized.get("text") or ""),
                bot_id=str(bot_id),
                scope_id=str(normalized.get("chat_id") or platform_user_id),
                allow_leading_mention=bool(normalized.get("group_mentioned")),
            )
            if dec.get("action") in {"cancel", "no_permission"}:
                if dec["action"] == "cancel":
                    await apply_im_shortcut_cancel(
                        "telegram",
                        platform_user_id,
                        dec,
                        bot_id=str(bot_id),
                        scope_id=str(normalized.get("chat_id") or platform_user_id),
                    )
                await _persist_update(bot_id, update_id, None)
                await send_message(
                    str(normalized.get("chat_id") or platform_user_id),
                    str(dec.get("reply") or ""),
                    channel_id=str(bot_id),
                    reply_to_message_id=str(normalized.get("message_id") or "") or None,
                )
                return True
    await _persist_update(bot_id, update_id, normalized)
    return True


async def send_message_draft(
    chat_id: str,
    text: str,
    *,
    channel_id: str,
    draft_id: int,
) -> bool:
    """更新 Telegram 私聊中的临时流式草稿；正式消息仍由 send_message 持久化。"""
    try:
        token = await _bot_token(channel_id)
        if not token or not isinstance(draft_id, int) or isinstance(draft_id, bool) or draft_id == 0:
            return False
        await _call_for_chat(
            token,
            "sendMessageDraft",
            {
                "chat_id": chat_id,
                "draft_id": draft_id,
                "text": str(text or "")[:4096],
            },
            channel_id=channel_id,
            chat_id=chat_id,
            is_group=False,
        )
        return True
    except Exception as exc:
        diag_log("agent.gateway.telegram.send_message_draft", exc)
        return False


async def send_file(
    chat_id: str,
    data: bytes,
    filename: str,
    *,
    channel_id: str,
    reply_to_message_id: str | None = None,
) -> bool:
    """以照片或通用文件发送已通过所有权校验的附件。"""
    try:
        token = await _bot_token(channel_id)
        if not token or not data or len(data) > 50_000_000:
            return False
        safe_name = str(filename or "附件").replace("\\", "/").rsplit("/", 1)[-1][:180]
        mime = mimetypes.guess_type(safe_name)[0] or "application/octet-stream"
        ext = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else ""
        is_photo = ext in {"jpg", "jpeg", "png"} and len(data) <= 10_000_000
        method = "sendPhoto" if is_photo else "sendDocument"
        field_name = "photo" if is_photo else "document"
        body = {"chat_id": chat_id}
        if reply_to_message_id:
            try:
                body["reply_to_message_id"] = int(reply_to_message_id)
            except (TypeError, ValueError):
                pass
        upload = {field_name: (safe_name or "附件", data, mime)}
        try:
            await _call_for_chat(
                token, method, body, channel_id=channel_id, chat_id=chat_id,
                is_group=chat_id.startswith("-"), files=upload,
            )
        except TelegramBotApiError as exc:
            if not is_photo or exc.error_code != 400:
                raise
            await _call_for_chat(
                token, "sendDocument", {"chat_id": chat_id},
                channel_id=channel_id, chat_id=chat_id,
                is_group=chat_id.startswith("-"),
                files={"document": (safe_name or "附件", data, mime)},
            )
        return True
    except Exception as exc:
        diag_log("agent.gateway.telegram.send_file", exc)
        return False


async def _run() -> None:
    bot_id = os.getenv("TELEGRAM_BOT_ID", "").strip()
    owner_id = os.getenv("TELEGRAM_OWNER", "").strip()
    token = validate_bot_token(os.getenv("TELEGRAM_BOT_TOKEN", ""))
    if not bot_id.isdigit() or not owner_id:
        raise RuntimeError("Telegram Gateway 配置无效")

    bot_info = await call(token, "getMe")
    bot_platform_id = str(bot_info.get("id") or "") if isinstance(bot_info, dict) else ""
    bot_username = str(bot_info.get("username") or "") if isinstance(bot_info, dict) else ""
    webhook = await call(token, "getWebhookInfo")
    if isinstance(webhook, dict) and str(webhook.get("url") or "").strip():
        _log.error("Telegram Gateway 检测到 Webhook 冲突，停止长轮询 bot=%s", bot_id)
        return

    redis = R.get_redis()
    backoff = 1.0
    while not _STOP.is_set():
        try:
            cursor = await redis.get(_cursor_key(bot_id))
            payload: dict[str, object] = {
                "timeout": 50,
                "allowed_updates": ["message", "callback_query"],
            }
            if cursor is not None:
                payload["offset"] = int(cursor) + 1
            updates = await call(token, "getUpdates", payload=payload, timeout=60)
            if not isinstance(updates, list):
                raise TelegramBotApiError("getUpdates")
            backoff = 1.0
            for update in sorted((item for item in updates if isinstance(item, dict)), key=lambda item: int(item.get("update_id", -1))):
                processed = await _process_update(
                    update,
                    bot_id=bot_id,
                    owner_id=owner_id,
                    bot_username=bot_username,
                    bot_platform_id=bot_platform_id,
                    token=token,
                )
                if not processed:
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60)
                    break
        except TelegramBotApiError as exc:
            delay = max(1, min(exc.retry_after or int(backoff), 300))
            _log.warning("Telegram API 暂不可用 method=%s status=%s retry=%ss", exc.operation, exc.status_code, delay)
            backoff = min(backoff * 2, 60)
            try:
                await asyncio.wait_for(_STOP.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass
        except Exception as exc:
            diag_log("agent.gateway.telegram.poll", exc)
            try:
                await asyncio.wait_for(_STOP.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, 60)


def main() -> None:
    from app.core.logging import setup_process_output

    setup_process_output()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _STOP.set)
        except NotImplementedError:
            signal.signal(sig, lambda *_: _STOP.set())
    try:
        loop.run_until_complete(_run())
    except Exception as exc:
        diag_log("agent.gateway.telegram.start", exc)
        raise SystemExit(1) from None
    finally:
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()


if __name__ == "__main__":
    main()
