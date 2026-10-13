"""保护微信 Gateway 拆包涉及的协议、缓存、媒体和生命周期行为。"""

import asyncio
import base64

import pytest

from agent.gateway.wechat import client, config_cache, media_crypto, outbound, runtime, typing


@pytest.mark.asyncio
async def test_wechat_client_send_text_keeps_inbound_context_token():
    client_instance = client.ILinkClient("synthetic-token", "https://example.test")
    requests = []

    async def fake_post(path, body):
        requests.append((path, body))
        return {"ret": 0}

    client_instance._post = fake_post
    result = await client_instance.send_text("wx-user", "合成回复", "context-123")

    assert result == {"ret": 0}
    assert requests[0][0] == "ilink/bot/sendmessage"
    message = requests[0][1]["msg"]
    assert message["context_token"] == "context-123"
    assert message["to_user_id"] == "wx-user"
    assert message["item_list"] == [{"type": 1, "text_item": {"text": "合成回复"}}]


@pytest.mark.asyncio
async def test_wechat_text_outbound_refuses_missing_context_token_before_client_use(monkeypatch):
    async def client_must_not_be_created(_channel_id):
        raise AssertionError("missing context token must stop before client creation")

    monkeypatch.setattr(outbound, "_client_for", client_must_not_be_created)

    sent = await outbound.send_text("wx-user", "合成回复", "bot-1", context_token="")

    assert sent is False


@pytest.mark.asyncio
async def test_wechat_text_outbound_passes_context_token_to_client(monkeypatch):
    sent = []

    class FakeClient:
        async def send_text(self, user_id, text, context_token):
            sent.append((user_id, text, context_token))
            return {"ret": 0}

    async def get_client(_channel_id):
        return FakeClient()

    monkeypatch.setattr(outbound, "_client_for", get_client)

    assert await outbound.send_text(
        "wx-user", "合成回复", "bot-1", context_token="context-456"
    ) is True
    assert sent == [("wx-user", "合成回复", "context-456")]


@pytest.mark.parametrize(
    ("sender", "arguments", "media_type", "item_type", "item_key", "item_body"),
    [
        (
            outbound.send_image,
            ("wx-user", b"synthetic-image", "context-image"),
            client.UPLOAD_MEDIA_TYPE_IMAGE,
            client.MESSAGE_ITEM_TYPE_IMAGE,
            "image_item",
            {
                "media": {
                    "encrypt_query_param": "download-image",
                    "aes_key": "synthetic-aes-key",
                    "encrypt_type": 1,
                },
                "mid_size": 32,
            },
        ),
        (
            outbound.send_file,
            ("wx-user", b"synthetic-file", "notes.txt", "context-file"),
            client.UPLOAD_MEDIA_TYPE_FILE,
            client.MESSAGE_ITEM_TYPE_FILE,
            "file_item",
            {
                "media": {
                    "encrypt_query_param": "download-file",
                    "aes_key": "synthetic-aes-key",
                    "encrypt_type": 1,
                },
                "file_name": "notes.txt",
                "len": "14",
            },
        ),
    ],
)
@pytest.mark.asyncio
async def test_wechat_media_outbound_keeps_context_token_and_upload_protocol(
    monkeypatch, sender, arguments, media_type, item_type, item_key, item_body,
):
    calls = []

    class FakeClient:
        async def sendmessage(self, message):
            calls.append(message)
            return {"ret": 0}

    async def get_client(channel_id):
        assert channel_id == "bot-1"
        return FakeClient()

    async def upload(_client, data, actual_media_type, user_id):
        assert data in (b"synthetic-image", b"synthetic-file")
        assert actual_media_type == media_type
        assert user_id == "wx-user"
        return {
            "download_param": f"download-{item_key.removesuffix('_item')}",
            "aeskey_b64": "synthetic-aes-key",
            "padded_size": 32,
            "raw_size": len(data),
        }

    monkeypatch.setattr(outbound, "_client_for", get_client)
    monkeypatch.setattr(outbound, "_upload_to_cdn", upload)

    assert await sender(*arguments, channel_id="bot-1") is True

    message = calls[0]
    assert message["context_token"] == arguments[-1]
    assert message["to_user_id"] == "wx-user"
    assert message["item_list"] == [{"type": item_type, item_key: item_body}]


@pytest.mark.asyncio
async def test_wechat_config_cache_reuses_ticket_and_backs_off_after_refresh_failure(monkeypatch):
    now = [1_000.0]

    class FakeClient:
        def __init__(self, **_kwargs):
            self.calls = 0
            self.stopped = False

        async def start(self):
            return None

        async def stop(self):
            self.stopped = True

        async def get_config(self, user_id, context_token):
            assert (user_id, context_token) == ("wx-user", "context-789")
            self.calls += 1
            if self.calls == 1:
                return {"ret": 0, "typing_ticket": "ticket-1"}
            raise ConnectionError("synthetic refresh failure")

    clients = []

    def make_client(**kwargs):
        instance = FakeClient(**kwargs)
        clients.append(instance)
        return instance

    monkeypatch.setattr(config_cache, "ILinkClient", make_client)
    monkeypatch.setattr(config_cache, "_now_ms", lambda: now[0])
    monkeypatch.setattr(config_cache.random, "random", lambda: 0.5)
    manager = config_cache.WeixinConfigManager({"bot_token": "synthetic-token"})

    first = await manager.get_for_user("wx-user", "context-789")
    cached = await manager.get_for_user("wx-user", "context-789")
    assert first["typing_ticket"] == cached["typing_ticket"] == "ticket-1"
    assert clients[0].calls == 1

    now[0] = first["next_fetch_at"] + 1
    stale = await manager.get_for_user("wx-user", "context-789")
    assert stale["typing_ticket"] == "ticket-1"
    assert stale["retry_delay_ms"] == 4_000
    now[0] += 3_999
    assert (await manager.get_for_user("wx-user", "context-789"))["typing_ticket"] == "ticket-1"
    assert clients[0].calls == 2

    await manager.close()
    assert clients[0].stopped is True


@pytest.mark.parametrize("payload", [b"", b"a" * 15, b"b" * 16, b"c" * 17])
def test_wechat_media_crypto_round_trips_and_encodes_protocol_aes_key(payload):
    key, ciphertext, padded_size = media_crypto.encrypt_for_upload(payload)

    assert len(key) == 16
    assert len(ciphertext) == padded_size
    assert padded_size == media_crypto.aes_ecb_padded_size(len(payload))
    assert media_crypto.decrypt_aes_ecb(ciphertext, key) == payload
    assert base64.b64decode(media_crypto.aeskey_to_b64(key)).decode("ascii") == key.hex()


@pytest.mark.asyncio
async def test_wechat_typing_sends_on_and_off_around_indicator_lifecycle():
    statuses = []
    started = asyncio.Event()

    async def send_typing(status):
        statuses.append(status)
        if status == client.TYPING_ON:
            started.set()

    indicator = typing.TypingIndicator(send_typing, keepalive_s=3_600)
    await indicator.start()
    await asyncio.wait_for(started.wait(), timeout=1)
    await indicator.stop()

    assert statuses == [client.TYPING_ON, client.TYPING_OFF]
    assert indicator.is_running is False


@pytest.mark.asyncio
async def test_wechat_long_poll_stops_client_when_task_is_cancelled(monkeypatch):
    started = asyncio.Event()
    stopped = asyncio.Event()

    class BlockingClient:
        def __init__(self, *_args):
            pass

        async def start(self):
            started.set()

        async def getupdates(self, _cursor):
            await asyncio.Event().wait()

        async def stop(self):
            stopped.set()

    monkeypatch.setattr(runtime, "ILinkClient", BlockingClient)
    task = asyncio.create_task(runtime._serve_async("bot-1", "owner-1", "synthetic-token", "https://example.test"))
    await asyncio.wait_for(started.wait(), timeout=1)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert stopped.is_set()


def test_wechat_gateway_config_cache_uses_injected_environment_values(monkeypatch):
    seen = []

    class FakeManager:
        def __init__(self, config, *, log):
            seen.append((config, log))

    monkeypatch.setattr(runtime, "WeixinConfigManager", FakeManager)
    monkeypatch.setenv("WECHAT_BOT_TOKEN", "synthetic-token")
    monkeypatch.setenv("WECHAT_BASE_URL", "https://example.test/custom")
    runtime._config_managers.pop("synthetic-bot", None)

    try:
        manager = runtime._get_config_manager("synthetic-bot")
        assert isinstance(manager, FakeManager)
        assert seen[0][0] == {
            "bot_token": "synthetic-token",
            "base_url": "https://example.test/custom",
        }
    finally:
        runtime._config_managers.pop("synthetic-bot", None)
