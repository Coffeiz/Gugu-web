from agent.gateway import qq


async def _fake_next_seq(msg_id):
    return 1


async def test_post_sends_markdown(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_request(channel_id, method, path, json_body=None, **kw):
        calls.append((channel_id, method, path, json_body))

    monkeypatch.setattr(qq, "_qq_request", fake_request)

    await qq._post("bot-1", "ou_1", "你好", "msg-1")

    assert len(calls) == 1
    channel_id, method, path, body = calls[0]
    assert path == "/v2/users/ou_1/messages"
    assert body["msg_type"] == 2
    assert body["markdown"] == {"content": "你好"}


async def test_post_keyboard_builds_inline_keyboard_with_opaque_action(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_request(channel_id, method, path, json_body=None, **kw):
        calls.append((path, json_body))

    monkeypatch.setattr(qq, "_qq_request", fake_request)

    await qq._post_keyboard(
        "bot-1", "ou_1", "请选择", "msg-1", group=False,
        prompt={
            "prompt_id": 17,
            "platform_user_id": "ou_1",
            "options": [{"id": "yes", "label": "确认", "token": "opaque-token"}],
        },
    )

    path, body = calls[0]
    assert path == "/v2/users/ou_1/messages"
    assert body["msg_type"] == 2
    assert body["markdown"] == {"content": "请选择"}
    button = body["keyboard"]["content"]["rows"][0]["buttons"][0]
    assert button["action"]["type"] == 1
    assert button["action"]["data"] == "17:opaque-token"
    assert button["action"]["permission"] == {"type": 2}
    assert "session_id" not in repr(body)


async def test_post_keyboard_uses_markdown_with_keyboard(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_request(channel_id, method, path, json_body=None, **kw):
        calls.append(json_body)

    monkeypatch.setattr(qq, "_qq_request", fake_request)
    await qq._post_keyboard(
        "bot-1", "ou_1", "请选择", "msg-1", group=False,
        prompt={"prompt_id": 17, "options": [{"id": "yes", "label": "确认", "token": "t"}]},
        message_format="smart",
    )

    assert calls[0]["msg_type"] == 2
    assert calls[0]["markdown"] == {"content": "请选择"}
    assert "content" not in calls[0]


async def test_post_compat_mode_sends_plain_text(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_request(channel_id, method, path, json_body=None, **kw):
        calls.append(json_body)

    monkeypatch.setattr(qq, "_qq_request", fake_request)

    await qq._post("bot-1", "ou_1", "**不要渲染**", "msg-1", "compat")

    assert calls == [{
        "msg_type": 0,
        "content": "**不要渲染**",
        "msg_seq": 1,
        "msg_id": "msg-1",
    }]


async def test_post_smart_mode_only_uses_markdown_for_markdown_content(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_request(channel_id, method, path, json_body=None, **kw):
        calls.append(json_body)

    monkeypatch.setattr(qq, "_qq_request", fake_request)

    await qq._post("bot-1", "ou_1", "普通文本", "msg-1", "smart")
    await qq._post("bot-1", "ou_1", "**加粗**", "msg-2", "smart")

    assert calls[0]["msg_type"] == 0
    assert calls[0]["content"] == "普通文本"
    assert calls[1]["msg_type"] == 2
    assert calls[1]["markdown"] == {"content": "**加粗**"}


async def test_post_falls_back_to_plain_text_when_markdown_blocked(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_request(channel_id, method, path, json_body=None, **kw):
        calls.append(json_body)
        if json_body["msg_type"] == 2:
            raise RuntimeError("QQ API 失败 status=400 data={'code': 50056, 'message': 'no md perm'}")

    monkeypatch.setattr(qq, "_qq_request", fake_request)

    await qq._post("bot-1", "ou_1", "你好", "msg-1")

    assert len(calls) == 2
    assert calls[0]["msg_type"] == 2
    assert calls[1]["msg_type"] == 0
    assert calls[1]["content"] == "你好"


async def test_post_reraises_non_markdown_errors(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)

    async def fake_request(channel_id, method, path, json_body=None, **kw):
        raise RuntimeError("QQ API 失败 status=500 data={'message': 'boom'}")

    monkeypatch.setattr(qq, "_qq_request", fake_request)

    try:
        await qq._post("bot-1", "ou_1", "你好", "msg-1")
        assert False, "should have raised"
    except RuntimeError as e:
        assert "boom" in str(e)


async def test_send_c2c_clears_token_cache_and_retries_on_failure(monkeypatch):
    qq._send_tokens["bot-1"] = {"token": "stale", "base": "x", "expires_at": 0}
    attempts = []

    async def fake_post(channel_id, openid, text, msg_id):
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("status=401")
        return None

    monkeypatch.setattr(qq, "_post", fake_post)

    ok = await qq.send_c2c("ou_1", "hi", "msg-1", "bot-1")

    assert ok is True
    assert len(attempts) == 2
    assert "bot-1" not in qq._send_tokens


async def test_send_token_uses_cache_until_expiry(monkeypatch):
    qq._send_tokens.clear()
    fetch_count = 0

    async def fake_creds(channel_id):
        return "app-1", "secret-1", False

    async def fake_token_ttl(app_id, secret):
        nonlocal fetch_count
        fetch_count += 1
        return "tok", 7200

    monkeypatch.setattr(qq, "_creds_by_id", fake_creds)
    monkeypatch.setattr(qq, "_qq_access_token_with_ttl", fake_token_ttl)

    token1, base1 = await qq._send_token("bot-2")
    token2, base2 = await qq._send_token("bot-2")

    assert token1 == token2 == "tok"
    assert fetch_count == 1


async def test_send_file_base64_mode_uploads_then_sends_media(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_request(channel_id, method, path, json_body=None, **kw):
        calls.append((path, json_body))
        if path.endswith("/files"):
            return {"file_info": "media-token-abc"}
        return {}

    monkeypatch.setattr(qq, "_qq_request", fake_request)

    ok = await qq.send_file("ou_1", b"image-bytes", "photo", "png", "bot-1", "msg-1")

    assert ok is True
    assert calls[0][0] == "/v2/users/ou_1/files"
    assert calls[0][1]["file_data"] == "aW1hZ2UtYnl0ZXM="
    assert calls[1][0] == "/v2/users/ou_1/messages"
    assert calls[1][1]["media"] == {"file_info": "media-token-abc"}
    assert calls[1][1]["msg_type"] == 7


async def test_send_group_file_uses_group_media_endpoints(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_request(channel_id, method, path, json_body=None, **kw):
        calls.append((path, json_body))
        if path.endswith("/files"):
            return {"file_info": "group-media-token"}
        return {}

    monkeypatch.setattr(qq, "_qq_request", fake_request)

    ok = await qq.send_file(
        "group-1", b"image-bytes", "photo", "png", "bot-1", "msg-1", group=True,
    )

    assert ok is True
    assert calls[0][0] == "/v2/groups/group-1/files"
    assert calls[0][1]["file_data"] == "aW1hZ2UtYnl0ZXM="
    assert calls[1][0] == "/v2/groups/group-1/messages"
    assert calls[1][1]["media"] == {"file_info": "group-media-token"}
