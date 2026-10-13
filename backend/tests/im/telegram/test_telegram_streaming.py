"""Telegram 私聊 live draft 流式回复回归测试。"""

import pytest

from agent.im import replies
from agent.interactions.events import ROUND_END
from agent.models import AgentResponse


@pytest.mark.asyncio
async def test_telegram_gateway_sends_bounded_live_draft(monkeypatch):
    from agent.gateway.telegram import runtime

    observed = {}

    async def bot_token(channel_id):
        assert channel_id == "41"
        return "token"

    async def call_for_chat(token, method, payload, **kwargs):
        observed.update(token=token, method=method, payload=payload, kwargs=kwargs)

    monkeypatch.setattr(runtime, "_bot_token", bot_token)
    monkeypatch.setattr(runtime, "_call_for_chat", call_for_chat)

    sent = await runtime.send_message_draft(
        "7001", "草稿", channel_id="41", draft_id=123,
    )

    assert sent is True
    assert observed["method"] == "sendMessageDraft"
    assert observed["payload"] == {"chat_id": "7001", "draft_id": 123, "text": "草稿"}
    assert observed["kwargs"]["is_group"] is False


@pytest.mark.asyncio
async def test_telegram_stream_updates_draft_and_persists_completed_rounds(monkeypatch):
    from agent.gateway import telegram

    drafts = []
    persisted_rounds = []

    async def send_draft(chat_id, text, *, channel_id, draft_id):
        drafts.append((chat_id, text, channel_id, draft_id))
        return True

    async def send_round(payload, text):
        persisted_rounds.append(text)
        return True

    monkeypatch.setattr(telegram, "send_message_draft", send_draft)
    monkeypatch.setattr(replies, "send_completed_round", send_round)
    monkeypatch.setattr(replies, "_TELEGRAM_DRAFT_MIN_INTERVAL", 0)

    async def token_iter():
        yield "token", "第一段"
        yield ROUND_END, "第一段"
        yield "token", "第二段"
        yield ROUND_END, "第二段"
        yield "final", AgentResponse(text="第二段", round_texts=["第一段", "第二段"])

    response, sent_rounds = await replies.send_telegram_stream_by_round(
        {"chat_id": "7001", "channel_id": "41"}, token_iter(),
        show_intermediate_replies=True,
    )

    assert response.text == "第二段"
    assert sent_rounds == {0, 1}
    assert persisted_rounds == ["第一段", "第二段"]
    assert [item[1] for item in drafts] == ["第一段", "第二段"]
    assert drafts[0][3] != drafts[1][3]


@pytest.mark.asyncio
async def test_telegram_stream_reuses_preview_without_persisting_hidden_rounds(monkeypatch):
    from agent.gateway import telegram

    drafts = []
    persisted_rounds = []

    async def send_draft(chat_id, text, *, channel_id, draft_id):
        drafts.append((text, draft_id))
        return True

    async def send_round(_payload, text):
        persisted_rounds.append(text)
        return True

    monkeypatch.setattr(telegram, "send_message_draft", send_draft)
    monkeypatch.setattr(replies, "send_completed_round", send_round)
    monkeypatch.setattr(replies, "_TELEGRAM_DRAFT_MIN_INTERVAL", 0)

    async def token_iter():
        yield "token", "中间过程"
        yield ROUND_END, "中间过程"
        yield "token", "最终回复"
        yield ROUND_END, "最终回复"
        yield "final", AgentResponse(text="最终回复", round_texts=["中间过程", "最终回复"])

    response, sent_rounds = await replies.send_telegram_stream_by_round(
        {"chat_id": "7001", "channel_id": "41"}, token_iter(),
        show_intermediate_replies=False,
    )

    assert response.text == "最终回复"
    assert sent_rounds == set()
    assert persisted_rounds == []
    assert [item[0] for item in drafts] == ["中间过程", "最终回复"]
    assert drafts[0][1] == drafts[1][1]
