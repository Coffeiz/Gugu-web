"""Telegram Gateway 的入队契约：按 Bot/update 幂等且不推进未入队游标。"""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from agent.gateway.telegram import runtime as telegram


@pytest.fixture(autouse=True)
def reset_chat_rate_state():
    telegram._CHAT_LOCKS.clear()
    telegram._CHAT_NEXT_SEND.clear()
    telegram._BOT_LOCKS.clear()
    telegram._BOT_NEXT_SEND.clear()


def _capture_callback_outputs(monkeypatch):
    answers = []
    removed_keyboards = []
    sent_messages = []

    async def answer(_token, query_id, *, text=None, show_alert=False):
        answers.append((query_id, text, show_alert))

    async def remove_keyboard(_token, bot_id, chat_id, message_id):
        removed_keyboards.append((bot_id, chat_id, message_id))

    async def send_message(chat_id, text, *, channel_id=None):
        sent_messages.append((chat_id, text, channel_id))
        return True

    monkeypatch.setattr(telegram, "_answer_callback_query", answer)
    monkeypatch.setattr(telegram, "_remove_callback_keyboard", remove_keyboard)
    monkeypatch.setattr("agent.gateway.telegram.send_message", send_message)
    return answers, removed_keyboards, sent_messages


async def _make_telegram_action(db, user, *, mcp_secret=False):
    """创建绑定 Telegram owner 的真实交互和一次性按钮。"""
    from app.models import ConversationSession, UserBot
    from app.services.interactions import create_prompt

    bot = UserBot(
        user_id=user.id,
        platform="telegram",
        app_id="9001",
        app_secret="123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789",
        owner_platform_user_id="7001",
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    session = ConversationSession(
        user_id=user.id,
        title="Telegram 回调回归",
        source="telegram",
        bot_id=str(bot.id),
        platform_user_id="7001",
        chat_type="c2c",
    )
    db.add(session)
    await db.commit()

    if mcp_secret:
        from app.models import UserMcpServer
        from app.services.interactions import create_agent_prompt

        server = UserMcpServer(
            user_id=user.id,
            scope="user",
            name="callback_secret",
            endpoint="https://mcp.example.test",
            credential_slots=[{
                "id": "key", "label": "Key", "target": "header", "name": "X-Key",
            }],
        )
        db.add(server)
        await db.commit()
        prompt, actions = await create_agent_prompt(
            user_id=user.id,
            session_id=session.id,
            tool_call_id="telegram-secret-callback",
            tool_name="manage_mcp_servers",
            payload={
                "_interaction": "ask_user",
                "kind": "form",
                "title": "补全凭据",
                "secret_fields": [{"name": "key", "label": "Key", "type": "secret"}],
                "secret_target": {"kind": "mcp_credentials", "server_id": str(server.id)},
            },
        )
        await db.commit()
        action = next(item for item in actions if item["id"] == "input_credentials")
        return bot, session, prompt, {**action, "prompt_id": prompt.id}

    prompt, actions = await create_prompt(
        db,
        user_id=user.id,
        session_id=session.id,
        kind="choice",
        title="确认操作",
        body="请选择操作",
        options=[
            {"id": "confirm", "label": "确认"},
            {"id": "cancel", "label": "取消"},
        ],
        source="agent",
    )
    await db.commit()
    return bot, session, prompt, {**actions[0], "prompt_id": prompt.id}


def _callback(action, *, query_id="callback-1", actor_id="7001", chat_type="private", chat_id=7001):
    from agent.interactions.telegram import encode_action_data

    return {
        "id": query_id,
        "from": {"id": actor_id},
        "message": {
            "message_id": 81,
            "chat": {"id": chat_id, "type": chat_type},
        },
        "data": encode_action_data(action["prompt_id"], action["token"]),
    }


def test_telegram_inline_keyboard_packs_short_and_long_labels_into_adaptive_rows():
    """短标签可并排，超长标签独占一行，且按钮顺序和回调数据保持不变。"""
    from agent.interactions.telegram import build_inline_keyboard, decode_action_data

    labels = ["A", "短", "中等长度按钮", "这是一个明显更长的按钮标签，用于验证是否独占一行", "完成"]
    keyboard = build_inline_keyboard({
        "prompt_id": 17,
        "options": [
            {"id": f"option-{index}", "label": label, "token": f"token-{index}"}
            for index, label in enumerate(labels)
        ],
    })

    rows = keyboard["inline_keyboard"]
    assert [[button["text"] for button in row] for row in rows] == [
        labels[:3], [labels[3]], [labels[4]],
    ]
    assert [decode_action_data(button["callback_data"]) for row in rows for button in row] == [
        (17, f"token-{index}") for index in range(len(labels))
    ]


def test_telegram_inline_keyboard_limits_short_buttons_per_row():
    from agent.interactions.telegram import build_inline_keyboard

    keyboard = build_inline_keyboard({
        "prompt_id": 18,
        "options": [
            {"id": label, "label": label, "token": f"token-{index}"}
            for index, label in enumerate("ABCDEF")
        ],
    })

    assert [len(row) for row in keyboard["inline_keyboard"]] == [4, 2]


@pytest.mark.asyncio
async def test_telegram_owner_callback_resolves_waiting_agent_prompt(db, user_a, monkeypatch):
    """Bot owner 点确认后，按钮结果持久化并可被等待中的 Agent 取回。"""
    from app.services.interactions import wait_for_resolution

    bot, _session, prompt, action = await _make_telegram_action(db, user_a)
    answers, removed_keyboards, sent_messages = _capture_callback_outputs(monkeypatch)

    processed = await telegram._handle_callback_query(
        _callback(action), token="test-token", bot_id=str(bot.id), owner_id=str(user_a.id),
    )

    assert processed is True
    assert answers == [("callback-1", None, False)]
    assert removed_keyboards == [(str(bot.id), "7001", 81)]
    assert sent_messages == [("7001", "已确认，任务继续执行。", str(bot.id))]
    resolved = await wait_for_resolution(user_id=user_a.id, prompt_id=prompt.id, timeout_seconds=1)
    assert resolved == {
        "kind": "choice", "status": "selected", "prompt_id": prompt.id,
        "option_id": "confirm", "value": "confirm", "text": "确认",
    }
    stored_prompt = await db.get(type(prompt), prompt.id)
    await db.refresh(stored_prompt)
    assert stored_prompt.status == "resolved"
    assert stored_prompt.schema_json["resolved_result"] == resolved


@pytest.mark.asyncio
async def test_telegram_non_owner_callback_is_rejected_without_consuming_action(db, user_a, monkeypatch):
    """非 owner 点击按钮时拒绝回调，等待中的 Agent 交互仍保持活动。"""
    from app.models import InteractionRequest

    bot, _session, prompt, action = await _make_telegram_action(db, user_a)
    answers, removed_keyboards, sent_messages = _capture_callback_outputs(monkeypatch)

    processed = await telegram._handle_callback_query(
        _callback(action, actor_id="8002"),
        token="test-token", bot_id=str(bot.id), owner_id=str(user_a.id),
    )

    assert processed is True
    assert answers == [("callback-1", "只有 Bot 绑定的所有者可以使用这些按钮。", True)]
    assert removed_keyboards == []
    assert sent_messages == []
    stored_prompt = await db.get(InteractionRequest, prompt.id)
    assert stored_prompt.status == "active"
    assert "resolved_result" not in stored_prompt.schema_json


@pytest.mark.asyncio
async def test_telegram_duplicate_callback_does_not_resolve_agent_action_twice(db, user_a, monkeypatch):
    """同一按钮的重复投递只写入一次结果，重放不会再次执行动作。"""
    from app.models import InteractionAction, InteractionRequest
    from app.services.interactions import _hash_token, wait_for_resolution

    bot, _session, prompt, action = await _make_telegram_action(db, user_a)
    answers, removed_keyboards, sent_messages = _capture_callback_outputs(monkeypatch)

    for query_id in ("callback-first", "callback-replay"):
        processed = await telegram._handle_callback_query(
            _callback(action, query_id=query_id),
            token="test-token", bot_id=str(bot.id), owner_id=str(user_a.id),
        )
        assert processed is True

    assert answers == [
        ("callback-first", None, False),
        ("callback-replay", "这个选项已过期或已经处理过了。", True),
    ]
    assert removed_keyboards == [(str(bot.id), "7001", 81)]
    assert sent_messages == [("7001", "已确认，任务继续执行。", str(bot.id))]
    stored_prompt = await db.get(InteractionRequest, prompt.id)
    stored_action = await db.scalar(select(InteractionAction).where(
        InteractionAction.prompt_id == prompt.id,
        InteractionAction.token_hash == _hash_token(action["token"]),
    ))
    await db.refresh(stored_prompt)
    await db.refresh(stored_action)
    assert stored_prompt.status == "resolved"
    assert stored_action.status == "consumed"
    assert stored_action.consumed_event_id == "callback-first"
    assert await wait_for_resolution(
        user_id=user_a.id, prompt_id=prompt.id, timeout_seconds=1,
    ) == stored_prompt.schema_json["resolved_result"]


@pytest.mark.asyncio
async def test_telegram_mcp_credential_button_requires_private_chat(db, user_a, monkeypatch):
    """MCP 凭据按钮在群聊被拒且不消费，回到 owner 私聊后才能启动输入。"""
    from app.models import InteractionRequest, McpSecretInput

    bot, _session, prompt, action = await _make_telegram_action(db, user_a, mcp_secret=True)
    answers, removed_keyboards, sent_messages = _capture_callback_outputs(monkeypatch)

    group_processed = await telegram._handle_callback_query(
        _callback(action, query_id="group-click", chat_type="group", chat_id="-1007002"),
        token="test-token", bot_id=str(bot.id), owner_id=str(user_a.id),
    )
    stage = await db.scalar(select(McpSecretInput).where(McpSecretInput.prompt_id == prompt.id))
    assert group_processed is True
    assert stage.status == "pending_choice"
    assert (await db.get(InteractionRequest, prompt.id)).status == "active"
    assert answers == [("group-click", "这个选项已过期或已经处理过了。", True)]
    assert removed_keyboards == []
    assert sent_messages == []

    private_processed = await telegram._handle_callback_query(
        _callback(action, query_id="private-click"),
        token="test-token", bot_id=str(bot.id), owner_id=str(user_a.id),
    )
    await db.refresh(stage)
    assert private_processed is True
    assert stage.status == "awaiting_secret"
    assert (await db.get(InteractionRequest, prompt.id)).status == "active"
    assert answers[-1] == ("private-click", None, False)
    assert removed_keyboards[-1] == (str(bot.id), "7001", 81)
    assert sent_messages[-1] == (
        "7001", "请在当前私聊发送凭据字段值；回复“取消”可终止。", str(bot.id),
    )


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
                {"update_id": 913, "edited_message": {
                    "message_id": 31, "chat": {"id": 7001, "type": "private"},
                    "from": {"id": 7001, "first_name": "测试"}, "text": "/delete_everything",
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
    assert update_calls[0]["allowed_updates"] == ["message", "callback_query"]
    assert update_calls[1]["offset"] == 914
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
async def test_send_message_receipt_contains_all_chunk_message_ids(db, user_a, monkeypatch):
    from app.models import UserBot

    bot = UserBot(
        user_id=user_a.id,
        platform="telegram",
        app_id="9003",
        app_secret="123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789",
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    calls = []

    async def api_call(_token, method, *, payload=None, timeout=20):
        calls.append(method)
        return {"message_id": 70 + len(calls)}

    monkeypatch.setattr(telegram, "call", api_call)
    monkeypatch.setattr(
        "agent.im.telegram_format.split_markdown_v2",
        lambda _text: ["第一段", "第二段"],
    )

    receipt = await telegram.send_message(
        "-7001", "长回复", channel_id=str(bot.id), return_receipt=True,
    )

    assert receipt == {
        "accepted": True,
        "platform_message_id": "72",
        "platform_message_ids": ["71", "72"],
    }
    assert calls == ["sendMessage", "sendMessage"]


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
