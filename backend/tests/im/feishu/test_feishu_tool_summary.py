"""飞书工具摘要卡片的可观察呈现契约。"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from agent.models import AgentResponse
from agent.gateway.feishu_tool_summary import FeishuToolSummaryStream


def _walk_tags(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_tags(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_tags(child)


@pytest.mark.asyncio
async def test_tool_call_lifecycle_updates_one_collapsed_panel_by_call_id():
    updates = []
    summary = FeishuToolSummaryStream()

    async def write(elements):
        updates.append(elements)
        return True

    summary.bind(write)
    assert await summary.handle_tool_event({
        "type": "tool_call",
        "tool_call_id": "call-a",
        "name": "web_search",
        "label": "联网搜索",
        "status": "running",
        "input": {"query": "synthetic query"},
    })
    assert await summary.handle_tool_event({
        "type": "tool_done",
        "tool_call_id": "call-a",
        "name": "web_search",
        "label": "联网搜索",
        "status": "success",
        "result": {"count": 2},
    })

    panels = [node for node in _walk_tags(summary.elements()) if node.get("tag") == "collapsible_panel"]
    assert len(panels) == 1
    assert panels[0]["expanded"] is False
    assert panels[0]["header"]["title"]["content"] == "🛠 工具摘要 (1)"
    assert panels[0]["background_color"] == "grey"
    assert panels[0]["border"]["corner_radius"] == "8px"
    detail = panels[0]["elements"][0]["content"]
    assert "联网搜索 · 已完成" in detail
    assert "synthetic query" in detail
    assert '"count": 2' in detail
    assert len(updates) == 2


def test_tool_detail_is_bounded_and_cannot_break_its_markdown_fence():
    summary = FeishuToolSummaryStream()
    summary.bind(AsyncMock(return_value=True))

    detail = summary._tool_entry({
        "type": "tool_done",
        "tool_call_id": "call-b",
        "label": "工具",
        "status": "success",
        "result": "```\n" + "x" * 3000,
    })

    assert "` ` `" in detail
    assert len(detail) <= 2400


@pytest.mark.asyncio
async def test_contiguous_tool_events_share_one_outer_summary_and_text_splits_groups():
    summary = FeishuToolSummaryStream()
    summary.bind(AsyncMock(return_value=True))
    summary.append_text("先查一下。")
    await summary.handle_tool_event({"type": "tool_call", "tool_call_id": "call-a", "name": "search"})
    await summary.handle_tool_event({"type": "tool_call", "tool_call_id": "call-b", "name": "fetch"})
    summary.append_text("结果如下。")
    await summary.handle_tool_event({"type": "tool_call", "tool_call_id": "call-c", "name": "write"})

    panels = [node for node in _walk_tags(summary.elements()) if node.get("tag") == "collapsible_panel"]
    assert [panel["header"]["title"]["content"] for panel in panels] == [
        "🛠 工具摘要 (2)",
        "🛠 工具摘要 (1)",
    ]
    markdown = [node["content"] for node in _walk_tags(summary.elements()) if node.get("tag") == "markdown"]
    assert markdown[0] == "先查一下。"
    assert markdown[3] == "结果如下。"


@pytest.mark.asyncio
async def test_cancelled_running_tool_remains_inside_summary_with_stopped_status():
    summary = FeishuToolSummaryStream()
    summary.bind(AsyncMock(return_value=True))
    await summary.handle_tool_event({
        "type": "tool_call",
        "tool_call_id": "call-cancelled",
        "name": "shell",
        "status": "running",
    })

    summary.finish("", cancelled=True)

    panel = next(
        node for node in _walk_tags(summary.elements())
        if node.get("tag") == "collapsible_panel"
    )
    assert panel["header"]["title"]["content"] == "🛠 工具摘要 (1)"
    assert "已停止" in panel["elements"][0]["content"]


@pytest.mark.asyncio
async def test_unbound_summary_allows_existing_tool_message_fallback():
    summary = FeishuToolSummaryStream()

    assert await summary.handle_tool_event({"type": "tool_call", "tool_call_id": "call-c"}) is False


@pytest.mark.asyncio
async def test_tool_display_off_still_mirrors_web_without_sending_im_message(monkeypatch):
    from agent.im import loop

    send_tool_event = AsyncMock()
    monkeypatch.setattr("agent.im.replies.send_tool_event", send_tool_event, raising=False)
    published = []

    async def publish(event):
        published.append(event)

    event = {"type": "tool_call", "tool_call_id": "call-off"}
    await loop.display_tool_event(
        {"platform": "feishu"},
        event,
        show_tool_interactions=False,
        publish_web_event=publish,
    )

    assert published == [event]
    send_tool_event.assert_not_awaited()


@pytest.mark.asyncio
async def test_enabled_feishu_routes_to_card_after_it_is_bound(monkeypatch):
    from agent.im import loop

    send_tool_event = AsyncMock()
    monkeypatch.setattr("agent.im.replies.send_tool_event", send_tool_event, raising=False)
    updates = []
    summary = FeishuToolSummaryStream()

    async def write(elements):
        updates.append(elements)
        return True

    summary.bind(write)
    published = []

    async def publish(event):
        published.append(event)

    event = {"type": "tool_call", "tool_call_id": "call-on"}
    await loop.display_tool_event(
        {"platform": "feishu"},
        event,
        show_tool_interactions=True,
        publish_web_event=publish,
        feishu_tool_summary=summary,
    )

    assert published == [event]
    send_tool_event.assert_not_awaited()
    assert len(updates) == 1


@pytest.mark.asyncio
async def test_enabled_feishu_uses_existing_tool_message_if_card_was_not_created(monkeypatch):
    from agent.im import loop

    send_tool_event = AsyncMock()
    monkeypatch.setattr("agent.im.replies.send_tool_event", send_tool_event, raising=False)
    summary = FeishuToolSummaryStream()

    async def publish(_event):
        return None

    event = {"type": "tool_call", "tool_call_id": "call-fallback"}
    await loop.display_tool_event(
        {"platform": "feishu"},
        event,
        show_tool_interactions=True,
        publish_web_event=publish,
        feishu_tool_summary=summary,
    )

    send_tool_event.assert_awaited_once_with({"platform": "feishu"}, event)


@pytest.mark.asyncio
async def test_feishu_tool_summary_stream_interleaves_text_and_tools_with_shared_sequence(monkeypatch):
    from agent.gateway import feishu

    monkeypatch.setattr(feishu, "_creds_by_id", lambda _channel_id: _async_value(("app", "secret")))
    monkeypatch.setattr(feishu, "_do_create_card", lambda *_args: _async_value("card-id"))
    monkeypatch.setattr(feishu, "_do_send_card_message", lambda *_args: _async_value(True))
    sequence_calls = []

    async def update_card(*_args, sequence, elements=None, title=None, **_kwargs):
        sequence_calls.append((sequence, title, elements))
        return True

    async def update_text(*_args, sequence, element_id, content, **_kwargs):
        sequence_calls.append((sequence, element_id, content))
        return True

    async def finalize(_app, _secret, _card, _text, sequence, uuid):
        sequence_calls.append((sequence, "finalize", None))
        return True

    monkeypatch.setattr(feishu, "_do_update_card", update_card)
    monkeypatch.setattr(feishu, "_do_streaming_update_text", update_text)
    monkeypatch.setattr(feishu, "_do_finalize_streaming_card", finalize)
    summary = FeishuToolSummaryStream()

    async def token_iter():
        yield ("token", "工具前的说明内容足够长，确保可见且保留在卡片中。")
        await summary.handle_tool_event({
            "type": "tool_call",
            "tool_call_id": "call-stream",
            "name": "web_search",
            "label": "联网搜索",
            "status": "running",
            "input": {"query": "synthetic query"},
        })
        yield ("token", "工具执行后的最终说明内容。")
        await summary.handle_tool_event({
            "type": "tool_done",
            "tool_call_id": "call-stream",
            "name": "web_search",
            "label": "联网搜索",
            "status": "success",
            "result": "2 results",
        })
        yield ("final", AgentResponse(text="最终回答", session_id=19))

    ok, response = await feishu.send_text_stream(
        "receive",
        token_iter(),
        channel_id="channel",
        tool_summary=summary,
    )

    assert ok is True
    assert response.session_id == 19
    sequences = [call[0] for call in sequence_calls]
    assert sequences == sorted(sequences)
    assert len(sequences) == len(set(sequences))
    final_elements = next(call[2] for call in reversed(sequence_calls) if call[1] == "咕咕")
    text = "\n".join(
        str(node.get("content") or "")
        for node in _walk_tags(final_elements)
        if node.get("tag") == "markdown"
    )
    assert "工具前的说明内容" in text
    assert "最终回答" in text
    assert "工具执行后的最终说明内容" not in text
    assert any(node.get("tag") == "collapsible_panel" for node in _walk_tags(final_elements))


@pytest.mark.asyncio
async def test_visible_card_update_failure_does_not_request_duplicate_text_fallback(monkeypatch):
    from agent.gateway import feishu

    monkeypatch.setattr(feishu, "_creds_by_id", lambda _channel_id: _async_value(("app", "secret")))
    monkeypatch.setattr(feishu, "_do_create_card", lambda *_args: _async_value("card-id"))
    monkeypatch.setattr(feishu, "_do_send_card_message", lambda *_args: _async_value(True))
    monkeypatch.setattr(feishu, "_do_update_card", lambda *_args, **_kwargs: _async_value(False))
    monkeypatch.setattr(feishu, "_do_streaming_update_text", lambda *_args, **_kwargs: _async_value(False))
    send_text = AsyncMock(return_value=True)
    monkeypatch.setattr(feishu, "send_text", send_text)
    summary = FeishuToolSummaryStream()
    consumed = []

    async def token_iter():
        yield ("token", "已经有可见占位卡片")
        yield ("final", AgentResponse(text="最终回复", session_id=21))
        consumed.append("exhausted")

    sent, response = await feishu.send_text_stream(
        "receive", token_iter(), channel_id="channel", tool_summary=summary,
    )

    assert sent is True
    assert response.session_id == 21
    assert consumed == ["exhausted"]
    send_text.assert_not_awaited()


@pytest.mark.asyncio
async def test_existing_stream_path_without_summary_keeps_plain_card_updates(monkeypatch):
    from agent.gateway import feishu

    monkeypatch.setattr(feishu, "_creds_by_id", lambda _channel_id: _async_value(("app", "secret")))
    monkeypatch.setattr(feishu, "_do_create_card", lambda *_args: _async_value("card-id"))
    monkeypatch.setattr(feishu, "_do_send_card_message", lambda *_args: _async_value(True))
    updates = []

    async def update_card(*_args, sequence, title=None, **_kwargs):
        updates.append((sequence, title))
        return True

    monkeypatch.setattr(feishu, "_do_update_card", update_card)
    monkeypatch.setattr(feishu, "_do_streaming_update_text", lambda *_args, **_kwargs: _async_value(True))
    monkeypatch.setattr(feishu, "_do_finalize_streaming_card", lambda *_args, **_kwargs: _async_value(True))

    async def token_iter():
        yield ("token", "当前回复内容保持原来的普通 Markdown 卡片。")
        yield ("final", AgentResponse(text="当前回复内容保持原来的普通 Markdown 卡片。", session_id=20))

    ok, response = await feishu.send_text_stream("receive", token_iter(), channel_id="channel")

    assert ok is True
    assert response.session_id == 20
    assert len(updates) == 1
    assert updates[0][1] == "咕咕"


async def _async_value(value):
    return value
