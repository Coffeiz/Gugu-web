import pytest


@pytest.mark.asyncio
async def test_qq_stream_timer_cancel_does_not_cancel_inflight_flush(monkeypatch):
    """finish 取消节流任务时，已开始的刷新仍必须完成，避免卡在生成中。"""
    import asyncio

    from agent.gateway import qq

    stream = qq.QQPrivateTextStream("bot-1", "user-1", message_id=None, message_format=None)
    original_sleep = asyncio.sleep
    started = asyncio.Event()
    release = asyncio.Event()
    completed = asyncio.Event()
    calls = []

    async def fake_sleep(_delay):
        return None

    async def fake_flush(*_args, **_kwargs):
        calls.append("started")
        started.set()
        await release.wait()
        completed.set()

    monkeypatch.setattr(qq.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(stream, "_flush", fake_flush)
    timer = asyncio.create_task(stream._delayed_flush())
    stream._timer = timer
    await started.wait()
    timer.cancel()
    with pytest.raises(asyncio.CancelledError):
        await timer
    release.set()
    # shield 创建的刷新任务仍在运行，且最终能够正常完成。
    await asyncio.wait_for(completed.wait(), timeout=1)
    await original_sleep(0)
    assert calls == ["started"]


@pytest.mark.asyncio
async def test_qq_group_reply_uses_group_target(monkeypatch):
    calls = []

    from agent.gateway import qq
    from agent.im.replies import send_text

    async def fake_group(*args):
        calls.append(("group", args))

    async def fake_c2c(*args):
        calls.append(("c2c", args))

    monkeypatch.setattr(qq, "send_group", fake_group)
    monkeypatch.setattr(qq, "send_c2c", fake_c2c)

    await send_text({
        "platform": "qq",
        "chat_type": "group",
        "chat_id": "group-1",
        "platform_user_id": "member-1",
        "message_id": "message-1",
    }, "回复")

    assert [kind for kind, _ in calls] == ["group"]


@pytest.mark.asyncio
async def test_qq_private_reply_uses_sender_target(monkeypatch):
    calls = []

    from agent.gateway import qq
    from agent.im.replies import send_text

    async def fake_c2c(*args):
        calls.append(args)

    monkeypatch.setattr(qq, "send_c2c", fake_c2c)

    await send_text({
        "platform": "qq",
        "chat_type": "c2c",
        "platform_user_id": "user-1",
        "message_id": "message-2",
    }, "回复")

    assert len(calls) == 1
    assert calls[0][0] == "user-1"


@pytest.mark.asyncio
async def test_interaction_uses_qq_keyboard_and_keeps_text_fallback(monkeypatch):
    from agent.gateway import qq
    from agent.im.replies import send_interaction

    keyboard_calls = []
    text_calls = []

    async def fake_keyboard(*args, **kwargs):
        keyboard_calls.append((args, kwargs))
        return True

    async def fake_text(payload, text):
        text_calls.append(text)
        return True

    monkeypatch.setattr(qq, "send_keyboard", fake_keyboard)
    monkeypatch.setattr("agent.im.replies.send_text", fake_text)
    await send_interaction(
        {"platform": "qq", "chat_type": "c2c", "platform_user_id": "user-1",
         "channel_id": "bot-1", "message_id": "msg-1"},
        {"prompt_id": 17, "title": "选择", "body": "选一个",
         "options": [{"id": "a", "label": "A", "token": "opaque-token"}]},
    )

    assert len(keyboard_calls) == 1
    assert text_calls == []
    assert "session_id" not in repr(keyboard_calls[0])


@pytest.mark.asyncio
async def test_qq_keyboard_failure_fallback_accepts_number(monkeypatch):
    from agent.gateway import qq
    from agent.im.replies import send_interaction

    text_calls = []

    async def fake_keyboard(*args, **kwargs):
        return False

    async def fake_text(payload, text):
        text_calls.append(text)
        return True

    monkeypatch.setattr(qq, "send_keyboard", fake_keyboard)
    monkeypatch.setattr("agent.im.replies.send_text", fake_text)
    await send_interaction(
        {"platform": "qq", "chat_type": "c2c", "platform_user_id": "user-1",
         "channel_id": "bot-1", "message_id": "msg-1"},
        {"prompt_id": 17, "title": "选择", "body": "选一个",
         "options": [{"id": "a", "label": "A", "token": "opaque-token"}]},
    )

    assert len(text_calls) == 1
    assert "1. A" in text_calls[0]
    assert "回复选项序号或选项文字" in text_calls[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("platform", ["feishu", "wechat"])
async def test_interaction_uses_plain_text_for_unadapted_platforms(monkeypatch, platform):
    """飞书/微信尚未接入原生按钮，ask_user 必须直接发送文本。"""
    from agent.im import replies

    text_calls = []

    async def fake_text(payload, text):
        text_calls.append((payload, text))
        return True

    monkeypatch.setattr(replies, "send_text", fake_text)
    await replies.send_interaction(
        {"platform": platform, "chat_type": "c2c", "platform_user_id": "user-1"},
        {"prompt_id": 18, "title": "选择", "body": "选一个",
         "options": [{"id": "a", "label": "A", "token": "opaque-token"}]},
    )

    assert len(text_calls) == 1
    assert "1. A" in text_calls[0][1]
    assert "请直接回复选项序号或选项文字" in text_calls[0][1]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("platform", "payload", "markdown"),
    [
        ("qq", {"chat_type": "group", "message_format": "compat"}, False),
        ("feishu", {"chat_type": "group"}, True),
        ("wechat", {"chat_type": "c2c"}, True),
    ],
)
async def test_tool_event_platform_fallbacks_keep_result_and_hide_input(monkeypatch, platform, payload, markdown):
    """回归：QQ 群聊使用纯文本结果，飞书/微信降级为 Markdown；输入不能泄露到结果消息。"""
    from agent.im import replies

    sent = []

    async def fake_text(_payload, text):
        sent.append(text)
        return True

    monkeypatch.setattr(replies, "send_text", fake_text)
    await replies.send_tool_event(
        {"platform": platform, "platform_user_id": "member-1", **payload},
        {"type": "tool_call", "label": "联网搜索", "input": {"query": "不应出现在结果"}},
    )
    await replies.send_tool_event(
        {"platform": platform, "platform_user_id": "member-1", **payload},
        {"type": "tool_done", "label": "联网搜索", "status": "success",
         "result": {"items": ["结果"]}},
    )

    assert len(sent) == 2 if markdown else 1
    if markdown:
        assert "**输入**" in sent[0]
    result_text = sent[-1]
    assert "不应出现在结果" not in result_text
    if markdown:
        assert "**输出**" in result_text
        assert "结果" in result_text
    else:
        assert result_text == "✅ 联网搜索完成"


@pytest.mark.asyncio
async def test_qq_private_stream_uses_replace_frames_and_stream_id(monkeypatch):
    from agent.gateway import qq
    from agent.im.replies import send_stream_with_fallback

    requests = []

    async def fake_request(channel_id, method, path, *, json_body=None, **kwargs):
        requests.append(json_body)
        return {"stream_msg_id": "stream-1"}

    monkeypatch.setattr(qq, "_qq_request", fake_request)
    monkeypatch.setattr(qq, "_next_stream_seq", lambda _channel: _stream_seq())

    async def events():
        yield ("token", "你好")
        yield ("token", "，世界")
        from agent.models import AgentResponse
        yield ("final", AgentResponse(text="你好，世界", session_id=1))

    async def _stream_seq():
        return 42

    sent, response, text = await send_stream_with_fallback({
        "platform": "qq", "chat_type": "c2c", "channel_id": "bot-1",
        "platform_user_id": "user-1", "message_id": "incoming-1",
        "message_format": "compat",
    }, events())

    assert sent is True
    assert response.text == "你好，世界"
    assert text == "你好，世界"
    assert [item["input_state"] for item in requests] == [1, 10]
    assert all(item["input_mode"] == "replace" for item in requests)
    assert [item["index"] for item in requests] == [0, 1]
    assert requests[0]["content_raw"] == requests[1]["content_raw"] == "你好，世界"
    assert "stream_msg_id" not in requests[0]
    assert requests[1]["stream_msg_id"] == "stream-1"
    assert requests[0]["msg_seq"] == requests[1]["msg_seq"] == 42


@pytest.mark.asyncio
async def test_qq_private_stream_first_frame_failure_falls_back_once(monkeypatch):
    from agent.gateway import qq
    from agent.im import replies
    from agent.models import AgentResponse

    async def failed_request(*args, **kwargs):
        raise qq.QQAPIError("POST", "/stream_messages", 400, {"code": 40001})

    fallback = []
    monkeypatch.setattr(qq, "_qq_request", failed_request)
    monkeypatch.setattr(replies, "send_text", lambda payload, text: fallback.append(text))

    async def events():
        yield ("token", "失败前的内容")
        yield ("final", AgentResponse(text="失败前的内容", session_id=1))

    sent, _response, text = await replies.send_stream_with_fallback({
        "platform": "qq", "chat_type": "c2c", "channel_id": "bot-1",
        "platform_user_id": "user-1", "message_id": "incoming-1",
    }, events())

    assert sent is False
    assert text == "失败前的内容"
    # 发送器本身不重复发送；worker 会在 sent=False 时统一走一次普通回复。
    assert fallback == []


@pytest.mark.asyncio
async def test_unknown_reply_target_does_not_raise(capsys):
    from agent.im.replies import send_text

    await send_text({"platform": "unknown"}, "回复")

    assert "无发送通道" in capsys.readouterr().out


def test_platform_reply_declares_text_and_reply_capabilities():
    from agent.im.models import (
        REPLY_CAPABILITY_REPLY,
        REPLY_CAPABILITY_TEXT,
        PlatformReply,
    )

    reply = PlatformReply.from_text({
        "platform": "qq",
        "chat_type": "c2c",
        "platform_user_id": "user-1",
        "message_id": "message-1",
    }, "回复")

    assert reply.capabilities == (REPLY_CAPABILITY_TEXT, REPLY_CAPABILITY_REPLY)
    assert reply.unsupported_capabilities("qq") == ()
    assert reply.unsupported_capabilities("unknown") == (
        REPLY_CAPABILITY_TEXT,
        REPLY_CAPABILITY_REPLY,
    )


def test_platform_reply_infers_keyboard_capability_from_parts():
    from agent.im.models import REPLY_CAPABILITY_KEYBOARD, PlatformReply

    reply = PlatformReply.from_parts({
        "platform": "feishu",
        "chat_type": "c2c",
        "platform_user_id": "user-1",
    }, [
        {"type": "text", "text": "请选择"},
        {"type": "keyboard", "items": [{"label": "确认", "value": "yes"}]},
    ])

    assert REPLY_CAPABILITY_KEYBOARD in reply.required_capabilities
    assert reply.unsupported_capabilities("feishu") == ()
    assert REPLY_CAPABILITY_KEYBOARD in reply.unsupported_capabilities("qq")


@pytest.mark.asyncio
async def test_qq_group_file_result_is_returned_to_worker(monkeypatch):
    from agent.im import replies

    class FakeStorage:
        async def get(self, key):
            return b"image-bytes"

    calls = []
    async def fake_send_file(*args, **kwargs):
        calls.append((args, kwargs))
        return True

    monkeypatch.setattr("app.services.storage.get_storage", lambda: FakeStorage())
    monkeypatch.setattr("agent.gateway.qq.send_file", fake_send_file)
    result = await replies._send_file_qq({
        "platform": "qq",
        "chat_type": "group",
        "chat_id": "group-1",
        "message_id": "msg-1",
    }, "storage-key", "png", "阿罗娜", "阿罗娜.png")

    assert result is True
    assert calls[0][1]["group"] is True


@pytest.mark.asyncio
async def test_qq_group_file_reads_local_storage_bytes(monkeypatch):
    from agent.im import replies

    class FakeStorage:
        async def get(self, key):
            return b"image-bytes"

    calls = []

    async def fake_send_file(*args, **kwargs):
        calls.append((args, kwargs))
        return True

    monkeypatch.setattr("app.services.storage.get_storage", lambda: FakeStorage())
    monkeypatch.setattr("agent.gateway.qq.send_file", fake_send_file)
    result = await replies._send_file_qq(
        {
            "platform": "qq",
            "chat_type": "group",
            "chat_id": "group-1",
            "message_id": "msg-1",
        },
        "storage-key",
        "png",
        "阿罗娜",
        "阿罗娜.png",
    )

    assert result is True
    assert calls[0][1]["group"] is True


@pytest.mark.asyncio
async def test_feishu_oversized_file_sends_limit_notice_without_gateway_call(monkeypatch):
    from agent.gateway import feishu
    from agent.im import replies

    gateway_calls = []

    async def fake_send_file(*args):
        gateway_calls.append(args)

    monkeypatch.setattr(feishu, "send_file", fake_send_file)

    result = await replies._send_file_feishu(
        {"platform": "feishu", "chat_id": "chat-1"},
        "png",
        b"x" * (replies._FEISHU_IMAGE_MAX + 1),
        "大图.png",
    )

    assert result is False
    assert gateway_calls == []


@pytest.mark.asyncio
async def test_unknown_platform_file_reply_does_not_open_storage(capsys):
    from agent.im import files

    await files.send_files({"platform": "unknown"}, [{"file_id": 42}])

    assert "暂不支持发文件" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_send_file_dispatches_by_platform(monkeypatch):
    """send_file 是文件回复"该调哪个平台"的唯一分发入口，跟文本/流式共用同一套判断。"""
    from agent.im import replies

    calls = []

    async def fake_qq(payload, storage_key, ext, display_name, fname):
        calls.append("qq")
        return True

    async def fake_feishu(payload, ext, data, fname):
        calls.append("feishu")
        return True

    async def fake_wechat(payload, storage_key, ext, fname):
        calls.append("wechat")
        return True

    class FakeStorage:
        async def get(self, key):
            return b""

    monkeypatch.setattr(replies, "_send_file_qq", fake_qq)
    monkeypatch.setattr(replies, "_send_file_feishu", fake_feishu)
    monkeypatch.setattr(replies, "_send_file_wechat", fake_wechat)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: FakeStorage())

    for platform in ("qq", "feishu", "wechat"):
        ok = await replies.send_file(
            {"platform": platform}, storage_key="k", ext="png", display_name="n", fname="n.png",
        )
        assert ok is True

    assert calls == ["qq", "feishu", "wechat"]

    ok = await replies.send_file(
        {"platform": "unknown"}, storage_key="k", ext="png", display_name="n", fname="n.png",
    )
    assert ok is False


@pytest.mark.asyncio
async def test_unsupported_stream_capability_falls_back_before_gateway(monkeypatch):
    from agent.im import replies

    called = []

    async def fake_stream(*args):
        called.append(args)
        return True, object()

    monkeypatch.setattr("agent.gateway.feishu.send_text_stream", fake_stream)
    sent = []

    async def fake_text(payload, text):
        sent.append(text)

    monkeypatch.setattr(replies, "send_text", fake_text)
    ok, response = await replies.send_stream(
        {"platform": "qq", "platform_user_id": "user-1"},
        iter(()),
    )

    assert (ok, response) == (False, None)
    assert called == []
