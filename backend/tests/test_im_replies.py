import pytest


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
        "platform": "qqbot",
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
        "platform": "qqbot",
        "chat_type": "c2c",
        "platform_user_id": "user-1",
        "message_id": "message-2",
    }, "回复")

    assert len(calls) == 1
    assert calls[0][0] == "user-1"


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
        "platform": "qqbot",
        "chat_type": "c2c",
        "platform_user_id": "user-1",
        "message_id": "message-1",
    }, "回复")

    assert reply.capabilities == (REPLY_CAPABILITY_TEXT, REPLY_CAPABILITY_REPLY)
    assert reply.unsupported_capabilities("qqbot") == ()
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
    assert REPLY_CAPABILITY_KEYBOARD in reply.unsupported_capabilities("qqbot")


@pytest.mark.asyncio
async def test_qq_group_file_result_is_returned_to_worker(monkeypatch):
    from agent.im import files

    class FakeStorage:
        async def get(self, key):
            return b"image-bytes"

    calls = []
    async def fake_send_file(*args, **kwargs):
        calls.append((args, kwargs))
        return True

    monkeypatch.setattr("app.services.storage.get_storage", lambda: FakeStorage())
    monkeypatch.setattr("agent.gateway.qq.send_file", fake_send_file)
    result = await files._send_file_qq({
        "platform": "qqbot",
        "chat_type": "group",
        "chat_id": "group-1",
        "message_id": "msg-1",
    }, "storage-key", "png", "阿罗娜", "阿罗娜.png")

    assert result is True
    assert calls[0][1]["group"] is True


@pytest.mark.asyncio
async def test_qq_group_file_reads_local_storage_bytes(monkeypatch):
    from agent.im import files

    class FakeStorage:
        async def get(self, key):
            return b"image-bytes"

    calls = []

    async def fake_send_file(*args, **kwargs):
        calls.append((args, kwargs))
        return True

    monkeypatch.setattr("app.services.storage.get_storage", lambda: FakeStorage())
    monkeypatch.setattr("agent.gateway.qq.send_file", fake_send_file)
    result = await files._send_file_qq(
        {
            "platform": "qqbot",
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
    from agent.im import files

    gateway_calls = []

    async def fake_send_file(*args):
        gateway_calls.append(args)

    monkeypatch.setattr(feishu, "send_file", fake_send_file)

    result = await files._send_file_feishu(
        {"platform": "feishu", "chat_id": "chat-1"},
        "png",
        b"x" * (files._FEISHU_IMAGE_MAX + 1),
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
        {"platform": "qqbot", "platform_user_id": "user-1"},
        iter(()),
    )

    assert (ok, response) == (False, None)
    assert called == []
