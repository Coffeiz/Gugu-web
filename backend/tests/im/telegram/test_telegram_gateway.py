"""Telegram Gateway 的入队契约：按 Bot/update 幂等且不推进未入队游标。"""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.gateway import telegram


@pytest.fixture(autouse=True)
def reset_chat_rate_state():
    telegram._CHAT_LOCKS.clear()
    telegram._CHAT_NEXT_SEND.clear()
    telegram._BOT_LOCKS.clear()
    telegram._BOT_NEXT_SEND.clear()


@pytest.mark.asyncio
async def test_update_enqueue_is_atomic_and_scoped_to_bot(monkeypatch):
    redis = SimpleNamespace(eval=AsyncMock(return_value=1))
    monkeypatch.setattr(telegram.R, "get_redis", lambda: redis)
    payload = {"platform": "telegram", "channel_id": "41", "text": "synthetic"}
    await telegram._persist_update("41", 900, payload)

    script, numkeys, *args = redis.eval.await_args.args
    keys = args[:3]
    payload_arg = json.loads(args[4])
    assert numkeys == 3
    assert keys[0] == telegram.R.IM_INBOUND_STREAM
    assert keys[1] == "im:telegram:41:update:900"
    assert keys[2] == "im:telegram:41:last-enqueued-update"
    assert "XADD" in script and "SET" in script
    assert args[5:] == [str(48 * 60 * 60), str(6 * 24 * 60 * 60)]
    assert payload_arg == payload


@pytest.mark.asyncio
async def test_ignored_update_advances_only_after_atomic_idempotency_write(monkeypatch):
    redis = SimpleNamespace(eval=AsyncMock(return_value=1))
    monkeypatch.setattr(telegram.R, "get_redis", lambda: redis)
    await telegram._persist_update("42", 901, None)

    args = redis.eval.await_args.args[2:]
    assert args[1] == "im:telegram:42:update:901"
    assert args[2] == "im:telegram:42:last-enqueued-update"
    assert args[4] == ""


@pytest.mark.asyncio
async def test_long_poll_resumes_after_last_atomically_enqueued_update(monkeypatch):
    bot_id = "41"
    cursor_state = {}
    enqueued = []
    calls = []
    stop_event = asyncio.Event()

    class Redis:
        async def get(self, key):
            return cursor_state.get(key)

        async def eval(self, _script, numkeys, *_args):
            _stream, _dedup, cursor_key, update_id, payload, *_ttl = _args
            cursor_state[cursor_key] = update_id
            if payload:
                enqueued.append(json.loads(payload))
            return 1

    redis = Redis()

    async def fake_call(_token, method, *, payload=None, timeout=20):
        calls.append((method, payload, timeout))
        if method == "getMe":
            return {"id": 9001, "username": "sample_bot"}
        if method == "getWebhookInfo":
            return {"url": ""}
        if method == "getUpdates" and sum(call[0] == method for call in calls) == 1:
            return [
                {"update_id": 912, "message": {
                    "message_id": 32, "chat": {"id": 7001, "type": "private"},
                    "from": {"id": 7001, "first_name": "测试"}, "text": "后到消息",
                }},
                {"update_id": 911, "message": {
                    "message_id": 31, "chat": {"id": 7001, "type": "private"},
                    "from": {"id": 7001, "first_name": "测试"}, "text": "先到消息",
                }},
            ]
        if method == "getUpdates":
            stop_event.set()
            return []
        raise AssertionError(f"unexpected API method: {method}")

    monkeypatch.setenv("TELEGRAM_BOT_ID", bot_id)
    monkeypatch.setenv("TELEGRAM_OWNER", "synthetic-owner")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789")
    monkeypatch.setattr(telegram, "_STOP", stop_event)
    monkeypatch.setattr(telegram.R, "get_redis", lambda: redis)
    monkeypatch.setattr(telegram, "call", fake_call)

    await telegram._run()

    update_calls = [payload for method, payload, _timeout in calls if method == "getUpdates"]
    assert update_calls[0].get("offset") is None
    assert update_calls[1]["offset"] == 913
    assert [item["platform_event_id"] for item in enqueued] == ["911", "912"]
    assert [item["text"] for item in enqueued] == ["先到消息", "后到消息"]


@pytest.mark.asyncio
async def test_send_message_retries_429_using_retry_after(db, user_a, monkeypatch):
    from app.models import UserBot
    from app.services.telegram_bot_api import TelegramBotApiError

    bot = UserBot(
        user_id=user_a.id,
        platform="telegram",
        app_id="9001",
        app_secret="123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789",
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    calls = []
    sleeps = []

    async def api_call(token, method, *, payload=None, timeout=20):
        calls.append((token, method, payload, timeout))
        if len(calls) == 1:
            raise TelegramBotApiError(method, status_code=429, error_code=429, retry_after=2)
        return {"message_id": 32}

    async def fake_sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr(telegram, "call", api_call)
    monkeypatch.setattr(telegram.asyncio, "sleep", fake_sleep)
    sent = await telegram.send_message("7001", "synthetic", channel_id=str(bot.id))

    assert sent is True
    assert [item[1] for item in calls] == ["sendMessage", "sendMessage"]
    assert len(sleeps) == 1
    assert abs(sleeps[0] - 2) < 0.01
    assert calls[0][2]["parse_mode"] == "MarkdownV2"


@pytest.mark.asyncio
async def test_send_message_replies_to_original_only_for_first_chunk(db, user_a, monkeypatch):
    from app.models import UserBot

    bot = UserBot(
        user_id=user_a.id,
        platform="telegram",
        app_id="9002",
        app_secret="123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789",
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    calls = []

    async def api_call(_token, method, *, payload=None, timeout=20):
        calls.append((method, payload))
        return {"message_id": len(calls)}

    monkeypatch.setattr(telegram, "call", api_call)
    monkeypatch.setattr(
        "agent.im.telegram_format.split_markdown_v2",
        lambda _text: ["第一段", "第二段"],
    )

    sent = await telegram.send_message(
        "7001", "长回复", channel_id=str(bot.id), reply_to_message_id="32"
    )

    assert sent is True
    assert [method for method, _payload in calls] == ["sendMessage", "sendMessage"]
    assert calls[0][1]["reply_to_message_id"] == 32
    assert "reply_to_message_id" not in calls[1][1]


@pytest.mark.asyncio
async def test_send_file_uses_multipart_photo_and_replies_to_source_message(db, user_a, monkeypatch):
    from app.models import UserBot

    bot = UserBot(
        user_id=user_a.id, platform="telegram", app_id="9003",
        app_secret="123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789",
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    calls = []

    async def api_call(token, method, *, payload=None, files=None, timeout=20):
        calls.append((token, method, payload, files, timeout))
        return {"message_id": 33}

    monkeypatch.setattr(telegram, "call", api_call)
    sent = await telegram.send_file(
        "7001", b"image-bytes", "sample.png", channel_id=str(bot.id),
        reply_to_message_id="32",
    )

    assert sent is True
    assert calls[0][1] == "sendPhoto"
    assert calls[0][2] == {"chat_id": "7001", "reply_to_message_id": 32}
    assert calls[0][3] == {"photo": ("sample.png", b"image-bytes", "image/png")}


@pytest.mark.asyncio
async def test_long_poll_survives_temporary_redis_cursor_read_failure(monkeypatch):
    stop_event = asyncio.Event()
    reads = []

    class Redis:
        async def get(self, _key):
            reads.append(True)
            if len(reads) == 1:
                raise ConnectionError("synthetic redis outage")
            return None

    calls = []

    async def api_call(_token, method, *, payload=None, timeout=20):
        calls.append(method)
        if method == "getMe":
            return {"id": 9001, "username": "sample_bot"}
        if method == "getWebhookInfo":
            return {"url": ""}
        if method == "getUpdates":
            stop_event.set()
            return []
        raise AssertionError(f"unexpected method: {method}")

    async def no_wait(_delay):
        return None

    monkeypatch.setenv("TELEGRAM_BOT_ID", "41")
    monkeypatch.setenv("TELEGRAM_OWNER", "synthetic-owner")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789")
    monkeypatch.setattr(telegram, "_STOP", stop_event)
    monkeypatch.setattr(telegram.R, "get_redis", lambda: Redis())
    monkeypatch.setattr(telegram, "call", api_call)
    monkeypatch.setattr(telegram.asyncio, "sleep", no_wait)

    await telegram._run()

    assert len(reads) == 2
    assert calls.count("getUpdates") == 1


@pytest.mark.asyncio
async def test_group_outbound_rate_limit_keeps_three_second_spacing(monkeypatch):
    now = [100.0]
    sleeps = []
    calls = []

    def monotonic():
        return now[0]

    async def sleep(delay):
        sleeps.append(delay)
        now[0] += delay

    async def api_call(_token, method, *, payload=None, timeout=20):
        calls.append((method, payload))
        return {"message_id": len(calls)}

    monkeypatch.setattr(telegram.time, "monotonic", monotonic)
    monkeypatch.setattr(telegram.asyncio, "sleep", sleep)
    monkeypatch.setattr(telegram, "call", api_call)

    for _ in range(2):
        await telegram._call_for_chat(
            "synthetic-token", "sendMessage", {"chat_id": "-1007002"},
            channel_id="41", chat_id="-1007002", is_group=True,
        )

    assert len(calls) == 2
    assert sleeps == [3.0]


@pytest.mark.asyncio
async def test_long_poll_reconnects_after_temporary_telegram_api_failure(monkeypatch):
    stop_event = asyncio.Event()
    redis = SimpleNamespace(get=AsyncMock(return_value=None))
    calls = []
    poll_count = 0

    async def api_call(_token, method, *, payload=None, timeout=20):
        nonlocal poll_count
        calls.append(method)
        if method == "getMe":
            return {"id": 9001, "username": "sample_bot"}
        if method == "getWebhookInfo":
            return {"url": ""}
        if method == "getUpdates":
            poll_count += 1
            if poll_count == 1:
                from app.services.telegram_bot_api import TelegramBotApiError
                raise TelegramBotApiError(method, status_code=503)
            stop_event.set()
            return []
        raise AssertionError(f"unexpected method: {method}")

    async def wait_for(awaitable, timeout):
        awaitable.close()
        assert timeout == 1
        raise asyncio.TimeoutError

    monkeypatch.setenv("TELEGRAM_BOT_ID", "41")
    monkeypatch.setenv("TELEGRAM_OWNER", "synthetic-owner")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789")
    monkeypatch.setattr(telegram, "_STOP", stop_event)
    monkeypatch.setattr(telegram.R, "get_redis", lambda: redis)
    monkeypatch.setattr(telegram, "call", api_call)
    monkeypatch.setattr(telegram.asyncio, "wait_for", wait_for)

    await telegram._run()

    assert poll_count == 2


def test_gateway_registers_sigterm_to_stop_long_poll(monkeypatch):
    handlers = {}
    stop_event = asyncio.Event()
    monkeypatch.setattr(telegram, "_STOP", stop_event)
    monkeypatch.setattr("app.core.logging.setup_process_output", lambda: None)
    monkeypatch.setattr(telegram.asyncio, "set_event_loop", lambda _loop: None)

    class Loop:
        def add_signal_handler(self, sig, callback):
            handlers[sig] = callback

        def run_until_complete(self, awaitable):
            awaitable.close()

        async def shutdown_asyncgens(self):
            return None

        def close(self):
            return None

    fake_loop = Loop()
    monkeypatch.setattr(telegram.asyncio, "new_event_loop", lambda: fake_loop)
    monkeypatch.setattr(telegram, "_run", lambda: _empty_coroutine())

    telegram.main()

    handlers[telegram.signal.SIGTERM]()
    assert stop_event.is_set()


async def _empty_coroutine():
    return None


def test_gateway_restarts_telegram_process_when_token_spec_changes(monkeypatch):
    from agent.gateway import gateway

    key = "telegram:17"
    old = {"id": "17", "platform": "telegram", "app_id": "9001", "app_secret": "old-test-token", "sandbox": False, "owner": "owner-1"}
    new = {**old, "app_secret": "new-test-token"}
    class RunningProcess:
        def poll(self):
            return None

    running = RunningProcess()
    spawned = []
    killed = []
    monkeypatch.setattr(gateway, "_desired", lambda: {key: new})
    monkeypatch.setattr(gateway, "_procs", {key: running})
    monkeypatch.setattr(gateway, "_procs_spec", {key: old})
    monkeypatch.setattr(gateway, "_spawned_at", {key: 1.0})
    monkeypatch.setattr(gateway, "_fail_count", {})
    monkeypatch.setattr(gateway, "_next_retry_at", {})
    monkeypatch.setattr(gateway, "_kill", lambda proc_key, proc: killed.append((proc_key, proc)))
    monkeypatch.setattr(gateway, "_spawn", lambda proc_key, spec: spawned.append((proc_key, spec)) or "replacement")

    gateway.reconcile()

    assert killed == [(key, running)]
    assert spawned == [(key, new)]
    assert gateway._procs[key] == "replacement"
    assert gateway._procs_spec[key] == new
