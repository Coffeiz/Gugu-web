"""同群多 bot：@ 别的 bot 的消息要被标出来，咕咕不能抢答。

群里同时有多个 bot 时，QQ 会把 @ 消息推给所有 bot。网关必须把"这条 @ 的是
别人家的机器人"这个事实带给下游（只记录、不进回复选择门），否则咕咕会替
别人作答。
"""

import pytest

from agent.gateway.qq import events as qq_events


@pytest.fixture(autouse=True)
def qq_ref_index_tmpdir(tmp_path, monkeypatch):
    """所有 QQ 网关测试都只能写临时引用索引，禁止污染 backend/data。"""
    monkeypatch.setenv("QQ_REF_INDEX_DIR", str(tmp_path))


def _raw_group_event(**overrides):
    data = {
        "id": "msg-1",
        "content": "<@other-bot> 看看天气",
        "author": {"member_openid": "member_1"},
        "group_openid": "group_1",
        "attachments": [],
    }
    data.update(overrides)
    return data


def test_mentions_other_bot_only_hits_other_bots():
    assert qq_events._qq_message_mentions_other_bot(
        {"mentions": [{"id": "other-bot", "bot": True, "is_you": False}]}
    ) is True
    # @ 的是自己：不是"别的 bot"
    assert qq_events._qq_message_mentions_other_bot(
        {"mentions": [{"id": "me", "bot": True, "is_you": True}]}
    ) is False
    # @ 的是人
    assert qq_events._qq_message_mentions_other_bot(
        {"mentions": [{"id": "member-1", "bot": False}]}
    ) is False
    # 协议没给 mentions / 给了空数组：没有别的 bot
    assert qq_events._qq_message_mentions_other_bot({}) is False
    assert qq_events._qq_message_mentions_other_bot({"mentions": []}) is False


async def test_group_payload_marks_mention_to_another_bot(monkeypatch):
    produced: list[dict] = []

    async def fake_group_settings(_bot_id):
        # 全量回复模式：本来每条群消息都会进回复选择门
        return True, False, False

    async def fake_produce(_stream, payload):
        produced.append(payload)

    monkeypatch.setattr(qq_events, "_group_settings", fake_group_settings)
    monkeypatch.setattr(qq_events.R, "produce", fake_produce)

    from agent import router
    from agent.runtime import runtime_state

    async def fake_async_false(*args, **kwargs):
        return False

    async def fake_async_none(*args, **kwargs):
        return None

    monkeypatch.setattr(router, "decide", lambda *args, **kwargs: {"action": "run"})
    monkeypatch.setattr(runtime_state, "get_state", fake_async_none)
    monkeypatch.setattr(runtime_state, "is_awaiting", fake_async_false)

    await qq_events._handle_raw_qq_message(
        "GROUP_AT_MESSAGE_CREATE",
        _raw_group_event(mentions=[{"id": "other-bot", "bot": True, "is_you": False}]),
        "bot-1",
        "user-1",
        {},
    )

    assert len(produced) == 1
    assert produced[0]["mentions_other_bot"] is True
    assert produced[0]["group_mentioned"] is False


async def test_group_payload_of_own_mention_is_not_other_bot(monkeypatch):
    produced: list[dict] = []

    async def fake_group_settings(_bot_id):
        return True, False, False

    async def fake_produce(_stream, payload):
        produced.append(payload)

    monkeypatch.setattr(qq_events, "_group_settings", fake_group_settings)
    monkeypatch.setattr(qq_events.R, "produce", fake_produce)

    from agent import router
    from agent.runtime import runtime_state

    async def fake_async_false(*args, **kwargs):
        return False

    async def fake_async_none(*args, **kwargs):
        return None

    monkeypatch.setattr(router, "decide", lambda *args, **kwargs: {"action": "run"})
    monkeypatch.setattr(runtime_state, "get_state", fake_async_none)
    monkeypatch.setattr(runtime_state, "is_awaiting", fake_async_false)

    await qq_events._handle_raw_qq_message(
        "GROUP_AT_MESSAGE_CREATE",
        _raw_group_event(
            content="<@me-bot> 看看天气",
            mentions=[{"id": "me-bot", "bot": True, "is_you": True}],
        ),
        "bot-1",
        "user-1",
        {},
    )

    assert len(produced) == 1
    assert produced[0]["mentions_other_bot"] is False
    assert produced[0]["group_mentioned"] is True
