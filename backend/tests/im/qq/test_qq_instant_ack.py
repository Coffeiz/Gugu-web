"""QQ 附件秒回（即时反馈 ack）的行为级测试。

覆盖四件事：
- 收到附件立刻回一句「文件收到啦」，且原消息照常入队（不被秒回吃掉）；
- 同一会话 10 秒内只回一次，连发文件不刷屏；
- 群聊按「回应策略」决定回不回：只响应 @ 时非 @ 不回，静默记录模式连 @ 也不回；
- 纯文本消息不触发附件秒回。
"""
import time

import pytest

from agent.gateway.qq import events as qq_events


@pytest.fixture(autouse=True)
def qq_ref_index_tmpdir(tmp_path, monkeypatch):
    """所有 QQ 网关测试都只能写临时引用索引，禁止污染 backend/data。"""
    monkeypatch.setenv("QQ_REF_INDEX_DIR", str(tmp_path))


def _c2c_with_attachment(**overrides):
    data = {
        "id": "msg-ack",
        "content": "看看这个文件",
        "author": {"user_openid": "ou_1"},
        "attachments": [{"url": "https://example.test/a.bin", "filename": "a.bin"}],
        "message_scene": {"ext": ["msg_idx=1"]},
        "msg_elements": [],
    }
    data.update(overrides)
    return data


def _group_with_attachment(**overrides):
    data = _c2c_with_attachment(
        author={"member_openid": "member_1"},
        group_openid="group_1",
    )
    data.update(overrides)
    return data


def _install(monkeypatch, *, group_settings=(True, False, False, True, True)):
    """接管出站与入队，只记录行为，不碰网络与数据库。

    ``group_settings`` 依次是
    (群聊启用, 只响应@, 静默记录, 群记忆, 成员记忆)。
    """
    sent: list[tuple] = []
    produced: list[dict] = []

    async def fake_post(channel_id, openid, text, msg_id, message_format=None):
        sent.append(("private", channel_id, openid, text, msg_id))

    async def fake_post_group(channel_id, group_openid, text, msg_id,
                              message_format=None, **kwargs):
        sent.append(("group", channel_id, group_openid, text, msg_id))

    async def fake_produce(stream, payload):
        produced.append(payload)

    async def fake_group_settings(bot_id):
        return group_settings

    async def fake_message_format(bot_id, chat_type):
        return "compat"

    async def fake_async_none(*args, **kwargs):
        return None

    async def fake_async_false(*args, **kwargs):
        return False

    from agent import router
    from agent.runtime import runtime_state

    monkeypatch.setattr(router, "decide", lambda *args, **kwargs: {"action": "run"})
    monkeypatch.setattr(runtime_state, "get_state", fake_async_none)
    monkeypatch.setattr(runtime_state, "is_awaiting", fake_async_false)
    monkeypatch.setattr(runtime_state, "get_active", fake_async_none)
    monkeypatch.setattr(qq_events, "_message_format", fake_message_format)
    monkeypatch.setattr(qq_events, "_post", fake_post)
    monkeypatch.setattr(qq_events, "_post_group", fake_post_group)
    monkeypatch.setattr(qq_events.R, "produce", fake_produce)
    monkeypatch.setattr(qq_events, "_group_settings", fake_group_settings)
    return sent, produced


async def test_qq_attachment_triggers_instant_ack(monkeypatch):
    sent, produced = _install(monkeypatch)

    await qq_events._handle_raw_qq_message(
        "C2C_MESSAGE_CREATE", _c2c_with_attachment(), "bot-1", "user-1", {},
    )

    assert [item[3] for item in sent] == ["文件收到啦，让我看看~"]
    assert sent[0][0] == "private"
    assert sent[0][2] == "ou_1"
    # 秒回只是体验层提示：原消息必须照常入队，不能被秒回吃掉。
    assert len(produced) == 1
    assert produced[0]["attachments"][0]["filename"] == "a.bin"


async def test_qq_attachment_ack_is_rate_limited_within_cooldown(monkeypatch):
    sent, produced = _install(monkeypatch)
    last_ack: dict = {}

    await qq_events._handle_raw_qq_message(
        "C2C_MESSAGE_CREATE", _c2c_with_attachment(), "bot-1", "user-1", last_ack,
    )
    await qq_events._handle_raw_qq_message(
        "C2C_MESSAGE_CREATE", _c2c_with_attachment(id="msg-ack-2"), "bot-1", "user-1", last_ack,
    )

    # 冷却窗口内只回一次，不刷屏。
    assert len(sent) == 1
    # 但两条消息都照常入队。
    assert len(produced) == 2


async def test_qq_attachment_ack_resumes_after_cooldown(monkeypatch):
    sent, produced = _install(monkeypatch)
    # 上一次秒回发生在冷却窗口之前，应该恢复发送。
    last_ack = {"c2c:ou_1": time.monotonic() - qq_events._ACK_COOLDOWN - 1.0}

    await qq_events._handle_raw_qq_message(
        "C2C_MESSAGE_CREATE", _c2c_with_attachment(), "bot-1", "user-1", last_ack,
    )

    assert [item[3] for item in sent] == ["文件收到啦，让我看看~"]


async def test_qq_group_attachment_ack_skipped_for_non_mention(monkeypatch):
    # 只响应 @ 的群（requires_at=True，静默记录关闭）。
    sent, produced = _install(monkeypatch, group_settings=(True, True, False, True, True))

    await qq_events._handle_raw_qq_message(
        "GROUP_MESSAGE_CREATE", _group_with_attachment(), "bot-1", "user-1", {},
    )

    assert sent == []
    assert len(produced) == 1


async def test_qq_group_attachment_ack_sent_when_bot_mentioned(monkeypatch):
    sent, produced = _install(monkeypatch, group_settings=(True, True, False, True, True))

    await qq_events._handle_raw_qq_message(
        "GROUP_AT_MESSAGE_CREATE", _group_with_attachment(), "bot-1", "user-1", {},
    )

    assert [item[3] for item in sent] == ["文件收到啦，让我看看~"]
    assert sent[0][0] == "group"
    assert sent[0][2] == "group_1"


async def test_qq_group_attachment_ack_skipped_in_read_only_mode(monkeypatch):
    # 静默记录模式：即使被 @ 也不对外回复，附件秒回同样要闭嘴。
    sent, produced = _install(monkeypatch, group_settings=(True, True, True, True, True))

    await qq_events._handle_raw_qq_message(
        "GROUP_AT_MESSAGE_CREATE", _group_with_attachment(), "bot-1", "user-1", {},
    )

    assert sent == []
    assert len(produced) == 1


async def test_qq_text_message_does_not_trigger_attachment_ack(monkeypatch):
    sent, produced = _install(monkeypatch)

    await qq_events._handle_raw_qq_message(
        "C2C_MESSAGE_CREATE",
        _c2c_with_attachment(attachments=[], content="你好"),
        "bot-1", "user-1", {},
    )

    assert sent == []
