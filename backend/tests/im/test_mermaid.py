import asyncio

import pytest


def test_renderer_does_not_exec_node_when_network_isolation_cannot_be_installed(monkeypatch):
    from agent.im import mermaid

    exec_calls = []
    monkeypatch.setattr(mermaid.shutil, "which", lambda _name: "/usr/bin/node")
    monkeypatch.setattr(mermaid.resource, "setrlimit", lambda *_args: None)

    def fail_closed():
        raise RuntimeError("seccomp_unavailable")

    monkeypatch.setattr(mermaid, "_apply_network_seccomp", fail_closed)
    monkeypatch.setattr(mermaid.os, "execv", lambda *args: exec_calls.append(args))

    with pytest.raises(RuntimeError, match="seccomp_unavailable"):
        mermaid._sandbox_exec("worker.mjs")

    assert exec_calls == []


@pytest.mark.asyncio
async def test_renderer_maps_individual_frames_and_skips_overlong_source(monkeypatch):
    from agent.im import mermaid

    png = b"\x89PNG\r\n\x1a\nvalid"
    frames = len(png).to_bytes(4, "big") + png + (0).to_bytes(4, "big")
    observed = {}

    class FakeProcess:
        returncode = 0

        async def communicate(self, payload):
            observed["payload"] = payload
            return frames, b""

    async def create_process(*_args, **_kwargs):
        return FakeProcess()

    monkeypatch.setattr(mermaid.asyncio, "create_subprocess_exec", create_process)
    sources = ["valid-a", "x" * (mermaid.MAX_SOURCE_CHARS + 1), "valid-c"]

    results = await mermaid.render_pngs(sources)

    assert results == [png, None, None]
    assert observed["payload"] == b'["valid-a", "valid-c"]'


@pytest.mark.asyncio
async def test_renderer_timeout_terminates_child_and_returns_fallback(monkeypatch):
    from agent.im import mermaid

    events = []

    class FakeProcess:
        pid = 456
        returncode = None

        async def communicate(self, _payload):
            await asyncio.sleep(30)

        async def wait(self):
            self.returncode = -9
            events.append("wait")

    async def create_process(*_args, **_kwargs):
        return process

    async def timeout(awaitable, *, timeout):
        events.append(("timeout", timeout))
        awaitable.close()
        raise asyncio.TimeoutError

    process = FakeProcess()
    monkeypatch.setattr(mermaid.asyncio, "create_subprocess_exec", create_process)
    monkeypatch.setattr(mermaid.asyncio, "wait_for", timeout)
    monkeypatch.setattr(mermaid.os, "killpg", lambda pid, signal: events.append((pid, signal)))

    assert await mermaid.render_pngs(["synthetic-source"]) == [None]
    assert events == [("timeout", mermaid.RENDER_TIMEOUT_SECONDS), (456, 9), "wait"]


@pytest.mark.asyncio
async def test_complete_chart_becomes_png_between_surrounding_text(monkeypatch):
    from agent.im import mermaid

    async def fake_render(sources):
        assert sources == ["graph TD; A-->B\n"]
        return [b"\x89PNG\r\n\x1a\nchart"]

    monkeypatch.setattr(mermaid, "render_pngs", fake_render)
    parts = await mermaid.render_reply(
        "图在这里：\n```Mermaid\ngraph TD; A-->B\n```\n总结在这里。"
    )

    assert [(part.text, part.png is not None) for part in parts] == [
        ("图在这里：\n", False),
        ("", True),
        ("\n总结在这里。", False),
    ]


@pytest.mark.asyncio
async def test_incomplete_or_failed_chart_keeps_readable_source(monkeypatch):
    from agent.im import mermaid

    async def fail_render(sources):
        return [None] * len(sources)

    monkeypatch.setattr(mermaid, "render_pngs", fail_render)
    incomplete = "正文\n```mermaid\ngraph TD; A-->B"
    failed = "```mermaid\ngraph TD; A-->B\n```"

    assert [part.text for part in await mermaid.render_reply(incomplete)] == [incomplete]
    assert [part.text for part in await mermaid.render_reply(failed)] == [failed]


@pytest.mark.asyncio
async def test_streaming_renderer_batches_charts_and_caps_them_across_rounds(monkeypatch):
    from agent.im import mermaid

    calls = []

    async def render(sources):
        calls.append(sources)
        return [b"\x89PNG\r\n\x1a\nchart"] * len(sources)

    monkeypatch.setattr(mermaid, "render_pngs", render)
    renderer = mermaid.StreamingRenderer(max_diagrams=mermaid.MAX_DIAGRAMS)
    sources = [f"```mermaid\ngraph TD; A{i}-->B{i}\n```" for i in range(5)]

    streamed = await renderer.feed("前文\n" + "\n".join(sources[:4]) + "\n后文")
    assert calls == []
    assert "```mermaid" not in "".join(part.text for part in streamed)
    assert sum("图表" in part.text for part in streamed) == 4

    rendered = await renderer.finish_round()
    assert len(calls) == 1
    assert len(calls[0]) == 4
    assert len([part for part in rendered if part.png]) == 4

    next_round = await renderer.feed(sources[4])
    assert sources[4] in "".join(part.text for part in next_round)
    assert await renderer.finish_round() == []
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_image_send_failure_falls_back_without_dropping_reply_text(monkeypatch):
    from agent.im import replies, mermaid
    from agent.models import AgentResponse

    sent_text = []

    async def fake_files(_payload, _files):
        class Result:
            failed = False
            reason = None
        return Result()

    async def fake_render(sources):
        return [b"\x89PNG\r\n\x1a\nchart"] * len(sources)

    async def fake_text(_payload, text):
        sent_text.append(text)
        return True

    async def fail_image(_payload, _png):
        raise RuntimeError("synthetic gateway failure")

    monkeypatch.setattr("agent.im.files.send_files", fake_files)
    monkeypatch.setattr(mermaid, "render_pngs", fake_render)
    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr(replies, "send_png_image", fail_image)

    source = "```mermaid\ngraph TD; A-->B\n```"
    result = await replies.send_agent_response(
        {"platform": "telegram", "platform_user_id": "synthetic-recipient"},
        AgentResponse(text=f"前文\n{source}\n后文"),
    )

    assert sent_text == ["前文\n", source, "\n后文"]
    assert result == f"前文\n{source}\n后文"


@pytest.mark.asyncio
async def test_completed_im_round_sends_mermaid_as_independent_image(monkeypatch):
    from agent.im import replies, mermaid

    events = []
    png = b"\x89PNG\r\n\x1a\nchart"
    source = "```mermaid\ngraph LR; A-->B\n```"

    async def fake_render(sources):
        assert sources == ["graph LR; A-->B\n"]
        return [png]

    async def fake_text(_payload, text):
        events.append(("text", text))
        return True

    async def fake_image(_payload, image):
        events.append(("image", image))
        return True

    monkeypatch.setattr(mermaid, "render_pngs", fake_render)
    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr(replies, "send_png_image", fake_image)

    sent = await replies.send_completed_round(
        {"platform": "qq", "platform_user_id": "synthetic-recipient"},
        f"图在这里：\n{source}\n看完告诉我。",
    )

    assert sent is True
    assert events == [
        ("text", "图在这里：\n"),
        ("image", png),
        ("text", "\n看完告诉我。"),
    ]
    assert all(source not in value for kind, value in events if kind == "text")


@pytest.mark.asyncio
@pytest.mark.parametrize("platform", ["feishu", "qq", "telegram", "wechat"])
async def test_png_dispatch_uses_platform_image_gateway(monkeypatch, platform):
    from agent.im import replies

    calls = []

    async def record(*args, **kwargs):
        calls.append((args, kwargs))
        return True

    if platform == "feishu":
        monkeypatch.setattr("agent.gateway.feishu.send_file", record)
    elif platform == "qq":
        monkeypatch.setattr("agent.gateway.qq.send_file", record)
    elif platform == "telegram":
        monkeypatch.setattr("agent.gateway.telegram.send_file", record)
    else:
        monkeypatch.setattr("agent.gateway.wechat.send_image", record)

    payload = {
        "platform": platform,
        "platform_user_id": "synthetic-recipient",
        "chat_id": "synthetic-chat",
        "channel_id": "synthetic-channel",
        "context_token": "synthetic-context",
    }
    png = b"\x89PNG\r\n\x1a\nimage"

    assert await replies.send_png_image(payload, png) is True
    assert calls
    assert any(png in args for args, _kwargs in calls)


@pytest.mark.asyncio
async def test_image_send_preserves_text_image_text_order(monkeypatch):
    from agent.im import replies, mermaid
    from agent.models import AgentResponse

    events = []

    async def fake_files(_payload, _files):
        class Result:
            failed = False
            reason = None
        return Result()

    async def fake_render(sources):
        return [b"\x89PNG\r\n\x1a\nchart"] * len(sources)

    async def fake_text(_payload, text):
        events.append(("text", text))
        return True

    async def fake_image(_payload, png):
        events.append(("image", png))
        return True

    monkeypatch.setattr("agent.im.files.send_files", fake_files)
    monkeypatch.setattr(mermaid, "render_pngs", fake_render)
    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr(replies, "send_png_image", fake_image)

    await replies.send_agent_response(
        {"platform": "telegram", "platform_user_id": "synthetic-recipient"},
        AgentResponse(text="前文\n```mermaid\ngraph TD; A-->B\n```\n后文"),
    )

    assert [kind for kind, _value in events] == ["text", "image", "text"]
    assert events[0][1] == "前文\n"
    assert events[2][1] == "\n后文"


@pytest.mark.asyncio
async def test_qq_stream_holds_split_fence_and_sends_chart_after_safe_text(monkeypatch):
    from agent.gateway import qq
    from agent.im import replies, mermaid
    from agent.models import AgentResponse

    events = []

    class FakeStream:
        def __init__(self):
            self.text = ""

        def push(self, text):
            self.text += text

        async def finish(self, text):
            events.append(("text", text))

        def has_sent(self):
            return bool(self.text)

    monkeypatch.setattr(qq, "create_private_text_stream", lambda *_args, **_kwargs: FakeStream())

    async def fake_render(sources):
        return [b"\x89PNG\r\n\x1a\nchart"] * len(sources)

    async def send_image(_payload, _png):
        events.append(("image", "png"))
        return True

    monkeypatch.setattr(mermaid, "render_pngs", fake_render)
    monkeypatch.setattr(replies, "send_png_image", send_image)

    chart = "```mermaid\ngraph TD; A-->B\n```"
    full_text = f"前文\n{chart}\n后文"

    async def token_iter():
        yield ("token", "前文\n```mer")
        yield ("token", "maid\ngraph TD; A-->B\n```\n后文")
        yield ("final", AgentResponse(text=full_text, session_id=7))

    sent, response, last_text = await replies.send_qq_stream_by_round(
        {"platform": "qq", "platform_user_id": "synthetic-recipient", "channel_id": "test"},
        token_iter(),
    )

    assert sent is True
    assert response.session_id == 7
    assert last_text == full_text
    assert events[0][0] == "text"
    assert "```mermaid" not in events[0][1]
    assert "图表 1 见后续图片" in events[0][1]
    assert events[1] == ("image", "png")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("upload_key", "card_update_ok"),
    [("img_v2_test", True), ("img_v2_test", False), (None, True)],
)
async def test_feishu_stream_embeds_rendered_mermaid_in_final_card(
    monkeypatch, upload_key, card_update_ok,
):
    from agent.gateway.feishu import messages, streaming as feishu
    from agent.im import mermaid
    from agent.models import AgentResponse

    events = []
    monkeypatch.setattr(feishu, "_creds_by_id", lambda _channel: _async_value(("app", "secret")))
    monkeypatch.setattr(feishu, "_do_create_card", lambda *_args: _async_value("card-id"))
    monkeypatch.setattr(feishu, "_do_send_card_message", lambda *_args: _async_value(True))

    async def update_text(_app, _secret, _card, content, **_kwargs):
        events.append(("update", content))
        return True

    async def finalize(_app, _secret, _card, _text, *_args, **_kwargs):
        events.append(("finalize", "card"))
        return True

    async def update_card(_app, _secret, _card, _text, **_kwargs):
        events.append(("card-update", _kwargs.get("elements")))
        return card_update_ok

    async def render(_source):
        return b"\x89PNG\r\n\x1a\nchart"

    async def send_file(*_args, **_kwargs):
        events.append(("image", "png"))
        return True

    async def upload_image(_png, _channel):
        events.append(("upload", "png"))
        return upload_key

    monkeypatch.setattr(feishu, "_do_streaming_update_text", update_text)
    monkeypatch.setattr(feishu, "_do_finalize_streaming_card", finalize)
    monkeypatch.setattr(feishu, "_do_update_card", update_card)
    monkeypatch.setattr(mermaid, "render_png", render)
    monkeypatch.setattr(messages, "send_file", send_file)
    monkeypatch.setattr(messages, "upload_image", upload_image)

    chart = "```mermaid\ngraph TD; A-->B\n```"
    full_text = f"前文\n{chart}\n后文"

    async def token_iter():
        yield ("token", "前文\n```mer")
        yield ("token", "maid\ngraph TD; A-->B\n```\n后文")
        yield ("final", AgentResponse(text=full_text, session_id=22))

    ok, response = await feishu.send_text_stream(
        "receive", token_iter(), channel_id="channel",
    )

    assert ok is True
    assert response.session_id == 22
    assert chart in response.text
    assert any(kind == "upload" for kind, _value in events)
    card_update = next(event for event in events if event[0] == "card-update")
    if upload_key:
        elements = card_update[1]
        assert [element["tag"] for element in elements] == ["markdown", "img", "markdown"]
        assert elements[1]["img_key"] == upload_key
        assert "前文" in elements[0]["content"]
        assert "后文" in elements[2]["content"]
    else:
        assert card_update[1] is None
    assert any(kind == "image" for kind, _value in events) == (not (card_update_ok and upload_key))
    assert any(chart in value for kind, value in events if kind == "update")


@pytest.mark.asyncio
async def test_feishu_tool_summary_card_keeps_mermaid_image_in_reply_order(monkeypatch):
    from agent.gateway.feishu import messages, streaming as feishu
    from agent.gateway.feishu.tool_summary import FeishuToolSummaryStream
    from agent.im import mermaid
    from agent.models import AgentResponse

    final_card = {}
    monkeypatch.setattr(feishu, "_creds_by_id", lambda _channel: _async_value(("app", "secret")))
    monkeypatch.setattr(feishu, "_do_create_card", lambda *_args: _async_value("card-id"))
    monkeypatch.setattr(feishu, "_do_send_card_message", lambda *_args: _async_value(True))

    async def update_card(*_args, elements=None, **_kwargs):
        final_card["elements"] = elements
        return True

    async def update_text(*_args, **_kwargs):
        return True

    async def finalize(*_args, **_kwargs):
        return True

    async def render(_source):
        return b"\x89PNG\r\n\x1a\nchart"

    async def upload_image(_png, _channel):
        return "img_v2_summary"

    async def send_file(*_args, **_kwargs):
        pytest.fail("successfully embedded Mermaid must not be sent as a second message")

    monkeypatch.setattr(feishu, "_do_update_card", update_card)
    monkeypatch.setattr(feishu, "_do_streaming_update_text", update_text)
    monkeypatch.setattr(feishu, "_do_finalize_streaming_card", finalize)
    monkeypatch.setattr(mermaid, "render_png", render)
    monkeypatch.setattr(messages, "upload_image", upload_image)
    monkeypatch.setattr(messages, "send_file", send_file)

    chart = "```mermaid\ngraph LR; A-->B\n```"
    text = f"工具前的正文\n{chart}\n工具后的正文"
    summary = FeishuToolSummaryStream()

    async def token_iter():
        yield ("token", text)
        yield ("final", AgentResponse(text=text, session_id=23))

    ok, response = await feishu.send_text_stream(
        "receive", token_iter(), channel_id="channel", tool_summary=summary,
    )

    assert ok is True
    assert response.session_id == 23
    elements = final_card["elements"]
    assert [element["tag"] for element in elements] == ["markdown", "img", "markdown"]
    assert elements[1]["img_key"] == "img_v2_summary"
    assert "工具前的正文" in elements[0]["content"]
    assert "工具后的正文" in elements[2]["content"]


async def _async_value(value):
    return value
