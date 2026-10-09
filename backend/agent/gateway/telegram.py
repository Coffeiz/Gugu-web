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
                       reply_to_message_id: str | None = None) -> bool:
    """通过数据库取凭据发送文本；异常只进入受限诊断，不泄露 URL。"""
    try:
        token = await _bot_token(channel_id)
        if not token:
            return False
        from agent.im.telegram_format import split_markdown_v2

        chunks = split_markdown_v2(text)
        for index, chunk in enumerate(chunks):
            body = {"chat_id": chat_id, "text": chunk, "parse_mode": "MarkdownV2"}
            if index == 0 and reply_to_message_id:
                body["reply_to_message_id"] = int(reply_to_message_id)
            await _call_for_chat(
                token, "sendMessage", body, channel_id=channel_id, chat_id=chat_id,
                is_group=chat_id.startswith("-"),
            )
        return True
    except Exception as exc:
        diag_log("agent.gateway.telegram.send_message", exc)
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
            payload: dict[str, object] = {"timeout": 50, "allowed_updates": ["message"]}
            if cursor is not None:
                payload["offset"] = int(cursor) + 1
            updates = await call(token, "getUpdates", payload=payload, timeout=60)
            if not isinstance(updates, list):
                raise TelegramBotApiError("getUpdates")
            backoff = 1.0
            for update in sorted((item for item in updates if isinstance(item, dict)), key=lambda item: int(item.get("update_id", -1))):
                update_id = update.get("update_id")
                if not isinstance(update_id, int):
                    continue
                if not _is_new_message_update(update):
                    await _persist_update(bot_id, update_id, None)
                    continue
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
                # 只有 Redis Lua 同时确认入队/标记后才推进 offset；无文本更新也写幂等标记。
                await _persist_update(bot_id, update_id, normalized)
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
