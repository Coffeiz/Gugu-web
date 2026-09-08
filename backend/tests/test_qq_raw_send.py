from agent.gateway import qq


def test_qq_identify_subscribes_to_interaction_events():
    assert qq._INTENTS & qq._INTENT_GROUP_AND_C2C
    assert qq._INTENTS & qq._INTENT_PUBLIC_GUILD_MESSAGES
    assert qq._INTENTS & qq._INTENT_DIRECT_MESSAGE
    assert qq._INTENTS & qq._INTENT_INTERACTION


async def test_ack_qq_interaction_uses_official_callback_endpoint(monkeypatch):
    calls = []

    async def fake_request(channel_id, method, path, json_body=None, **kw):
        calls.append((channel_id, method, path, json_body))
        return None

    monkeypatch.setattr(qq, "_qq_request", fake_request)

    assert await qq._ack_qq_interaction("bot-1", "interaction-42") is True
    assert calls == [("bot-1", "PUT", "/interactions/interaction-42", {"code": 0})]

    calls.clear()
    assert await qq._ack_qq_interaction("bot-1", "interaction-42", code=3) is True
    assert calls == [("bot-1", "PUT", "/interactions/interaction-42", {"code": 3})]


async def test_ack_qq_interaction_without_id_is_noop(monkeypatch):
    async def fail_request(*args, **kwargs):
        raise AssertionError("不应调用 QQ API")

    monkeypatch.setattr(qq, "_qq_request", fail_request)
    assert await qq._ack_qq_interaction("bot-1", "") is False


async def test_stale_group_interaction_is_acknowledged_in_original_group(monkeypatch):
    """Web 端先消费后，群里残留按钮再次点击不能把过期提示发到私聊。"""
    import app.db.session as db_session
    from app.services import interactions

    class _SessionContext:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_args):
            return False

    class _SessionFactory:
        def __call__(self):
            return _SessionContext()

    async def stale_action(*_args, **_kwargs):
        raise ValueError("动作无效或已使用")

    protocol_acks = []
    user_replies = []

    async def fake_protocol_ack(channel_id, interaction_id, *, code=0):
        protocol_acks.append((channel_id, interaction_id, code))
        return True

    async def fake_qq_ack(channel_id, chat_type, target_id, text, msg_id):
        user_replies.append((channel_id, chat_type, target_id, text, msg_id))

    monkeypatch.setattr(db_session, "_SessionLocal", _SessionFactory())
    monkeypatch.setattr(interactions, "consume_action", stale_action)
    monkeypatch.setattr(qq, "_ack_qq_interaction", fake_protocol_ack)
    monkeypatch.setattr(qq, "_qq_ack", fake_qq_ack)

    await qq._handle_qq_interaction({
        "id": "interaction-1",
        "user_openid": "user-1",
        "group_openid": "group-1",
        "data": {"action_data": "17:opaque-token"},
    }, "bot-1", "019eec39-4f5e-73cf-817d-60c0e0b640a8")

    assert protocol_acks == [("bot-1", "interaction-1", 3)]
    assert user_replies == [(
        "bot-1", "group", "group-1", "这个操作已过期或已经处理过了。", None,
    )]


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
    assert button["action"]["click_limit"] == 1
    assert button["group_id"] == "gugu-prompt-17"
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


async def test_post_removes_web_only_gugu_links_for_qq(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_request(channel_id, method, path, json_body=None, **kw):
        calls.append(json_body)

    monkeypatch.setattr(qq, "_qq_request", fake_request)

    await qq._post(
        "bot-1", "ou_1", "文件已保存：[打开文件](gugu://open-file/123)", "msg-1", "smart"
    )

    assert calls[0]["msg_type"] == 0
    assert calls[0]["content"] == "文件已保存：打开文件"
    assert "gugu://" not in str(calls[0])


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


async def test_send_group_file_falls_back_to_active_message_when_msg_id_expired(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_request(channel_id, method, path, json_body=None, **kw):
        calls.append((path, json_body))
        if path.endswith("/files"):
            return {"file_info": "group-media-token"}
        if json_body.get("msg_id"):
            raise qq.QQAPIError(
                "POST", path, 400,
                {"code": 40034031, "message": "msgid已经过期,不能回复"},
            )
        return {}

    monkeypatch.setattr(qq, "_qq_request", fake_request)

    ok = await qq.send_file(
        "group-1", b"document-bytes", "report", "pdf", "bot-1", "expired-msg", group=True,
    )

    assert ok is True
    assert len(calls) == 3
    assert calls[0][0] == "/v2/groups/group-1/files"
    assert calls[1][1]["msg_id"] == "expired-msg"
    assert "msg_id" not in calls[2][1]
    assert calls[2][1]["media"] == {"file_info": "group-media-token"}
