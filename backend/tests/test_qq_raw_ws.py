from agent.gateway import qq


def test_qq_heartbeat_ack_timeout_after_two_and_a_half_intervals():
    assert not qq._heartbeat_ack_expired(last_ack_at=100.0, interval=45.0, now=212.4)
    assert qq._heartbeat_ack_expired(last_ack_at=100.0, interval=45.0, now=212.5)


def test_qq_split_face_pending_is_fifo():
    from agent.im.parsers.qq import (
        _pending_qq_face_ids,
        _pending_qq_faces,
        _pop_pending_qq_face,
        _queue_pending_qq_face,
    )

    key = "test-qq-face-fifo"
    _pending_qq_faces.pop(key, None)
    _pending_qq_face_ids.pop(key, None)
    _queue_pending_qq_face(key, [{"face_type": "6", "face_id": "first"}], 10.0)
    _queue_pending_qq_face(key, [{"face_type": "6", "face_id": "second"}], 10.1)

    assert _pop_pending_qq_face(key, 10.2)[0]["face_id"] == "first"
    assert _pop_pending_qq_face(key, 10.3)[0]["face_id"] == "second"


def _raw_c2c_event(**overrides):
    data = {
        "id": "msg-1",
        "content": "现在呢",
        "author": {"user_openid": "ou_1"},
        "attachments": [],
        "message_scene": {"ext": ["msg_idx=2", "ref_msg_idx=1"]},
        "msg_elements": [
            {"msg_idx": "1", "msg_id": "old", "content": "之前那句", "attachments": []},
            {"msg_idx": "2", "msg_id": "msg-1", "content": "现在呢", "attachments": []},
        ],
    }
    data.update(overrides)
    return data


def _raw_group_event(**overrides):
    data = _raw_c2c_event(
        author={"member_openid": "member_1"},
        group_openid="group_1",
    )
    data.update(overrides)
    return data


def test_qq_group_sender_prefers_user_openid_for_owner_binding(monkeypatch):
    """群事件同时带两种 ID 时，必须沿用 C2C 绑定使用的 user_openid。"""
    from agent.im.models import PlatformMessage

    payload = {
        "platform": "qq",
        "chat_type": "group",
        "chat_id": "group-1",
        "author": {"user_openid": "owner-openid", "member_openid": "member-openid"},
    }
    message = PlatformMessage.from_payload(payload)
    assert message.sender.id == "owner-openid"


def test_qq_message_mentions_bot_uses_at_event_and_payload_fallback():
    assert qq._qq_message_mentions_bot(
        {"mentions": [{"bot": True}]}, "GROUP_AT_MESSAGE_CREATE"
    ) is True
    assert qq._qq_message_mentions_bot(
        {"mentions": []}, "GROUP_AT_MESSAGE_CREATE"
    ) is True


def test_qq_face_marker_is_normalized_without_protocol_text():
    marker = '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">'
    assert qq._contains_qq_face(marker)
    assert qq._normalize_qq_faces(marker) == "[QQ表情]"


def test_qq_face_probe_extracts_reusable_identity_without_decoding_payload():
    marker = '<faceType=6,faceId="same-face",ext="opaque">'
    assert qq._extract_qq_faces(marker) == [{
        "face_type": "6",
        "face_id": "same-face",
    }]


def test_qq_face_probe_extracts_multiple_faces_in_protocol_order():
    text = (
        '<faceType=6,faceId="first",ext="a">'
        '<faceType=4,faceId="second",ext="b">'
    )
    assert [item["face_id"] for item in qq._extract_qq_faces(text)] == ["first", "second"]


def test_qq_face_marker_is_normalized_without_leaking_protocol_text():
    import base64
    import json

    ext = base64.b64encode(json.dumps({"text": ""}).encode()).decode()
    assert qq._normalize_qq_faces(
        f"看这个 <faceType=4,faceId=\"\",ext=\"{ext}\">"
    ) == "看这个 [QQ表情]"


def test_qq_face_marker_uses_text_from_extension_when_available():
    import base64
    import json

    ext = base64.b64encode(json.dumps({"text": "😀"}).encode()).decode()
    assert qq._normalize_qq_faces(
        f"<faceType=4,faceId=\"\",ext=\"{ext}\">"
    ) == "😀"


def test_qq_bot_mention_id_uses_explicit_bot_mention():
    from agent.gateway.qq import _qq_bot_mention_id

    data = {
        "content": "<@D5A139> 看看这个",
        "mentions": [{"id": "D5A139", "bot": True}],
    }
    assert _qq_bot_mention_id(data, "GROUP_MESSAGE_CREATE") == "D5A139"


def test_qq_bot_mention_id_does_not_guess_unknown_mentions():
    from agent.gateway.qq import _qq_bot_mention_id

    data = {
        "content": "<@member-1> 看看这个",
        "mentions": [{"id": "member-1", "bot": False}],
    }
    assert _qq_bot_mention_id(data, "GROUP_MESSAGE_CREATE") == ""


def test_qq_bot_mention_id_falls_back_only_for_at_event():
    from agent.gateway.qq import _qq_bot_mention_id

    data = {"content": "<@D5A139> 看看这个"}
    assert _qq_bot_mention_id(data, "GROUP_AT_MESSAGE_CREATE") == "D5A139"


def test_qq_mention_display_uses_username_without_changing_identity_fields():
    from agent.im.models import replace_mention_ids

    text = replace_mention_ids(
        "<@D5A139> 看来未来得继续做。",
        {"D5A139": "Coffeiz"},
    )

    assert text == "@Coffeiz 看来未来得继续做。"


def test_platform_mention_display_keeps_unknown_ids():
    from agent.im.models import replace_mention_ids

    assert replace_mention_ids("@known <@unknown>", {"known": "Coffeiz"}) == "@Coffeiz <@unknown>"


async def test_qq_group_at_event_without_mentions_reaches_agent(monkeypatch):
    produced: list[dict] = []

    async def fake_group_settings(_bot_id):
        return True, True, True

    async def fake_produce(_stream, payload):
        produced.append(payload)

    monkeypatch.setattr(qq, "_group_settings", fake_group_settings)
    monkeypatch.setattr(qq.R, "produce", fake_produce)

    # 跟本文件其它测试一样 mock 掉 decide_im_shortcut 的底层依赖：不 mock 会真的连 Redis
    # 查取消状态——单独跑这个测试时全局 Redis 客户端在本测试的事件循环里首次建立，能用；
    # 跟其他测试一起跑，客户端已经绑在前一个测试的（已关闭）事件循环上，会报
    # Event loop is closed。这不是偶发，是这个测试本身当初漏了这三行 mock。
    from agent import router
    from agent.runtime import runtime_state

    async def fake_async_false(*args, **kwargs):
        return False

    async def fake_async_none(*args, **kwargs):
        return None

    monkeypatch.setattr(router, "decide", lambda *args, **kwargs: {"action": "run"})
    monkeypatch.setattr(runtime_state, "get_state", fake_async_none)
    monkeypatch.setattr(runtime_state, "is_awaiting", fake_async_false)

    await qq._handle_raw_qq_message(
        "GROUP_AT_MESSAGE_CREATE",
        _raw_group_event(mentions=[]),
        "bot-1",
        "user-1",
        {},
    )

    assert len(produced) == 1
    assert produced[0]["group_mentioned"] is True


def test_qq_extracts_quoted_text_by_ref_msg_idx():
    text, attachments = qq._extract_quoted(_raw_c2c_event())

    assert text == "之前那句"
    assert attachments == []


def test_qq_extracts_quoted_text_with_numeric_msg_idx():
    data = _raw_c2c_event(
        msg_elements=[
            {"msg_idx": 1, "msg_id": "old", "text": "数字索引引用", "attachments": []},
            {"msg_idx": 2, "msg_id": "msg-1", "content": "现在呢", "attachments": []},
        ],
    )

    text, attachments = qq._extract_quoted(data)

    assert text == "数字索引引用"
    assert attachments == []


def test_qq_extracts_quoted_text_with_dict_ext():
    data = _raw_c2c_event(
        message_scene={"ext": [{"key": "msg_idx", "value": 2}, {"key": "ref_msg_idx", "value": 1}]},
        msg_elements=[
            {"msg_idx": 1, "msg_id": "old", "content": "字典扩展引用", "attachments": []},
            {"msg_idx": 2, "msg_id": "msg-1", "content": "现在呢", "attachments": []},
        ],
    )

    text, attachments = qq._extract_quoted(data)

    assert text == "字典扩展引用"
    assert attachments == []


def test_qq_extracts_quoted_image_from_nested_element():
    data = _raw_c2c_event(
        msg_elements=[
            {
                "msg_idx": "1",
                "msg_id": "old",
                "content": "",
                "image": {
                    "image_url": "https://example.test/quoted.jpg",
                    "file_name": "quoted.jpg",
                    "content_type": "image/jpeg",
                },
            },
            {"msg_idx": "2", "msg_id": "msg-1", "content": "看看图", "attachments": []},
        ],
    )

    text, attachments = qq._extract_quoted(data)

    assert text == ""
    assert attachments == [{
        "url": "https://example.test/quoted.jpg",
        "filename": "quoted.jpg",
        "content_type": "image/jpeg",
    }]


def test_qq_extract_quoted_returns_empty_without_ref_msg_idx():
    data = _raw_c2c_event(message_scene={"ext": ["msg_idx=2"]})

    text, attachments = qq._extract_quoted(data)

    assert text == ""
    assert attachments == []


async def test_qq_raw_c2c_event_to_payload(monkeypatch):
    produced: list[dict] = []

    async def fake_produce(stream, payload):
        produced.append(payload)

    monkeypatch.setattr(qq.R, "produce", fake_produce)

    from agent import router
    from agent.runtime import runtime_state

    async def fake_async_false(*args, **kwargs):
        return False

    async def fake_async_none(*args, **kwargs):
        return None

    monkeypatch.setattr(router, "decide", lambda *args, **kwargs: {"action": "run"})
    monkeypatch.setattr(runtime_state, "get_state", fake_async_none)
    monkeypatch.setattr(runtime_state, "is_awaiting", fake_async_false)

    await qq._handle_raw_qq_message("C2C_MESSAGE_CREATE", _raw_c2c_event(), "bot-1", "user-1", {})

    assert len(produced) == 1
    assert produced[0]["platform"] == "qq"
    assert produced[0]["platform_user_id"] == "ou_1"
    assert produced[0]["chat_type"] == "c2c"
    assert produced[0]["text"] == "现在呢"
    assert produced[0]["quoted_text"] == "之前那句"


async def test_qq_message_still_reaches_stream_when_shortcut_redis_fails(monkeypatch):
    produced: list[dict] = []

    async def fake_produce(_stream, payload):
        produced.append(payload)

    async def fail_state(*_args, **_kwargs):
        raise RuntimeError("redis unavailable")

    monkeypatch.setattr(qq.R, "produce", fake_produce)
    monkeypatch.setattr("agent.runtime.runtime_state.get_state", fail_state)

    await qq._handle_raw_qq_message(
        "C2C_MESSAGE_CREATE",
        _raw_c2c_event(),
        "bot-1",
        "user-1",
        {},
    )

    assert len(produced) == 1
    assert produced[0]["platform"] == "qq"


async def test_qq_raw_group_event_to_payload(monkeypatch):
    produced: list[dict] = []

    async def fake_group_settings(bot_id):
        return True, True

    async def fake_produce(stream, payload):
        produced.append(payload)

    monkeypatch.setattr(qq, "_group_settings", fake_group_settings)
    monkeypatch.setattr(qq.R, "produce", fake_produce)

    from agent import router
    from agent.runtime import runtime_state

    async def fake_async_false(*args, **kwargs):
        return False

    async def fake_async_none(*args, **kwargs):
        return None

    monkeypatch.setattr(router, "decide", lambda *args, **kwargs: {"action": "run"})
    monkeypatch.setattr(runtime_state, "get_state", fake_async_none)
    monkeypatch.setattr(runtime_state, "is_awaiting", fake_async_false)

    await qq._handle_raw_qq_message("GROUP_AT_MESSAGE_CREATE", _raw_group_event(), "bot-1", "user-1", {})

    assert len(produced) == 1
    assert produced[0]["platform_user_id"] == "member_1"
    assert produced[0]["chat_id"] == "group_1"
    assert produced[0]["chat_type"] == "group"


async def test_qq_raw_group_disabled_drops_event(monkeypatch):
    produced: list[dict] = []

    async def fake_group_settings(bot_id):
        return False, True

    async def fake_produce(stream, payload):
        produced.append(payload)

    monkeypatch.setattr(qq, "_group_settings", fake_group_settings)
    monkeypatch.setattr(qq.R, "produce", fake_produce)

    await qq._handle_raw_qq_message("GROUP_AT_MESSAGE_CREATE", _raw_group_event(), "bot-1", "user-1", {})

    assert produced == []


async def test_qq_raw_group_message_create_respects_requires_at(monkeypatch):
    produced: list[dict] = []

    async def fake_group_settings(bot_id):
        return True, False

    async def fake_produce(stream, payload):
        produced.append(payload)

    monkeypatch.setattr(qq, "_group_settings", fake_group_settings)
    monkeypatch.setattr(qq.R, "produce", fake_produce)

    from agent import router
    from agent.runtime import runtime_state

    async def fake_async_false(*args, **kwargs):
        return False

    async def fake_async_none(*args, **kwargs):
        return None

    monkeypatch.setattr(router, "decide", lambda *args, **kwargs: {"action": "run"})
    monkeypatch.setattr(runtime_state, "get_state", fake_async_none)
    monkeypatch.setattr(runtime_state, "is_awaiting", fake_async_false)

    await qq._handle_raw_qq_message("GROUP_MESSAGE_CREATE", _raw_group_event(), "bot-1", "user-1", {})

    assert len(produced) == 1
    assert produced[0]["chat_type"] == "group"
    assert produced[0]["chat_id"] == "group_1"


async def test_qq_raw_group_message_create_is_received_when_at_is_required(monkeypatch):
    produced: list[dict] = []

    async def fake_group_settings(bot_id):
        return True, True

    async def fake_produce(stream, payload):
        produced.append(payload)

    monkeypatch.setattr(qq, "_group_settings", fake_group_settings)
    monkeypatch.setattr(qq.R, "produce", fake_produce)

    await qq._handle_raw_qq_message("GROUP_MESSAGE_CREATE", _raw_group_event(), "bot-1", "user-1", {})

    assert len(produced) == 1
    assert produced[0]["group_requires_at"] is True
    assert produced[0]["group_mentioned"] is False


async def test_qq_raw_quoted_attachment_is_ingested(monkeypatch):
    produced: list[dict] = []
    data = _raw_c2c_event(
        msg_elements=[
            {
                "msg_idx": "1",
                "msg_id": "old",
                "content": "",
                "attachments": [{"url": "https://example.test/a.png", "filename": "a.png"}],
            },
            {"msg_idx": "2", "msg_id": "msg-1", "content": "看看图", "attachments": []},
        ],
    )

    async def fake_ack(*args, **kwargs):
        return None

    async def fake_produce(stream, payload):
        produced.append(payload)

    monkeypatch.setattr(qq, "_qq_ack", fake_ack)
    monkeypatch.setattr(qq.R, "produce", fake_produce)

    from agent import router
    from agent.runtime import runtime_state

    async def fake_async_false(*args, **kwargs):
        return False

    async def fake_async_none(*args, **kwargs):
        return None

    monkeypatch.setattr(router, "decide", lambda *args, **kwargs: {"action": "run"})
    monkeypatch.setattr(runtime_state, "get_state", fake_async_none)
    monkeypatch.setattr(runtime_state, "is_awaiting", fake_async_false)

    await qq._handle_raw_qq_message("C2C_MESSAGE_CREATE", data, "bot-1", "user-1", {})

    assert produced[0]["attachments"][0]["url"] == "https://example.test/a.png"
