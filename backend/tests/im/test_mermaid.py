import asyncio
import json

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
    assert json.loads(observed["payload"]) == {
        "sources": ["valid-a", "valid-c"],
        "theme": {},
    }


@pytest.mark.asyncio
async def test_renderer_accepts_four_diagrams_in_one_reply(monkeypatch):
    from agent.im import mermaid

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

    monkeypatch.setattr(mermaid.asyncio, "create_subprocess_exec", create_process)
    sources = [f"synthetic-chart-{index}" for index in range(4)]

    results = await mermaid.render_pngs(sources)

    assert results == [png] * 4
    assert json.loads(observed["payload"]) == {
        "sources": sources,
        "theme": {},
    }


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
async def test_run_queued_diagrams_keep_text_streaming_and_render_one_at_a_time(monkeypatch):
    from agent.im import mermaid

    calls = []
    png = b"\x89PNG\r\n\x1a\nchart"

    async def render(sources):
        calls.append(sources)
        return [png] * len(sources)

    monkeypatch.setattr(mermaid, "render_pngs", render)
    renderer = mermaid.StreamingRenderer(
        max_diagrams=mermaid.MAX_RUN_DIAGRAMS,
        inline_images=False,
    )
    sources = [f"```mermaid\ngraph LR; A{index}-->B{index}\n```" for index in range(6)]

    streamed = await renderer.feed("前文\n" + "\n".join(sources) + "\n后文继续生成一些文字。")
    streamed.extend(await renderer.feed("现在继续输出下一段正文内容。"))
    assert calls == []
    assert "后文继续生成一些文字。" in "".join(part.text for part in streamed)
    streamed_text = "".join(part.text for part in streamed)
    assert all(source not in streamed_text for source in sources[:mermaid.MAX_RUN_DIAGRAMS])
    assert all(source in streamed_text for source in sources[mermaid.MAX_RUN_DIAGRAMS:])

    await renderer.finish_round(defer_images=True)
    assert calls == []
    images = await renderer.render_deferred_diagrams()

    assert [len(batch) for batch in calls] == [1] * mermaid.MAX_RUN_DIAGRAMS
    assert len([part for part in images if part.png]) == mermaid.MAX_RUN_DIAGRAMS
    fallback_text = "".join(part.text for part in streamed + images if part.text)
    assert sources[4] in fallback_text
    assert sources[5] in fallback_text


@pytest.mark.asyncio
async def test_progressive_mermaid_render_queue_does_not_pause_stream_tokens(monkeypatch):
    from agent.im import mermaid

    render_started = asyncio.Event()
    release_render = asyncio.Event()
    render_finished = asyncio.Event()
    png = b"\x89PNG\r\n\x1a\nchart"

    async def render(source):
        render_started.set()
        await release_render.wait()
        render_finished.set()
        return png

    monkeypatch.setattr(mermaid, "render_png", render)
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

    async for event in mermaid.ProgressiveMermaidTokenFilter().events(token_iter()):
        seen.append(event)

    assert [kind for kind, _payload in seen] == ["token", "token", "mermaid_image", "final"]
    assert seen[1][1] == "后续文字仍然继续流出。"
    assert seen[2][1][2:] == (source, png)


@pytest.mark.asyncio
async def test_progressive_mermaid_queue_uses_shared_four_chart_run_budget(monkeypatch):
    from agent.im import mermaid

    rendered = []

    async def render(source):
        rendered.append(source)
        return b"\x89PNG\r\n\x1a\nchart"

    monkeypatch.setattr(mermaid, "render_png", render)
    sources = [f"```mermaid\ngraph LR; A{index}-->B{index}\n```" for index in range(5)]
    text = "\n".join(sources)

    async def token_iter():
        yield ("token", text)
        yield ("final", object())

    events = [
        event async for event in mermaid.ProgressiveMermaidTokenFilter().events(token_iter())
    ]

    assert len(rendered) == mermaid.MAX_RUN_DIAGRAMS == 4
    assert sum(kind == "mermaid_image" for kind, _payload in events) == 4
    assert events[0] == ("token", text)
    assert sources[4] in events[0][1]


@pytest.mark.asyncio
async def test_inline_streaming_renderer_keeps_images_between_text_segments(monkeypatch):
    from agent.im import mermaid

    pngs = [b"\x89PNG\r\n\x1a\nchart-1", b"\x89PNG\r\n\x1a\nchart-2"]

    async def render(sources):
        assert sources == ["graph TD; A-->B\n", "graph TD; B-->C\n"]
        return pngs

    monkeypatch.setattr(mermaid, "render_pngs", render)
    renderer = mermaid.StreamingRenderer(inline_images=True)
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
    assert [kind for kind, _value in events] == ["text", "image", "text"]
    assert "图在这里：" in events[0][1]
    assert events[1] == ("image", png)
    assert "看完告诉我。" in events[2][1]
    assert all(source not in value for kind, value in events if kind == "text")


@pytest.mark.asyncio
async def test_qq_completed_round_keeps_trailing_text_together_after_mermaid(monkeypatch):
    from agent.im import mermaid, replies

    events = []
    png = b"\x89PNG\r\n\x1a\nchart"
    source = "```mermaid\ngraph LR; A-->B\n```"
    trailing_text = "最后这段文字用于验证解析器暂存的末尾内容仍和正文发在同一条消息里。"

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
        f"图前说明。\n{source}\n{trailing_text}",
    )

    assert sent is True
    assert [kind for kind, _value in events] == ["text", "image", "text"]
    assert events[1] == ("image", png)
    assert events[2][1] == trailing_text


@pytest.mark.asyncio
async def test_qq_completed_round_uses_shared_mermaid_run_limit(monkeypatch):
    from agent.im import mermaid, replies

    sent = []
    png = b"\x89PNG\r\n\x1a\nchart"
    sources = [f"```mermaid\ngraph LR; A{index}-->B{index}\n```" for index in range(6)]

    batches = []

    async def render(diagrams):
        batches.append(diagrams)
        return [png] * len(diagrams)

    async def send_image(_payload, image):
        sent.append(image)
        return True

    async def send_text(_payload, _text):
        sent.append(_text)
        return True

    monkeypatch.setattr(mermaid, "render_pngs", render)
    monkeypatch.setattr(replies, "send_png_image", send_image)
    monkeypatch.setattr(replies, "send_text", send_text)

    result = await replies.send_completed_round(
        {
            "platform": "qq",
            "platform_user_id": "synthetic-recipient",
            "message_id": "synthetic-message",
            replies._QQ_PASSIVE_REPLY_COUNT: 1,
        },
        "\n".join(sources),
    )

    assert result is True
    assert [len(batch) for batch in batches] == [1] * mermaid.MAX_RUN_DIAGRAMS
    assert sum(item == png for item in sent) == mermaid.MAX_RUN_DIAGRAMS
    fallback_text = "".join(item for item in sent if isinstance(item, str))
    assert sources[4] in fallback_text
    assert sources[5] in fallback_text


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
@pytest.mark.parametrize(
    ("passive_count", "expected_message_id", "expected_count"),
    [(0, "synthetic-message", 1), (1, None, 1), (5, None, 5)],
)
async def test_qq_mermaid_image_uses_active_send_after_text_reply(
    monkeypatch, passive_count, expected_message_id, expected_count
):
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
        replies._QQ_PASSIVE_REPLY_COUNT: passive_count,
    }

    assert await replies.send_png_image(payload, b"png") is True
    assert calls[0][0][5] == expected_message_id
    assert payload[replies._QQ_PASSIVE_REPLY_COUNT] == expected_count


@pytest.mark.asyncio
async def test_qq_completed_mermaid_text_continues_as_active_after_passive_budget(
    monkeypatch,
):
    from agent.im import mermaid, replies

    sent = []

    async def fake_text(payload, text):
        sent.append((payload, text))
        return True

    async def failed_render(sources):
        return [None] * len(sources)

    monkeypatch.setattr(replies, "send_text", fake_text)
    monkeypatch.setattr(mermaid, "render_pngs", failed_render)
    diagrams = [f"```mermaid\ngraph TD; A{index}-->B{index}\n```" for index in range(1, 8)]
    text = "\n".join(diagrams)
    payload = {
        "platform": "qq",
        "platform_user_id": "synthetic-recipient",
        "message_id": "synthetic-message",
        replies._QQ_PASSIVE_REPLY_COUNT: replies._QQ_PASSIVE_REPLY_LIMIT,
    }

    assert await replies.send_completed_round(payload, text) is True
    assert sent
    assert all(message_payload["message_id"] is None for message_payload, _ in sent)
    delivered_text = "\n".join(part for _, part in sent)
    assert all(diagram in delivered_text for diagram in diagrams)


@pytest.mark.asyncio
async def test_qq_stream_mermaid_fallback_and_following_text_survive_exhausted_budget(
    monkeypatch,
):
    from agent.gateway import qq
    from agent.im import mermaid, replies

    active_payloads = []
    streams = []

    class FakeStream:
        def __init__(self, message_id):
            self.message_id = message_id
            self.text = ""

        def push(self, text):
            self.text += text

        async def finish(self, text):
            self.text = text

        def has_sent(self):
            return bool(self.text)

    def create_stream(_recipient, **kwargs):
        stream = FakeStream(kwargs.get("message_id"))
        streams.append(stream)
        return stream

    async def reject_image(_payload, _png):
        return False

    async def capture_text(payload, _text):
        active_payloads.append(payload)
        return True

    monkeypatch.setattr(qq, "create_private_text_stream", create_stream)
    monkeypatch.setattr(replies, "_try_send_png_image", reject_image)
    monkeypatch.setattr(replies, "send_text", capture_text)
    payload = {
        "platform": "qq",
        "platform_user_id": "synthetic-recipient",
        "channel_id": "synthetic-channel",
        "message_id": "synthetic-message",
        replies._QQ_PASSIVE_REPLY_COUNT: replies._QQ_PASSIVE_REPLY_LIMIT,
    }
    sender = replies._QQMermaidRound(payload, show_intermediate_replies=True)
    fallback_source = "```mermaid\ngraph TD; A-->B\n```"

    await sender._emit_parts([
        mermaid.ReplyPart(png=b"png", source=fallback_source),
        mermaid.ReplyPart(text="后续正文"),
    ])
    await sender._finish_text_segment()

    assert len(active_payloads) == 1
    assert active_payloads[0]["message_id"] is None
    assert streams[-1].message_id is None
    assert streams[-1].text == "后续正文"


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
async def test_qq_stream_preserves_text_image_text_order_after_deferred_render(monkeypatch):
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
    full_text = f"前文\n\n{chart}\n\n后文"

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
    assert [kind for kind, _value in events] == ["text", "image", "text"]
    assert events[0][1] == "前文"
    assert events[1] == ("image", "png")
    assert events[2][1] == "后文"


@pytest.mark.asyncio
@pytest.mark.parametrize("show_intermediate_replies", [False, True])
async def test_qq_stream_sends_run_images_with_shared_four_chart_budget(
    monkeypatch, show_intermediate_replies,
):
    from agent.gateway import qq
    from agent.im import mermaid, replies
    from agent.models import AgentResponse

    events = []
    render_batches = []
    png = b"\x89PNG\r\n\x1a\nchart"
    sources = [f"```mermaid\ngraph LR; A{index}-->B{index}\n```" for index in range(6)]
    final_text = f"前文\n{sources[0]}\n中间说明\n" + "\n".join(sources[1:]) + "\n后文"

    class FakeStream:
        def __init__(self):
            self.text = ""

        def push(self, text):
            self.text += text

        async def finish(self, text):
            self.text = text
            events.append(("text", text))

        def has_sent(self):
            return bool(self.text)

    async def render(diagrams):
        render_batches.append(diagrams)
        return [png] * len(diagrams)

    async def send_image(_payload, _png):
        events.append(("image", "png"))
        return True

    monkeypatch.setattr(qq, "create_private_text_stream", lambda *_args, **_kwargs: FakeStream())
    monkeypatch.setattr(mermaid, "render_pngs", render)
    monkeypatch.setattr(replies, "send_png_image", send_image)

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
    assert [len(batch) for batch in render_batches] == [1] * mermaid.MAX_RUN_DIAGRAMS
    assert [kind for kind, _value in events] == ["text", "image", "text"] + ["image"] * 3 + ["text"]
    assert events[0][1] == "前文"
    assert events[1] == ("image", "png")
    assert events[2][1] == "中间说明"
    assert events[-1][1].endswith("后文")
    text_output = "".join(value for kind, value in events if kind == "text")
    assert all(source not in text_output for source in sources[:mermaid.MAX_RUN_DIAGRAMS])
    assert all(source in text_output for source in sources[mermaid.MAX_RUN_DIAGRAMS:])


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
