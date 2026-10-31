import asyncio
import json

import pytest


def test_renderer_does_not_exec_node_when_network_isolation_cannot_be_installed(monkeypatch):
    from agent.im import chart

    exec_calls = []
    monkeypatch.setattr(chart.shutil, "which", lambda _name: "/usr/bin/node")
    monkeypatch.setattr(chart.resource, "setrlimit", lambda *_args: None)

    def fail_closed():
        raise RuntimeError("seccomp_unavailable")

    monkeypatch.setattr(chart, "_apply_network_seccomp", fail_closed)
    monkeypatch.setattr(chart.os, "execv", lambda *args: exec_calls.append(args))

    with pytest.raises(RuntimeError, match="seccomp_unavailable"):
        chart._sandbox_exec("worker.mjs")

    assert exec_calls == []


@pytest.mark.asyncio
async def test_renderer_maps_individual_frames_and_skips_overlong_source(monkeypatch):
    from agent.im import chart

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

    monkeypatch.setattr(chart.asyncio, "create_subprocess_exec", create_process)
    sources = [("mermaid", "valid-a"), ("mermaid", "x" * (chart.MAX_SOURCE_CHARS + 1)), ("mermaid", "valid-c")]

    results = await chart.render_chart_pngs(sources)

    assert results == [png, None, None]
    assert json.loads(observed["payload"]) == {
        "charts": [{"type": "mermaid", "source": "valid-a"}, {"type": "mermaid", "source": "valid-c"}],
        "theme": {},
    }


@pytest.mark.asyncio
async def test_renderer_accepts_four_diagrams_in_one_reply(monkeypatch):
    from agent.im import chart

    png = b"\x89PNG\r\n\x1a\nvalid"
    frames = b"".join(len(png).to_bytes(4, "big") + png for _ in range(4))
    observed = {}

    class FakeProcess:
        returncode = 0

        async def communicate(self, payload):
            observed["payload"] = payload
            return frames, b""

    async def create_process(*_args, **_kwargs):
        return FakeProcess()

    monkeypatch.setattr(chart.asyncio, "create_subprocess_exec", create_process)
    sources = [("mermaid", f"synthetic-chart-{index}") for index in range(4)]

    results = await chart.render_chart_pngs(sources)

    assert results == [png] * 4
    assert json.loads(observed["payload"]) == {
        "charts": [{"type": chart_type, "source": source} for chart_type, source in sources],
        "theme": {},
    }


@pytest.mark.asyncio
async def test_renderer_timeout_terminates_child_and_returns_fallback(monkeypatch):
    from agent.im import chart

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
    monkeypatch.setattr(chart.asyncio, "create_subprocess_exec", create_process)
    monkeypatch.setattr(chart.asyncio, "wait_for", timeout)
    monkeypatch.setattr(chart.os, "killpg", lambda pid, signal: events.append((pid, signal)))

    assert await chart.render_chart_pngs([("mermaid", "synthetic-source")]) == [None]
    assert events == [("timeout", chart.RENDER_TIMEOUT_SECONDS), (456, 9), "wait"]


@pytest.mark.asyncio
async def test_complete_chart_becomes_png_between_surrounding_text(monkeypatch):
    from agent.im import chart

    async def fake_render(sources):
        assert sources == [("mermaid", "graph TD; A-->B\n")]
        return [b"\x89PNG\r\n\x1a\nchart"]

    monkeypatch.setattr(chart, "render_chart_pngs", fake_render)
    parts = await chart.render_chart_reply(
        "图在这里：\n```Mermaid\ngraph TD; A-->B\n```\n总结在这里。"
    )

    assert [(part.text, part.png is not None) for part in parts] == [
        ("图在这里：\n", False),
        ("", True),
        ("\n总结在这里。", False),
    ]


@pytest.mark.asyncio
async def test_incomplete_or_failed_chart_keeps_readable_source(monkeypatch):
    from agent.im import chart

    async def fail_render(sources):
        return [None] * len(sources)

    monkeypatch.setattr(chart, "render_chart_pngs", fail_render)
    incomplete = "正文\n```mermaid\ngraph TD; A-->B"
    failed = "```mermaid\ngraph TD; A-->B\n```"

    assert [part.text for part in await chart.render_chart_reply(incomplete)] == [incomplete]
    assert [part.text for part in await chart.render_chart_reply(failed)] == [failed]


@pytest.mark.asyncio
async def test_streaming_renderer_batches_more_than_one_batch_across_rounds(monkeypatch):
    from agent.im import chart

    calls = []

    async def render(sources):
        calls.append(sources)
        return [b"\x89PNG\r\n\x1a\nchart"] * len(sources)

    monkeypatch.setattr(chart, "render_chart_pngs", render)
    renderer = chart.StreamingChartRenderer(max_charts=None)
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
    assert sources[4] not in "".join(part.text for part in next_round)
    next_rendered = await renderer.finish_round()
    assert len(calls) == 2
    assert [len(batch) for batch in calls] == [4, 1]
    assert len([part for part in next_rendered if part.png]) == 1


@pytest.mark.asyncio
async def test_run_queued_diagrams_keep_text_streaming_and_render_one_at_a_time(monkeypatch):
    from agent.im import chart

    calls = []
    png = b"\x89PNG\r\n\x1a\nchart"

    async def render(sources):
        calls.append(sources)
        return [png] * len(sources)

    monkeypatch.setattr(chart, "render_chart_pngs", render)
    renderer = chart.StreamingChartRenderer(max_charts=None, inline_images=False)
    sources = [f"```mermaid\ngraph LR; A{index}-->B{index}\n```" for index in range(6)]

    streamed = await renderer.feed("前文\n" + "\n".join(sources) + "\n后文继续生成一些文字。")
    streamed.extend(await renderer.feed("现在继续输出下一段正文内容。"))
    assert calls == []
    assert "后文继续生成一些文字。" in "".join(part.text for part in streamed)
    streamed_text = "".join(part.text for part in streamed)
    assert all(source not in streamed_text for source in sources)

    await renderer.finish_round(defer_images=True)
    assert calls == []
    images = await renderer.render_deferred_charts()

    assert [len(batch) for batch in calls] == [1] * len(sources)
    assert len([part for part in images if part.png]) == len(sources)
    fallback_text = "".join(part.text for part in streamed + images if part.text)
    assert not any(source in fallback_text for source in sources)


@pytest.mark.asyncio
async def test_progressive_mermaid_render_queue_does_not_pause_stream_tokens(monkeypatch):
    from agent.im import chart

    render_started = asyncio.Event()
    release_render = asyncio.Event()
    render_finished = asyncio.Event()
    png = b"\x89PNG\r\n\x1a\nchart"

    async def render(_chart_type, source):
        render_started.set()
        await release_render.wait()
        render_finished.set()
        return png

    monkeypatch.setattr(chart, "render_chart_png", render)
    source = "```mermaid\ngraph LR; A-->B\n```"
    seen = []

    async def token_iter():
        yield ("token", source)
        await render_started.wait()
        assert not render_finished.is_set()
        yield ("token", "后续文字仍然继续流出。")
        assert not render_finished.is_set()
        release_render.set()
        yield ("final", object())

    async for event in chart.ProgressiveChartTokenFilter().events(token_iter()):
        seen.append(event)

    assert seen[0] == ("chart_pending", (1, source))
    assert "".join(value for kind, value in seen if kind == "token") == "后续文字仍然继续流出。"
    assert [kind for kind, _payload in seen].index("chart_image") < len(seen) - 1
    image = next(value for kind, value in seen if kind == "chart_image")
    assert image[2:] == (source, png)
    assert seen[-1][0] == "final"


@pytest.mark.asyncio
async def test_progressive_mermaid_queue_has_no_total_chart_limit(monkeypatch):
    from agent.im import chart

    rendered = []

    async def render(_chart_type, source):
        rendered.append(source)
        return b"\x89PNG\r\n\x1a\nchart"

    monkeypatch.setattr(chart, "render_chart_png", render)
    sources = [f"```mermaid\ngraph LR; A{index}-->B{index}\n```" for index in range(5)]
    text = "\n".join(sources)

    async def token_iter():
        yield ("token", text)
        yield ("final", object())

    events = [
        event async for event in chart.ProgressiveChartTokenFilter().events(token_iter())
    ]

    assert len(rendered) == len(sources)
    assert sum(kind == "chart_image" for kind, _payload in events) == len(sources)
    assert sum(kind == "chart_pending" for kind, _payload in events) == len(sources)
    assert not any(source in "".join(value for kind, value in events if kind == "token") for source in sources)


@pytest.mark.asyncio
async def test_inline_streaming_renderer_keeps_images_between_text_segments(monkeypatch):
    from agent.im import chart

    pngs = [b"\x89PNG\r\n\x1a\nchart-1", b"\x89PNG\r\n\x1a\nchart-2"]

    async def render(sources):
        assert sources == [
            ("mermaid", "graph TD; A-->B\n"),
            ("mermaid", "graph TD; B-->C\n"),
        ]
        return pngs

    monkeypatch.setattr(chart, "render_chart_pngs", render)
    renderer = chart.StreamingChartRenderer(inline_images=True)
    source_a = "```mermaid\ngraph TD; A-->B\n```"
    source_b = "```mermaid\ngraph TD; B-->C\n```"

    prefix = await renderer.feed(f"前文\n{source_a}\n中间文字\n{source_b}\n后文")
    suffix = await renderer.finish_round()

    assert [(bool(part.text), bool(part.png)) for part in prefix + suffix] == [
        (True, False), (False, True), (True, False), (False, True), (True, False),
    ]
    assert [part.text for part in prefix + suffix if part.text] == [
        "前文\n", "\n中间文字\n", "\n后文",
    ]
    assert [part.png for part in prefix + suffix if part.png] == pngs


@pytest.mark.asyncio
async def test_image_send_failure_falls_back_without_dropping_reply_text(monkeypatch):
    from agent.im import replies, chart
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
    monkeypatch.setattr(chart, "render_chart_pngs", fake_render)
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
    from agent.im import replies, chart

    events = []
    png = b"\x89PNG\r\n\x1a\nchart"
    source = "```mermaid\ngraph LR; A-->B\n```"

    async def fake_render(sources):
        assert sources == [("mermaid", "graph LR; A-->B\n")]
        return [png]

    async def fake_text(_payload, text):
        events.append(("text", text))
        return True

    async def fake_image(_payload, image):
        events.append(("image", image))
        return True

    monkeypatch.setattr(chart, "render_chart_pngs", fake_render)
    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr(replies, "send_png_image", fake_image)

    sent = await replies.send_completed_round(
        {"platform": "qq", "platform_user_id": "synthetic-recipient"},
        f"图在这里：\n{source}\n看完告诉我。",
    )

    assert sent is True
    assert [kind for kind, _value in events] == ["text", "image", "text"]
    assert "图在这里：" in events[0][1]
    assert events[1] == ("image", png)
    assert "看完告诉我。" in events[2][1]
    assert all(source not in value for kind, value in events if kind == "text")


@pytest.mark.asyncio
async def test_qq_completed_round_keeps_trailing_text_together_after_mermaid(monkeypatch):
    from agent.im import chart, replies

    events = []
    png = b"\x89PNG\r\n\x1a\nchart"
    source = "```mermaid\ngraph LR; A-->B\n```"
    trailing_text = "最后这段文字用于验证解析器暂存的末尾内容仍和正文发在同一条消息里。"

    async def fake_render(sources):
        assert sources == [("mermaid", "graph LR; A-->B\n")]
        return [png]

    async def fake_text(_payload, text):
        events.append(("text", text))
        return True

    async def fake_image(_payload, image):
        events.append(("image", image))
        return True

    monkeypatch.setattr(chart, "render_chart_pngs", fake_render)
    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr(replies, "send_png_image", fake_image)

    sent = await replies.send_completed_round(
        {"platform": "qq", "platform_user_id": "synthetic-recipient"},
        f"图前说明。\n{source}\n{trailing_text}",
    )

    assert sent is True
    assert [kind for kind, _value in events] == ["text", "image", "text"]
    assert events[1] == ("image", png)
    assert events[2][1] == trailing_text


@pytest.mark.asyncio
async def test_qq_completed_round_sends_all_rendered_charts(monkeypatch):
    from agent.im import chart, replies

    sent = []
    png = b"\x89PNG\r\n\x1a\nchart"
    sources = [f"```mermaid\ngraph LR; A{index}-->B{index}\n```" for index in range(6)]

    batches = []

    async def render(charts):
        batches.append(charts)
        return [png] * len(charts)

    async def send_image(_payload, image):
        sent.append(image)
        return True

    async def send_text(_payload, _text):
        sent.append(_text)
        return True

    monkeypatch.setattr(chart, "render_chart_pngs", render)
    monkeypatch.setattr(replies, "_try_send_png_image", send_image)
    monkeypatch.setattr(replies, "send_text", send_text)

    result = await replies.send_completed_round(
        {
            "platform": "qq",
            "platform_user_id": "synthetic-recipient",
            "message_id": "synthetic-message",
        },
        "\n".join(sources),
    )

    assert result is True
    assert [len(batch) for batch in batches] == [4, 2]
    assert sum(item == png for item in sent) == len(sources)
    fallback_text = "".join(item for item in sent if isinstance(item, str))
    assert not any(source in fallback_text for source in sources)


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
async def test_qq_mermaid_image_always_uses_active_send(monkeypatch):
    from agent.im import replies

    calls = []

    async def record(*args, **kwargs):
        calls.append((args, kwargs))
        return True

    monkeypatch.setattr("agent.gateway.qq.send_file", record)
    payload = {
        "platform": "qq",
        "chat_type": "private",
        "platform_user_id": "synthetic-recipient",
        "channel_id": "synthetic-channel",
        "message_id": "synthetic-message",
    }

    assert await replies.send_png_image(payload, b"png") is True
    assert calls[0][0][5] is None


@pytest.mark.asyncio
async def test_qq_completed_mermaid_text_without_inbound_message_uses_active_send(
    monkeypatch,
):
    from agent.im import chart, replies

    sent = []

    async def fake_text(payload, text):
        sent.append((payload, text))
        return True

    async def failed_render(sources):
        return [None] * len(sources)

    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr(chart, "render_chart_pngs", failed_render)
    diagrams = [f"```mermaid\ngraph TD; A{index}-->B{index}\n```" for index in range(1, 8)]
    text = "\n".join(diagrams)
    payload = {
        "platform": "qq",
        "platform_user_id": "synthetic-recipient",
        "message_id": None,
    }

    assert await replies.send_completed_round(payload, text) is True
    assert sent
    assert all(message_payload["message_id"] is None for message_payload, _ in sent)
    delivered_text = "\n".join(part for _, part in sent)
    assert all(diagram in delivered_text for diagram in diagrams)


@pytest.mark.asyncio
async def test_qq_stream_mermaid_fallback_and_following_text_survive_without_message_id(
    monkeypatch,
):
    from agent.gateway import qq
    from agent.im import chart, replies

    active_payloads = []
    streams = []

    class FakeStream:
        def __init__(self, message_id):
            self.message_id = message_id
            self.text = ""

        def push(self, text):
            self.text += text

        async def finish(self, text, **_kwargs):
            self.text = text

        def has_sent(self):
            return bool(self.text)

    def create_stream(_recipient, **kwargs):
        stream = FakeStream(kwargs.get("message_id"))
        streams.append(stream)
        return stream

    async def reject_image(_payload, _png):
        return False

    async def capture_text(payload, text):
        active_payloads.append((payload, text))
        return True

    monkeypatch.setattr(qq, "create_private_text_stream", create_stream)
    monkeypatch.setattr(replies, "_try_send_png_image", reject_image)
    monkeypatch.setattr(replies, "send_text", capture_text)
    payload = {
        "platform": "qq",
        "platform_user_id": "synthetic-recipient",
        "channel_id": "synthetic-channel",
        "message_id": None,
    }
    sender = replies._QQChartRound(payload, show_intermediate_replies=True)
    fallback_source = "```mermaid\ngraph TD; A-->B\n```"

    await sender._emit_parts([
        chart.ReplyPart(png=b"png", source=fallback_source),
        chart.ReplyPart(text="后续正文"),
    ])
    await sender._finish_text_segment()

    assert len(active_payloads) == 2
    assert all(payload["message_id"] is None for payload, _text in active_payloads)
    assert active_payloads[0][1] == fallback_source
    assert active_payloads[1][1] == "后续正文"
    assert streams == []


@pytest.mark.asyncio
async def test_image_send_preserves_text_image_text_order(monkeypatch):
    from agent.im import replies, chart
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
    monkeypatch.setattr(chart, "render_chart_pngs", fake_render)
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
async def test_qq_stream_preserves_text_image_text_order_after_deferred_render(monkeypatch):
    from agent.gateway import qq
    from agent.im import replies, chart
    from agent.models import AgentResponse

    events = []

    class FakeStream:
        def __init__(self):
            self.text = ""

        def push(self, text):
            self.text += text

        async def finish(self, text, **_kwargs):
            events.append(("text", text))

        def has_sent(self):
            return bool(self.text)

    monkeypatch.setattr(qq, "create_private_text_stream", lambda *_args, **_kwargs: FakeStream())

    async def fake_render(_chart_type, _source):
        return b"\x89PNG\r\n\x1a\nchart"

    async def send_image(_payload, _png):
        events.append(("image", "png"))
        return True

    monkeypatch.setattr(chart, "render_chart_png", fake_render)
    monkeypatch.setattr(replies, "_try_send_png_image", send_image)

    chart = "```mermaid\ngraph TD; A-->B\n```"
    full_text = f"前文\n\n{chart}\n\n后文"

    async def token_iter():
        yield ("token", "前文\n```mer")
        yield ("token", "maid\ngraph TD; A-->B\n```\n后文")
        yield ("final", AgentResponse(text=full_text, session_id=7))

    sent, response, last_text = await replies.send_qq_stream_by_round(
        {
            "platform": "qq", "platform_user_id": "synthetic-recipient",
            "channel_id": "synthetic-channel", "message_id": "synthetic-message",
        },
        token_iter(),
    )

    assert sent is True
    assert response.session_id == 7
    assert last_text == full_text
    assert [kind for kind, _value in events] == ["text", "image", "text"]
    assert events[0][1] == "前文"
    assert events[1] == ("image", "png")
    assert events[2][1] == "后文"


@pytest.mark.asyncio
async def test_qq_streaming_facade_keeps_text_image_text_order(monkeypatch):
    """保护 replies 门面与抽出的 QQ 状态机之间的实际图文发送契约。"""
    from agent.gateway import qq
    from agent.im import chart, replies
    from agent.models import AgentResponse

    events = []

    class FakeStream:
        def __init__(self):
            self.text = ""

        def push(self, text):
            self.text += text

        async def finish(self, text, **_kwargs):
            events.append(("text", text))

        def has_sent(self):
            return bool(self.text)

    class EventPassthroughFilter:
        def __init__(self, **_kwargs):
            pass

        async def events(self, source):
            async for event in source:
                yield event

        async def ordered_events(self, source):
            async for event in source:
                yield event

    monkeypatch.setattr(qq, "create_private_text_stream", lambda *_args, **_kwargs: FakeStream())
    monkeypatch.setattr(chart, "ProgressiveChartTokenFilter", EventPassthroughFilter)

    async def send_image(_payload, _png):
        events.append(("image", "png"))
        return True

    monkeypatch.setattr(replies, "send_png_image", send_image)
    source = "```mermaid\ngraph LR; A-->B\n```"

    async def token_iter():
        yield ("token", "前文\n")
        yield ("chart_image", (0, 1, source, b"png"))
        yield ("token", "\n后文")
        yield ("final", AgentResponse(text=f"前文\n{source}\n后文"))

    sent, _response, _last_text = await replies.send_qq_stream_by_round(
        {
            "platform": "qq",
            "platform_user_id": "synthetic-recipient",
            "channel_id": "synthetic-channel",
            "message_id": "synthetic-message",
        },
        token_iter(),
    )

    assert sent is True
    assert events == [("text", "前文"), ("image", "png"), ("text", "后文")]


@pytest.mark.asyncio
async def test_qq_stream_sends_each_round_once_in_separate_streams(monkeypatch):
    from agent.gateway import qq
    from agent.im import chart, replies
    from agent.interactions.events import ROUND_END
    from agent.models import AgentResponse

    streams = []

    class FakeStream:
        def __init__(self):
            self.text = ""
            self.finished = []
            streams.append(self)

        def push(self, text):
            self.text += text

        async def finish(self, text, **_kwargs):
            self.finished.append(text)

        def has_sent(self):
            return bool(self.text)

    class EventPassthroughFilter:
        def __init__(self, **_kwargs):
            pass

        async def ordered_events(self, source):
            async for event in source:
                yield event

    monkeypatch.setattr(qq, "create_private_text_stream", lambda *_args, **_kwargs: FakeStream())
    monkeypatch.setattr(chart, "ProgressiveChartTokenFilter", EventPassthroughFilter)

    async def token_iter():
        yield ("token", "前置说明")
        yield (ROUND_END, "前置说明")
        yield ("token", "最终回复")
        yield (ROUND_END, "最终回复")
        yield ("final", AgentResponse(text="最终回复", round_texts=["前置说明", "最终回复"]))

    sent, _response, _text = await replies.send_qq_stream_by_round(
        {
            "platform": "qq",
            "platform_user_id": "synthetic-recipient",
            "channel_id": "synthetic-channel",
            "message_id": "synthetic-message",
        },
        token_iter(),
    )

    assert sent is True
    assert len(streams) == 2
    delivered_text = [text for stream in streams for text in stream.finished]
    assert delivered_text == ["前置说明", "最终回复"]


@pytest.mark.asyncio
@pytest.mark.parametrize("show_intermediate_replies", [False, True])
async def test_qq_stream_sends_all_run_images_without_total_chart_cap(
    monkeypatch, show_intermediate_replies,
):
    from agent.gateway import qq
    from agent.im import chart, replies
    from agent.models import AgentResponse

    events = []
    rendered_sources = []
    png = b"\x89PNG\r\n\x1a\nchart"
    sources = [f"```mermaid\ngraph LR; A{index}-->B{index}\n```" for index in range(6)]
    final_text = f"前文\n{sources[0]}\n中间说明\n" + "\n".join(sources[1:]) + "\n后文"

    class FakeStream:
        def __init__(self):
            self.text = ""

        def push(self, text):
            self.text += text

        async def finish(self, text, **_kwargs):
            self.text = text
            events.append(("text", text))

        def has_sent(self):
            return bool(self.text)

    async def render(_chart_type, source):
        rendered_sources.append(source)
        return png

    async def send_image(_payload, _png):
        events.append(("image", "png"))
        return True

    monkeypatch.setattr(qq, "create_private_text_stream", lambda *_args, **_kwargs: FakeStream())
    monkeypatch.setattr(chart, "render_chart_png", render)
    monkeypatch.setattr(replies, "_try_send_png_image", send_image)

    async def token_iter():
        yield ("token", final_text)
        yield ("final", AgentResponse(text=final_text))

    sent, _response, _last_text = await replies.send_qq_stream_by_round(
        {
            "platform": "qq",
            "platform_user_id": "synthetic-recipient",
            "message_id": "synthetic-message",
        },
        token_iter(),
        show_intermediate_replies=show_intermediate_replies,
    )

    assert sent is True
    assert len(rendered_sources) == len(sources)
    assert rendered_sources == [source.splitlines()[1] + "\n" for source in sources]
    assert [kind for kind, _value in events] == ["text", "image", "text"] + ["image"] * 5 + ["text"]
    assert events[0][1] == "前文"
    assert events[1] == ("image", "png")
    assert events[2][1] == "中间说明"
    assert events[-1][1].endswith("后文")
    text_output = "".join(value for kind, value in events if kind == "text")
    assert not any(source in text_output for source in sources)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("upload_key", "card_update_ok"),
    [("img_v2_test", True), ("img_v2_test", False), (None, True)],
)
async def test_feishu_stream_embeds_rendered_mermaid_in_final_card(
    monkeypatch, upload_key, card_update_ok,
):
    from agent.gateway.feishu import messages, streaming as feishu
    from agent.im import chart
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

    async def render(_chart_type, _source):
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
    monkeypatch.setattr(chart, "render_chart_png", render)
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
    from agent.im import chart
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

    async def render(_chart_type, _source):
        return b"\x89PNG\r\n\x1a\nchart"

    async def upload_image(_png, _channel):
        return "img_v2_summary"

    async def send_file(*_args, **_kwargs):
        pytest.fail("successfully embedded Mermaid must not be sent as a second message")

    monkeypatch.setattr(feishu, "_do_update_card", update_card)
    monkeypatch.setattr(feishu, "_do_streaming_update_text", update_text)
    monkeypatch.setattr(feishu, "_do_finalize_streaming_card", finalize)
    monkeypatch.setattr(chart, "render_chart_png", render)
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
