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
        yield "tool_event", {"type": "tool_call", "name": "lookup", "label": "查询", "input": {"q": "x"}}
        yield "tool_event", {"type": "tool_done", "name": "lookup", "label": "查询", "status": "success", "result": {"ok": True}}
        yield "final", AgentResponse(text="第二段", round_texts=["第一段", "第二段"])

    response, sent_rounds = await replies.send_telegram_stream_by_round(
        {"chat_id": "7001", "channel_id": "41"}, token_iter(),
        show_intermediate_replies=True,
    )

    assert response.text == "第二段"
    assert sent_rounds == {0, 1}
    assert len(persisted_rounds) == 1
    assert persisted_rounds[0].startswith("第一段\n\n第二段\n\n✅ 查询完成")
    assert "**输入**" not in persisted_rounds[0]
    assert "**输出**" not in persisted_rounds[0]
    assert '{"ok": true}' not in persisted_rounds[0]
    assert [item[1] for item in drafts][-1] == persisted_rounds[0]
    assert len({item[3] for item in drafts}) == 1


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
    assert [item[0] for item in drafts] == ["中间过程", "中间过程\n\n最终回复"]
    assert drafts[0][1] == drafts[1][1]


@pytest.mark.asyncio
async def test_telegram_keeps_compact_tool_result_when_intermediate_replies_are_hidden(monkeypatch):
    from agent.gateway import telegram

    drafts = []
    persisted = []

    async def send_draft(_chat_id, text, *, channel_id, draft_id):
        drafts.append(text)
        return True

    async def send_round(_payload, text):
        persisted.append(text)
        return True

    monkeypatch.setattr(telegram, "send_message_draft", send_draft)
    monkeypatch.setattr(replies, "send_completed_round", send_round)
    monkeypatch.setattr(replies, "_TELEGRAM_DRAFT_MIN_INTERVAL", 0)

    async def token_iter():
        yield "token", "内部中间说明"
        yield ROUND_END, "内部中间说明"
        yield "tool_event", {"type": "tool_done", "name": "lookup", "label": "查询", "status": "success", "result": {"ok": True}}
        yield "token", "最终答案"
        yield ROUND_END, "最终答案"
        yield "final", AgentResponse(text="最终答案", round_texts=["内部中间说明", "最终答案"])

    response, sent_rounds = await replies.send_telegram_stream_by_round(
        {"chat_id": "7001", "channel_id": "41"}, token_iter(),
        show_intermediate_replies=False,
    )

    assert response.text == "最终答案"
    assert sent_rounds == {0}, "合并的工具完成提示和最终答案要能被最终统一出口去重"
    assert len(persisted) == 1
    assert "内部中间说明" not in persisted[0]
    assert "✅ 查询完成" in persisted[0]
    assert "**输入**" not in persisted[0]
    assert "**输出**" not in persisted[0]
    assert '{"ok": true}' not in persisted[0]
    assert persisted[0].endswith("最终答案")
    assert drafts[-1].startswith("内部中间说明\n\n✅ 查询完成")


@pytest.mark.asyncio
async def test_hidden_rounds_switch_to_ordered_delivery_when_mermaid_appears(monkeypatch):
    from agent.gateway import telegram
    from agent.im import mermaid

    drafts = []
    persisted_text = []
    sent_images = []

    class EventPassthroughFilter:
        def __init__(self, **_kwargs):
            pass

        async def events(self, source):
            async for event in source:
                yield event

        async def ordered_events(self, source):
            async for event in source:
                yield event

    async def send_draft(chat_id, text, *, channel_id, draft_id):
        drafts.append((chat_id, text, channel_id, draft_id))
        return True

    async def send_round(_payload, text):
        persisted_text.append(text)
        return True

    async def send_image(_payload, png):
        sent_images.append(png)
        return True

    monkeypatch.setattr(mermaid, "ProgressiveMermaidTokenFilter", EventPassthroughFilter)
    monkeypatch.setattr(telegram, "send_message_draft", send_draft)
    monkeypatch.setattr(replies, "send_completed_round", send_round)
    monkeypatch.setattr(replies, "_try_send_png_image", send_image)
    monkeypatch.setattr(replies, "_TELEGRAM_DRAFT_MIN_INTERVAL", 0)

    async def token_iter():
        yield "token", "前置回复"
        yield ROUND_END, "前置回复"
        yield "token", "图前说明\n"
        yield "mermaid_image", (0, 1, "```mermaid\ngraph LR\nA-->B\n```", b"png")
        yield "token", "\n图后说明"
        yield ROUND_END, "图前说明\n图后说明"
        yield "final", AgentResponse(
            text="前置回复\n图前说明\n图后说明",
            round_texts=["前置回复", "图前说明\n图后说明"],
        )

    response, sent_rounds = await replies.send_telegram_stream_by_round(
        {"chat_id": "7001", "channel_id": "41"},
        token_iter(),
        show_intermediate_replies=False,
    )

    assert response.text == "前置回复\n图前说明\n图后说明"
    assert sent_rounds == {0}, "完整图文轮次已发送后，最终聚合回复应跳过避免重复"
    assert persisted_text == ["前置回复\n\n图前说明", "图后说明"]
    assert sent_images == [b"png"]
    assert [item[1] for item in drafts] == ["前置回复", "前置回复\n\n图前说明\n", "图后说明"]
    assert drafts[0][3] == drafts[1][3], "同一张图之前应复用草稿 ID"
    assert drafts[1][3] != drafts[2][3], "图片发送后应使用新草稿 ID"
