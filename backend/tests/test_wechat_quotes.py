from types import SimpleNamespace

import httpx

from agent.adapters import wechat


def _wechat_text_msg(**overrides):
    msg = {
        "message_type": 1,
        "from_user_id": "wx_user_1",
        "context_token": "ctx_1",
        "group_id": "",
        "item_list": [
            {
                "type": 1,
                "text_item": {"text": "现在能看到吗"},
            },
        ],
    }
    msg.update(overrides)
    return msg


def test_wechat_extracts_quoted_image_item():
    quoted_text, quoted_items = wechat._extract_quoted(
        {
            "message_item": {
                "type": 2,
                "image_item": {
                    "aeskey": "00112233445566778899aabbccddeeff",
                    "media": {"full_url": "https://example.test/q.jpg"},
                },
            },
        }
    )

    assert quoted_text == "[图片消息]"
    assert quoted_items == [{
        "type": 2,
        "image_item": {
            "aeskey": "00112233445566778899aabbccddeeff",
            "media": {"full_url": "https://example.test/q.jpg"},
        },
    }]


def test_wechat_media_url_prefers_full_url():
    assert wechat._wechat_media_url({"full_url": "https://example.test/a.jpg",
                                     "encrypt_query_param": "should-not-be-used"}) \
        == "https://example.test/a.jpg"


def test_wechat_media_url_falls_back_to_encrypt_query_param():
    # 引用/回复里带的图片没有 full_url，只有 encrypt_query_param——之前只认 full_url，
    # 导致引用图片一律因为「缺 full_url」被跳过下载，这是本次要修的根因。
    url = wechat._wechat_media_url({"encrypt_query_param": "abc/def+123="})

    assert url == ("https://novac2c.cdn.weixin.qq.com/c2c/download"
                   "?encrypted_query_param=abc%2Fdef%2B123%3D")


def test_wechat_media_url_empty_when_neither_present():
    assert wechat._wechat_media_url({}) == ""


async def test_wechat_ingest_media_uses_encrypt_query_param_download_url(monkeypatch):
    captured_urls = []

    class _FakeResp:
        content = b"\xff\xd8\xff fake jpeg bytes"

    class _FakeClient:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def get(self, url, **kwargs):
            captured_urls.append(url)
            return _FakeResp()

    async def fake_stage(owner, name, ext, mime, data, **kwargs):
        return {"attach_id": "att_1"}

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _FakeClient())
    monkeypatch.setattr(wechat, "_aes128_ecb_decrypt", lambda raw, key: b"decrypted")
    import app.core.chat_attach as chat_attach
    monkeypatch.setattr(chat_attach, "stage", fake_stage)

    out = await wechat._ingest_wechat_media([{
        "type": 2,
        "image_item": {
            "aeskey": "00112233445566778899aabbccddeeff",
            "media": {"encrypt_query_param": "xyz123"},
        },
    }], "owner_1")

    assert out == ["att_1"]
    assert captured_urls == [
        "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=xyz123",
    ]


async def test_wechat_quoted_image_is_ingested_and_enqueued(monkeypatch):
    seen_items = []
    produced = []

    msg = _wechat_text_msg(
        item_list=[
            {
                "type": 1,
                "text_item": {"text": "现在能看到吗"},
                "ref_msg": {
                    "message_item": {
                        "type": 2,
                        "image_item": {
                            "aeskey": "00112233445566778899aabbccddeeff",
                            "media": {"full_url": "https://example.test/q.jpg"},
                        },
                    },
                },
            },
        ],
    )

    class _FakeConfigManager:
        async def get_for_user(self, from_user, context_token):
            assert from_user == "wx_user_1"
            assert context_token == "ctx_1"
            return {"typing_ticket": "ticket_1"}

    async def fake_send_text(*args, **kwargs):
        return None

    async def fake_ingest(items, owner):
        seen_items.extend(items)
        assert owner == "owner_1"
        return ["att_quote_1"]

    async def fake_produce(stream, payload):
        produced.append(payload)

    monkeypatch.setattr(wechat, "_get_config_manager", lambda channel_id: _FakeConfigManager())
    monkeypatch.setattr(wechat, "_ingest_wechat_media", fake_ingest)
    monkeypatch.setattr(wechat.R, "produce", fake_produce)

    client = SimpleNamespace(send_text=fake_send_text)
    await wechat._handle_msg(msg, "wechat_bot_1", "owner_1", client)

    assert seen_items == [{
        "type": 2,
        "image_item": {
            "aeskey": "00112233445566778899aabbccddeeff",
            "media": {"full_url": "https://example.test/q.jpg"},
        },
    }]
    assert len(produced) == 1
    assert produced[0]["platform"] == "wechat"
    assert produced[0]["channel_id"] == "wechat_bot_1"
    assert produced[0]["owner_user_id"] == "owner_1"
    assert produced[0]["platform_user_id"] == "wx_user_1"
    assert produced[0]["message_id"] == "ctx_1"
    assert produced[0]["chat_type"] == "c2c"
    assert produced[0]["wechat_group_id"] == ""
    assert produced[0]["context_token"] == "ctx_1"
    assert produced[0]["text"] == "现在能看到吗"
    assert produced[0]["quoted_text"] == "[图片消息]"
    assert produced[0]["attachments"] == ["att_quote_1"]
    assert produced[0]["typing_ticket"] == "ticket_1"
    assert produced[0]["trace_id"]
