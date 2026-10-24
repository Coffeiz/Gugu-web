"""飞书工具摘要卡片的可观察呈现契约。"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from agent.models import AgentResponse
from agent.gateway.feishu.tool_summary import FeishuToolSummaryStream


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
    assert detail == "✅ 联网搜索完成"
    assert "synthetic query" not in detail
    assert '"count": 2' not in detail
    assert len(updates) == 1


def test_tool_completion_summary_omits_unbounded_result_payload():
    summary = FeishuToolSummaryStream()
    summary.bind(AsyncMock(return_value=True))

    detail = summary._tool_entry({
        "type": "tool_done",
        "tool_call_id": "call-b",
        "label": "工具",
        "status": "success",
        "result": "```\n" + "x" * 3000,
    })

    assert detail == "✅ 工具完成"
    assert "x" * 100 not in detail


@pytest.mark.asyncio
async def test_private_feishu_keeps_input_and_result_json_in_the_same_stream_panel():
    updates = []
    summary = FeishuToolSummaryStream(include_tool_details=True)

    async def write(elements):
        updates.append(elements)
        return True

    summary.bind(write)
    assert await summary.handle_tool_event({
        "type": "tool_call",
        "tool_call_id": "private-call",
        "name": "web_search",
        "label": "联网搜索",
        "status": "running",
        "input": {"query": "synthetic private query"},
    })
    assert await summary.handle_tool_event({
        "type": "tool_done",
        "tool_call_id": "private-call",
        "name": "web_search",
        "label": "联网搜索",
        "status": "success",
        "result": {"items": ["synthetic result"]},
    })

    panels = [
        node for node in _walk_tags(summary.elements())
        if node.get("tag") == "collapsible_panel"
    ]
    assert len(panels) == 1
    detail = panels[0]["elements"][0]["content"]
    assert "**输入**" in detail
    assert '"query": "synthetic private query"' in detail
    assert "**结果**" in detail
    assert '"synthetic result"' in detail
    assert len(updates) == 2
    assert "synthetic private query" in updates[0][0]["elements"][0]["content"]
    assert "synthetic result" in updates[1][0]["elements"][0]["content"]


@pytest.mark.asyncio
async def test_private_feishu_keeps_each_tool_in_its_own_collapsible_block():
    summary = FeishuToolSummaryStream(include_tool_details=True)
    summary.bind(AsyncMock(return_value=True))

    for call_id, name in (("private-a", "web_search"), ("private-b", "read_page")):
        assert await summary.handle_tool_event({
            "type": "tool_call",
            "tool_call_id": call_id,
            "name": name,
            "label": name,
            "status": "running",
            "input": {"call": call_id},
        })
        assert await summary.handle_tool_event({
            "type": "tool_done",
            "tool_call_id": call_id,
            "name": name,
            "label": name,
            "status": "success",
            "result": {"completed": call_id},
        })

    panels = [
        node for node in _walk_tags(summary.elements())
        if node.get("tag") == "collapsible_panel"
    ]
    assert len(panels) == 2
    assert [panel["header"]["title"]["content"] for panel in panels] == [
        "🛠 web_search",
        "🛠 read_page",
    ]
    panel_text = [
        "\n".join(item["content"] for item in panel["elements"])
        for panel in panels
    ]
    assert "web_search" in panel_text[0] and "read_page" not in panel_text[0]
    assert "read_page" in panel_text[1] and "web_search" not in panel_text[1]
    assert '"completed": "private-a"' in panel_text[0]
    assert '"completed": "private-b"' in panel_text[1]


def test_feishu_tool_detail_policy_keeps_details_private_and_summary_only_in_groups():
    from agent.im.presentation import _create_feishu_tool_summary

    private = _create_feishu_tool_summary("feishu", "p2p", True)
    group = _create_feishu_tool_summary("feishu", "group", True)

    assert private is not None and private.include_tool_details is True
    assert group is not None and group.include_tool_details is False
    assert _create_feishu_tool_summary("qq", "c2c", True) is None
    assert _create_feishu_tool_summary("feishu", "p2p", False) is None


@pytest.mark.asyncio
async def test_private_feishu_keeps_detailed_fallback_if_stream_card_is_unavailable(monkeypatch):
    from agent.im import presentation

    send_tool_event = AsyncMock()
    monkeypatch.setattr("agent.im.replies.send_tool_event", send_tool_event, raising=False)
    summary = FeishuToolSummaryStream(include_tool_details=True)

    async def publish(_event):
        return None

    event = {"type": "tool_call", "tool_call_id": "call-fallback"}
    await presentation.display_tool_event(
        {"platform": "feishu", "chat_type": "p2p"},
        event,
        tool_display_mode="all",
        publish_web_event=publish,
        feishu_tool_summary=summary,
    )

    send_tool_event.assert_awaited_once_with(
        {"platform": "feishu", "chat_type": "p2p"},
        event,
        include_details=True,
    )


@pytest.mark.asyncio
async def test_contiguous_tool_events_share_one_outer_summary_and_text_splits_groups():
    summary = FeishuToolSummaryStream()
    summary.bind(AsyncMock(return_value=True))
    summary.append_text("先查一下。")
    await summary.handle_tool_event({"type": "tool_call", "tool_call_id": "call-a", "name": "search"})
    await summary.handle_tool_event({"type": "tool_done", "tool_call_id": "call-a", "name": "search", "status": "success"})
    await summary.handle_tool_event({"type": "tool_call", "tool_call_id": "call-b", "name": "fetch"})
    await summary.handle_tool_event({"type": "tool_done", "tool_call_id": "call-b", "name": "fetch", "status": "success"})
    summary.append_text("结果如下。")
    await summary.handle_tool_event({"type": "tool_call", "tool_call_id": "call-c", "name": "write"})
    await summary.handle_tool_event({"type": "tool_done", "tool_call_id": "call-c", "name": "write", "status": "success"})

    panels = [node for node in _walk_tags(summary.elements()) if node.get("tag") == "collapsible_panel"]
    assert [panel["header"]["title"]["content"] for panel in panels] == [
        "🛠 工具摘要 (2)",
        "🛠 工具摘要 (1)",
    ]
    markdown = [node["content"] for node in _walk_tags(summary.elements()) if node.get("tag") == "markdown"]
    assert markdown[0] == "先查一下。"
    assert markdown[3] == "结果如下。"


@pytest.mark.asyncio
async def test_cancelled_unfinished_tool_does_not_create_completion_summary():
    summary = FeishuToolSummaryStream()
    summary.bind(AsyncMock(return_value=True))
    await summary.handle_tool_event({
        "type": "tool_call",
        "tool_call_id": "call-cancelled",
        "name": "shell",
        "status": "running",
    })

    summary.finish("", cancelled=True)

    panels = [
        node for node in _walk_tags(summary.elements())
        if node.get("tag") == "collapsible_panel"
    ]
    assert panels == []


@pytest.mark.asyncio
async def test_unbound_summary_allows_existing_tool_message_fallback():
    summary = FeishuToolSummaryStream()

    assert await summary.handle_tool_event({"type": "tool_call", "tool_call_id": "call-c"}) is False


@pytest.mark.asyncio
async def test_tool_display_off_still_mirrors_web_without_sending_im_message(monkeypatch):
    from agent.im import presentation

    send_tool_event = AsyncMock()
    monkeypatch.setattr("agent.im.replies.send_tool_event", send_tool_event, raising=False)
    published = []

    async def publish(event):
        published.append(event)

    event = {"type": "tool_call", "tool_call_id": "call-off"}
    await presentation.display_tool_event(
        {"platform": "feishu"},
        event,
        tool_display_mode="off",
        publish_web_event=publish,
    )

    assert published == [event]
    send_tool_event.assert_not_awaited()


@pytest.mark.asyncio
async def test_enabled_feishu_routes_to_card_after_it_is_bound(monkeypatch):
    from agent.im import presentation

    send_tool_event = AsyncMock()
    monkeypatch.setattr("agent.im.replies.send_tool_event", send_tool_event, raising=False)
    updates = []
    summary = FeishuToolSummaryStream(include_tool_details=True)

    async def write(elements):
        updates.append(elements)
        return True

    summary.bind(write)
    published = []

    async def publish(event):
        published.append(event)

    call_event = {"type": "tool_call", "tool_call_id": "call-on"}
    done_event = {"type": "tool_done", "tool_call_id": "call-on", "status": "success"}
    await presentation.display_tool_event(
        {"platform": "feishu", "chat_type": "p2p"},
        call_event,
        tool_display_mode="all",
        publish_web_event=publish,
        feishu_tool_summary=summary,
    )
    await presentation.display_tool_event(
        {"platform": "feishu", "chat_type": "p2p"},
        done_event,
        tool_display_mode="all",
        publish_web_event=publish,
        feishu_tool_summary=summary,
    )

    assert published == [call_event, done_event]
    send_tool_event.assert_not_awaited()
    assert len(updates) == 2


@pytest.mark.asyncio
async def test_enabled_feishu_uses_existing_tool_message_if_card_was_not_created(monkeypatch):
    from agent.im import presentation

    send_tool_event = AsyncMock()
    monkeypatch.setattr("agent.im.replies.send_tool_event", send_tool_event, raising=False)
    summary = FeishuToolSummaryStream()

    async def publish(_event):
        return None

    event = {"type": "tool_call", "tool_call_id": "call-fallback"}
    await presentation.display_tool_event(
        {"platform": "feishu"},
        event,
        tool_display_mode="all",
        publish_web_event=publish,
        feishu_tool_summary=summary,
    )

    send_tool_event.assert_awaited_once_with({"platform": "feishu"}, event)


@pytest.mark.asyncio
async def test_feishu_tool_summary_stream_interleaves_text_and_tools_with_shared_sequence(monkeypatch):
    from agent.gateway.feishu import streaming as feishu

    monkeypatch.setattr(feishu, "_creds_by_id", lambda _channel_id: _async_value(("app", "secret")))
    monkeypatch.setattr(feishu, "_do_create_card", lambda *_args: _async_value("card-id"))
    monkeypatch.setattr(feishu, "_do_send_card_message", lambda *_args: _async_value(True))
    sequence_calls = []

    async def update_card(*_args, sequence, elements=None, title=None, **_kwargs):
        sequence_calls.append((sequence, title, elements))
        return True

    async def update_text(_app, _secret, _card, content, *, sequence, element_id, **_kwargs):
        sequence_calls.append((sequence, element_id, content))
        return True

    async def finalize(_app, _secret, _card, _text, sequence, uuid):
        sequence_calls.append((sequence, "finalize", None))
        return True

    monkeypatch.setattr(feishu, "_do_update_card", update_card)
    monkeypatch.setattr(feishu, "_do_streaming_update_text", update_text)
    monkeypatch.setattr(feishu, "_do_finalize_streaming_card", finalize)
    summary = FeishuToolSummaryStream(include_tool_details=True)

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
    tool_detail = next(
        node["content"]
        for node in _walk_tags(final_elements)
        if node.get("tag") == "markdown" and "**输入**" in str(node.get("content") or "")
    )
    assert "synthetic query" in tool_detail
    assert "2 results" in tool_detail


@pytest.mark.asyncio
async def test_visible_card_update_failure_does_not_request_duplicate_text_fallback(monkeypatch):
    from agent.gateway.feishu import streaming as feishu

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
    from agent.gateway.feishu import streaming as feishu

    monkeypatch.setattr(feishu, "_creds_by_id", lambda _channel_id: _async_value(("app", "secret")))
    monkeypatch.setattr(feishu, "_do_create_card", lambda *_args: _async_value("card-id"))
    monkeypatch.setattr(feishu, "_do_send_card_message", lambda *_args: _async_value(True))
    updates = []

    async def update_card(*_args, sequence, title=None, **_kwargs):
        updates.append((sequence, title))
        return True

    monkeypatch.setattr(feishu, "_do_update_card", update_card)
    streamed_text = []

    async def update_text(_app, _secret, _card, text, **_kwargs):
        streamed_text.append(text)
        return True

    monkeypatch.setattr(feishu, "_do_streaming_update_text", update_text)
    monkeypatch.setattr(feishu, "_do_finalize_streaming_card", lambda *_args, **_kwargs: _async_value(True))

    updated_before_final = []
    reply_text = "飞书当前轮流式正文应持续更新。" * 8

    async def token_iter():
        yield ("token", reply_text)
        updated_before_final.append(bool(streamed_text))
        yield ("final", AgentResponse(text=reply_text, session_id=20))

    ok, response = await feishu.send_text_stream("receive", token_iter(), channel_id="channel")

    assert ok is True
    assert response.session_id == 20
    assert updated_before_final == [True]
    assert reply_text in streamed_text
    assert len(updates) == 1
    assert updates[0][1] == "咕咕"


@pytest.mark.asyncio
async def test_feishu_stream_shows_mermaid_source_then_replaces_it_in_place(monkeypatch):
    from agent.gateway.feishu import streaming as feishu
    from agent.im import mermaid

    monkeypatch.setattr(feishu, "_creds_by_id", lambda _channel_id: _async_value(("app", "secret")))
    monkeypatch.setattr(feishu, "_do_create_card", lambda *_args: _async_value("card-id"))
    monkeypatch.setattr(feishu, "_do_send_card_message", lambda *_args: _async_value(True))
    monkeypatch.setattr(feishu, "_do_finalize_streaming_card", lambda *_args, **_kwargs: _async_value(True))
    monkeypatch.setattr(feishu, "_upload_mermaid_image", lambda *_args: _async_value("image-key"))

    rendered_sources = []

    async def render(source):
        rendered_sources.append(source)
        return b"synthetic-png"

    monkeypatch.setattr(mermaid, "render_png", render)
    card_updates = []
    stream_updates = []
    timeline = []

    async def update_card(*_args, sequence, elements=None, title=None, **_kwargs):
        card_updates.append((sequence, elements, title))
        if elements and any(element.get("tag") == "img" for element in elements):
            timeline.append("image-replacement")
        return True

    async def update_text(_app, _secret, _card, content, *, sequence, element_id, **_kwargs):
        stream_updates.append((sequence, element_id, content))
        timeline.append(("stream", element_id, content))
        return True

    monkeypatch.setattr(feishu, "_do_update_card", update_card)
    monkeypatch.setattr(feishu, "_do_streaming_update_text", update_text)

    source = "```mermaid\ngraph LR\n  A-->B\n```"
    prefix = "先看这张图：\n"
    suffix = "\n图后继续说明，保持在图片下方持续流式显示。" * 2
    final_text = prefix + source + suffix

    async def token_iter():
        yield ("token", prefix + source)
        yield ("token", suffix)
        yield ("final", AgentResponse(text=final_text, session_id=22))

    ok, response = await feishu.send_text_stream("receive", token_iter(), channel_id="channel")

    assert ok is True
    assert response.session_id == 22
    assert rendered_sources == ["graph LR\n  A-->B\n"]
    assert any(source in content for _sequence, _element_id, content in stream_updates)
    assert timeline.index("image-replacement") > next(
        index for index, event in enumerate(timeline)
        if isinstance(event, tuple) and source in event[2]
    )
    assert timeline.index("image-replacement") < next(
        index for index, event in enumerate(timeline)
        if isinstance(event, tuple) and event[1] == "markdown_2" and suffix in event[2]
    )
    assert any(element_id == "markdown_2" and suffix in content
               for _sequence, element_id, content in stream_updates)
    final_elements = next(elements for _seq, elements, title in reversed(card_updates) if title == "咕咕")
    assert [element["tag"] for element in final_elements] == ["markdown", "img", "markdown"]
    assert source not in "".join(element.get("content", "") for element in final_elements)


def test_tool_summary_can_replace_active_mermaid_source_without_losing_surrounding_text():
    summary = FeishuToolSummaryStream()
    source = "```mermaid\ngraph LR\n  A-->B\n```"
    summary.append_text("图前。" + source)

    assert summary.replace_active_text_with_image(source, "image-key") is True
    summary.append_text("图后。")

    elements = summary.elements()
    assert [element["tag"] for element in elements] == ["markdown", "img", "markdown"]
    assert elements[0]["content"] == "图前。"
    assert elements[1]["img_key"] == "image-key"
    assert "图后。" in elements[2]["content"]


async def _async_value(value):
    return value
