from agent.adapters import qq


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

    async def fake_ingest(message, owner):
        return []

    async def fake_produce(stream, payload):
        produced.append(payload)

    monkeypatch.setattr(qq, "_ingest_qq_media", fake_ingest)
    monkeypatch.setattr(qq.R, "produce", fake_produce)

    from agent import router, runtime_state

    async def fake_async_false(*args, **kwargs):
        return False

    async def fake_async_none(*args, **kwargs):
        return None

    monkeypatch.setattr(router, "decide", lambda *args, **kwargs: {"action": "run"})
    monkeypatch.setattr(runtime_state, "get_state", fake_async_none)
    monkeypatch.setattr(runtime_state, "is_awaiting", fake_async_false)

    await qq._handle_raw_qq_message("C2C_MESSAGE_CREATE", _raw_c2c_event(), "bot-1", "user-1", {})

    assert len(produced) == 1
    assert produced[0]["platform"] == "qqbot"
    assert produced[0]["platform_user_id"] == "ou_1"
    assert produced[0]["chat_type"] == "c2c"
    assert produced[0]["text"] == "现在呢"
    assert produced[0]["quoted_text"] == "之前那句"


async def test_qq_raw_group_event_to_payload(monkeypatch):
    produced: list[dict] = []

    async def fake_group_settings(bot_id):
        return True, True

    async def fake_ingest(message, owner):
        return []

    async def fake_produce(stream, payload):
        produced.append(payload)

    monkeypatch.setattr(qq, "_group_settings", fake_group_settings)
    monkeypatch.setattr(qq, "_ingest_qq_media", fake_ingest)
    monkeypatch.setattr(qq.R, "produce", fake_produce)

    from agent import router, runtime_state

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


async def test_qq_raw_quoted_attachment_is_ingested(monkeypatch):
    seen_filenames: list[str] = []
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

    async def fake_ingest(message, owner):
        seen_filenames.extend(a.filename for a in message.attachments)
        return ["att_1"]

    async def fake_produce(stream, payload):
        produced.append(payload)

    monkeypatch.setattr(qq, "_qq_ack", fake_ack)
    monkeypatch.setattr(qq, "_ingest_qq_media", fake_ingest)
    monkeypatch.setattr(qq.R, "produce", fake_produce)

    from agent import router, runtime_state

    async def fake_async_false(*args, **kwargs):
        return False

    async def fake_async_none(*args, **kwargs):
        return None

    monkeypatch.setattr(router, "decide", lambda *args, **kwargs: {"action": "run"})
    monkeypatch.setattr(runtime_state, "get_state", fake_async_none)
    monkeypatch.setattr(runtime_state, "is_awaiting", fake_async_false)

    await qq._handle_raw_qq_message("C2C_MESSAGE_CREATE", data, "bot-1", "user-1", {})

    assert seen_filenames == ["a.png"]
    assert produced[0]["attachments"] == ["att_1"]
