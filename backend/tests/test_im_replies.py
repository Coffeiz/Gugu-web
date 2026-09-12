import pytest


@pytest.mark.asyncio
async def test_im_display_preferences_reads_both_flags_with_legacy_defaults(monkeypatch):
    from agent.interactions.preferences import im_display_preferences
    from app.db import session as db_session

    class FakeDb:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def scalar(self, _query):
            class Row:
                data = {"show_tool_interactions": True, "show_intermediate_replies": False}
            return Row()

    monkeypatch.setattr(db_session, "ensure_engine", lambda: None)
    monkeypatch.setattr(db_session, "_SessionLocal", FakeDb)

    assert await im_display_preferences("synthetic-user") == (True, False)


def test_qq_expired_msg_id_is_treated_as_passive_reply_failure():
    from agent.gateway.qq import QQAPIError, _qq_msg_id_invalid

    exc = QQAPIError(
        "POST",
        "/v2/groups/test/messages",
        400,
        {"code": 40034031, "message": "msgid已经过期,不能回复"},
    )
    assert _qq_msg_id_invalid(exc)




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
async def test_send_agent_response_sends_each_round_separately(monkeypatch):
    from agent.im import replies
    from agent.models import AgentResponse

    sent = []

    async def fake_files(_payload, _files):
        class Result:
            failed = False
            reason = None
        return Result()

    async def fake_text(_payload, text):
        sent.append(text)
        return True

    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr("agent.im.files.send_files", fake_files)
    result = await replies.send_agent_response(
        {"platform": "qq", "chat_type": "group"},
        AgentResponse(text="最后一轮", round_texts=["第一轮", "最后一轮"]),
    )

    assert sent == ["第一轮", "最后一轮"]
    assert result == "最后一轮"


@pytest.mark.asyncio
async def test_send_agent_response_hides_intermediate_rounds_but_keeps_final(monkeypatch):
    from agent.im import replies
    from agent.models import AgentResponse

    sent = []

    async def fake_files(_payload, _files):
        class Result:
            failed = False
            reason = None
        return Result()

    async def fake_text(_payload, text):
        sent.append(text)
        return True

    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr("agent.im.files.send_files", fake_files)
    result = await replies.send_agent_response(
        {"platform": "qq", "chat_type": "group"},
        AgentResponse(text="最终回复", round_texts=["中间草稿一", "中间草稿二", "最终回复"]),
        show_intermediate_replies=False,
    )

    assert sent == ["最终回复"]
    assert result == "最终回复"


@pytest.mark.asyncio
async def test_send_agent_response_skips_rounds_already_sent_by_callback(monkeypatch):
    from agent.im import replies
    from agent.models import AgentResponse

    sent = []

    async def fake_files(_payload, _files):
        class Result:
            failed = False
            reason = None
        return Result()

    async def fake_text(_payload, text):
        sent.append(text)
        return True

    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr("agent.im.files.send_files", fake_files)
    result = await replies.send_agent_response(
        {"platform": "qq", "chat_type": "group"},
        AgentResponse(text="最后一轮", round_texts=["第一轮", "最后一轮"]),
        already_sent_rounds=1,
    )

    assert sent == ["最后一轮"]
    assert result == "最后一轮"


@pytest.mark.asyncio
async def test_send_agent_response_replays_only_unsent_round_indices(monkeypatch):
    from agent.im import replies
    from agent.models import AgentResponse

    sent = []

    async def fake_files(_payload, _files):
        class Result:
            failed = False
            reason = None
        return Result()

    async def fake_text(_payload, text):
        sent.append(text)
        return True

    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr("agent.im.files.send_files", fake_files)
    result = await replies.send_agent_response(
        {"platform": "qq", "chat_type": "group"},
        AgentResponse(text="第三轮", round_texts=["第一轮", "第二轮", "第三轮"]),
        already_sent_rounds={0, 2},
    )

    assert sent == ["第二轮"]
    assert result == "第三轮"


@pytest.mark.asyncio
async def test_send_agent_response_sends_error_after_sent_rounds(monkeypatch):
    """模型续轮失败时，错误提示不能被已发送 round 的去重逻辑吞掉。"""
    from agent.im import replies
    from agent.models import AgentResponse

    sent = []

    async def fake_files(_payload, _files):
        class Result:
            failed = False
            reason = None
        return Result()

    async def fake_text(_payload, text):
        sent.append(text)
        return True

    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr("agent.im.files.send_files", fake_files)
    result = await replies.send_agent_response(
        {"platform": "qq", "chat_type": "group"},
        AgentResponse(
            text="模型调用失败，请重试。",
            round_texts=["前面已经发出的正文"],
            errored=True,
        ),
        already_sent_rounds={0},
    )

    assert sent == ["模型调用失败，请重试。"]
    assert result == "模型调用失败，请重试。"


@pytest.mark.asyncio
async def test_attachment_failure_is_not_hidden_by_sent_round_index(monkeypatch):
    from agent.im import replies
    from agent.models import AgentResponse

    sent = []

    async def fake_files(_payload, _files):
        class Result:
            failed = True
            reason = "附件发送失败"
        return Result()

    async def fake_text(_payload, text):
        sent.append(text)
        return True

    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr("agent.im.files.send_files", fake_files)
    result = await replies.send_agent_response(
        {"platform": "qq", "chat_type": "group"},
        AgentResponse(text="第一轮", round_texts=["第一轮"], files=[{"id": "file-1"}]),
        already_sent_rounds={0},
    )

    assert sent == ["附件发送失败"]
    assert result == "附件发送失败"


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
async def test_qq_group_interaction_uses_active_message(monkeypatch):
    from agent.gateway import qq
    from agent.im.replies import send_interaction

    calls = []

    async def fake_keyboard(*args, **kwargs):
        calls.append((args, kwargs))
        return True

    monkeypatch.setattr(qq, "send_keyboard", fake_keyboard)
    await send_interaction(
        {"platform": "qq", "chat_type": "group", "chat_id": "group-1",
         "platform_user_id": "member-1", "channel_id": "bot-1", "message_id": "msg-1"},
        {"prompt_id": 19, "title": "选择", "body": "选一个",
         "options": [{"id": "a", "label": "A", "token": "opaque-token"}]},
    )

    assert len(calls) == 1
    assert calls[0][0][0] == "group-1"
    assert calls[0][1]["group"] is True
    assert calls[0][1]["msg_id"] is None


@pytest.mark.asyncio
async def test_qq_group_interaction_text_fallback_is_also_active(monkeypatch):
    from agent.gateway import qq
    from agent.im import replies

    payloads = []

    async def fake_keyboard(*_args, **_kwargs):
        return False

    async def fake_text(payload, _text):
        payloads.append(payload)
        return True

    monkeypatch.setattr(qq, "send_keyboard", fake_keyboard)
    monkeypatch.setattr(replies, "send_text", fake_text)
    assert await replies.send_interaction(
        {"platform": "qq", "chat_type": "group", "chat_id": "group-1",
         "platform_user_id": "member-1", "channel_id": "bot-1", "message_id": "msg-1"},
        {"prompt_id": 20, "title": "选择", "body": "选一个",
         "options": [{"id": "a", "label": "A", "token": "opaque-token"}]},
    ) is True

    assert len(payloads) == 1
    assert payloads[0]["message_id"] is None


@pytest.mark.asyncio
async def test_qq_passive_reply_is_consumed_once_per_inbound_message(monkeypatch):
    from agent.gateway import qq
    from agent.im.replies import send_text

    message_ids = []

    async def fake_group(_target, _text, msg_id, *_args):
        message_ids.append(msg_id)
        return True

    monkeypatch.setattr(qq, "send_group", fake_group)
    payload = {
        "platform": "qq", "chat_type": "group", "chat_id": "group-1",
        "platform_user_id": "member-1", "channel_id": "bot-1", "message_id": "msg-1",
    }

    assert await send_text(payload, "第一段") is True
    assert await send_text(payload, "第二段") is True
    assert message_ids == ["msg-1", None]


@pytest.mark.asyncio
async def test_qq_tool_status_does_not_consume_passive_reply(monkeypatch):
    from agent.im import replies

    payloads = []

    async def fake_text(payload, _text):
        payloads.append(payload)
        return True

    monkeypatch.setattr(replies, "send_text", fake_text)
    payload = {
        "platform": "qq", "chat_type": "group", "chat_id": "group-1",
        "platform_user_id": "member-1", "message_id": "msg-1",
        "message_format": "compat",
    }
    assert await replies.send_tool_event(
        payload, {"type": "tool_done", "label": "读取文件", "status": "success"}
    ) is True

    assert len(payloads) == 1
    assert payloads[0]["message_id"] is None


@pytest.mark.asyncio
async def test_interaction_prompt_send_result_is_propagated(monkeypatch):
    from agent.im import loop
    from agent.im import replies

    async def fake_send(_payload, prompt):
        return prompt["prompt_id"] == 21

    monkeypatch.setattr(replies, "send_interaction", fake_send)
    assert await loop._send_interaction_prompts(
        {"platform": "qq"},
        [{"prompt_id": 21}, {"prompt_id": 22}],
    ) is False


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
    """飞书/微信未提供原生按钮时，ask_user 必须直接发送文本。"""
    from agent.im import replies

    text_calls = []

    async def fake_text(payload, text):
        text_calls.append((payload, text))
        return True

    monkeypatch.setattr(replies, "send_text", fake_text)
    if platform == "feishu":
        from agent.gateway import feishu

        async def unavailable_card(*_args, **_kwargs):
            return False

        monkeypatch.setattr(feishu, "send_interaction_card", unavailable_card)
    await replies.send_interaction(
        {"platform": platform, "chat_type": "c2c", "chat_id": "chat-1",
         "platform_user_id": "user-1", "channel_id": "bot-1"},
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
