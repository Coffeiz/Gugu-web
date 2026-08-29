import pytest


def test_worker_merges_qq_face_marker_into_image_without_placeholder_text():
    from worker import _merge_payloads

    merged = _merge_payloads([
        {
            "text": "[QQ表情]",
            "qq_face_marker": True,
            "attachments": [],
        },
        {
            "text": "",
            "qq_face_marker": False,
            "attachments": [{"url": "https://example.test/face.png", "qq_face": True}],
        },
    ])

    assert merged["text"] == ""
    assert merged["attachments"][0]["qq_face"] is True


def test_worker_merges_qq_emoji_refs_from_all_payloads():
    from worker import _merge_payloads

    merged = _merge_payloads([
        {"text": "[QQ表情]", "qq_face_marker": True, "emoji_refs": [{"face_type": "3", "face_id": "1"}]},
        {"text": "[QQ表情]", "qq_face_marker": True, "emoji_refs": [{"face_type": "3", "face_id": "2"}]},
    ])

    assert merged["emoji_refs"] == [
        {"face_type": "3", "face_id": "1"},
        {"face_type": "3", "face_id": "2"},
    ]


class _FakeResponse:
    status = 200
    headers = {"Content-Length": "11"}

    class _Content:
        async def iter_chunked(self, _size):
            yield b"image-bytes"

    content = _Content()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

class _FakeSession:
    def __init__(self, *args, **kwargs):
        self.urls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    def get(self, url, **kwargs):
        self.urls.append(url)
        return _FakeResponse()


@pytest.mark.asyncio
async def test_qq_media_ingress_stages_raw_attachment_with_source_message(monkeypatch):
    from agent.im.media_ingress import ingest_qq_media

    staged = []

    async def fake_stage(owner, name, ext, mime, data, **kwargs):
        staged.append((owner, name, ext, mime, data, kwargs))
        return {"attach_id": "attach-1"}

    monkeypatch.setattr("aiohttp.ClientSession", _FakeSession)
    monkeypatch.setattr("agent.im.media_ingress.url_is_safe", lambda _url: None)
    monkeypatch.setattr("app.core.chat_attach.stage", fake_stage)

    result = await ingest_qq_media(
        [{"url": "cdn.example.test/image.png", "filename": "图片.png", "type": "image/png"}],
        "owner-1",
        "message-1",
    )

    assert result == ["attach-1"]
    assert staged[0][0] == "owner-1"
    assert staged[0][4] == b"image-bytes"
    assert staged[0][5] == {
        "platform": "qq",
        "extra": {"source_message_id": "message-1"},
    }


@pytest.mark.asyncio
async def test_qq_face_media_ingress_persists_face_marker(monkeypatch):
    from agent.im.media_ingress import ingest_qq_media

    staged = []

    async def fake_stage(owner, name, ext, mime, data, **kwargs):
        staged.append(kwargs)
        return {"attach_id": "face-1"}

    monkeypatch.setattr("aiohttp.ClientSession", _FakeSession)
    monkeypatch.setattr("agent.im.media_ingress.url_is_safe", lambda _url: None)
    monkeypatch.setattr("app.core.chat_attach.stage", fake_stage)

    result = await ingest_qq_media(
        [{"url": "cdn.example.test/face", "filename": "file", "type": "image/png", "qq_face": True}],
        "owner-1",
        "message-2",
    )

    assert result == ["face-1"]
    assert staged == [{
        "kind": "image",
        "platform": "qq",
        "extra": {"source_message_id": "message-2", "qq_face": True},
    }]


@pytest.mark.asyncio
async def test_qq_quoted_media_reuses_source_without_download(monkeypatch):
    from agent.im.media_ingress import ingest_qq_media

    downloaded = []
    reused = []

    class _NoDownloadSession(_FakeSession):
        def get(self, url, **kwargs):
            downloaded.append(url)
            return super().get(url, **kwargs)

    async def fake_reuse(owner, **kwargs):
        reused.append((owner, kwargs))
        return {"attach_id": "reused-1"}

    monkeypatch.setattr("aiohttp.ClientSession", _NoDownloadSession)
    monkeypatch.setattr("app.core.chat_attach.reuse_attachment", fake_reuse)

    result = await ingest_qq_media(
        [{
            "url": "https://example.test/old.png",
            "filename": "old.png",
            "source_platform_message_id": "ref-msg-1",
            "source_attachment_index": 0,
        }],
        "owner-1",
    )

    assert result == ["reused-1"]
    assert downloaded == []
    assert reused == [(
        "owner-1",
        {
            "platform": "qq",
            "platform_message_id": "ref-msg-1",
            "attachment_index": 0,
            "extra": {"quoted": True},
        },
    )]


@pytest.mark.asyncio
async def test_qq_quoted_media_falls_back_to_download_when_not_reusable(monkeypatch):
    from agent.im.media_ingress import ingest_qq_media

    staged = []

    async def no_reuse(*args, **kwargs):
        return None

    async def fake_stage(owner, name, ext, mime, data, **kwargs):
        staged.append(kwargs)
        return {"attach_id": "downloaded-1"}

    monkeypatch.setattr("aiohttp.ClientSession", _FakeSession)
    monkeypatch.setattr("agent.im.media_ingress.url_is_safe", lambda _url: None)
    monkeypatch.setattr("app.core.chat_attach.reuse_attachment", no_reuse)
    monkeypatch.setattr("app.core.chat_attach.stage", fake_stage)

    result = await ingest_qq_media(
        [{
            "url": "https://example.test/old.png",
            "filename": "old.png",
            "source_platform_message_id": "missing-ref",
            "source_attachment_index": 1,
        }],
        "owner-1",
        platform_message_id="current-msg",
    )

    assert result == ["downloaded-1"]
    assert staged == [{
        "platform": "qq",
        "extra": None,
        "platform_message_id": "current-msg",
        "attachment_index": 0,
    }]


@pytest.mark.asyncio
async def test_qq_media_ingress_does_not_stage_without_owner(monkeypatch):
    from agent.im.media_ingress import ingest_qq_media

    monkeypatch.setattr("aiohttp.ClientSession", _FakeSession)

    assert await ingest_qq_media([{"url": "https://example.test/a.png"}], "") == []


@pytest.mark.asyncio
async def test_qq_media_ingress_rejects_attachment_over_limit(monkeypatch):
    from agent.im import media_ingress

    class _TooLargeResponse(_FakeResponse):
        headers = {"Content-Length": str(media_ingress.MAX_IM_ATTACHMENT_BYTES + 1)}

    class _TooLargeSession(_FakeSession):
        def get(self, url, **kwargs):
            self.urls.append(url)
            return _TooLargeResponse()

    staged = []
    monkeypatch.setattr("aiohttp.ClientSession", _TooLargeSession)
    monkeypatch.setattr("agent.im.media_ingress.url_is_safe", lambda _url: None)
    monkeypatch.setattr("app.core.chat_attach.stage", lambda *a, **k: staged.append(1))

    assert await media_ingress.ingest_qq_media(
        [{"url": "https://example.test/large.bin", "filename": "large.bin"}],
        "owner-1",
    ) == []
    assert staged == []


@pytest.mark.asyncio
async def test_qq_media_ingress_rejects_stream_without_content_length(monkeypatch):
    from agent.im import media_ingress

    class _StreamingTooLargeResponse(_FakeResponse):
        headers = {}

        class _Content:
            async def iter_chunked(self, _size):
                yield b"x" * (media_ingress.MAX_IM_ATTACHMENT_BYTES + 1)

        content = _Content()

    class _StreamingTooLargeSession(_FakeSession):
        def get(self, url, **kwargs):
            self.urls.append(url)
            return _StreamingTooLargeResponse()

    staged = []
    monkeypatch.setattr("aiohttp.ClientSession", _StreamingTooLargeSession)
    monkeypatch.setattr("agent.im.media_ingress.url_is_safe", lambda _url: None)
    monkeypatch.setattr("app.core.chat_attach.stage", lambda *a, **k: staged.append(1))

    assert await media_ingress.ingest_qq_media(
        [{"url": "https://example.test/stream.bin", "filename": "stream.bin"}],
        "owner-1",
    ) == []
    assert staged == []


@pytest.mark.asyncio
async def test_qq_media_ingress_enforces_message_total_limit(monkeypatch):
    from agent.im import media_ingress

    monkeypatch.setattr(media_ingress, "MAX_IM_ATTACHMENT_BYTES", 20)
    monkeypatch.setattr(media_ingress, "MAX_IM_MESSAGE_BYTES", 15)
    staged = []

    async def fake_stage(*args, **kwargs):
        staged.append(1)
        return {"attach_id": f"attach-{len(staged)}"}

    monkeypatch.setattr("aiohttp.ClientSession", _FakeSession)
    monkeypatch.setattr("agent.im.media_ingress.url_is_safe", lambda _url: None)
    monkeypatch.setattr("app.core.chat_attach.stage", fake_stage)

    result = await media_ingress.ingest_qq_media(
        [
            {"url": "https://example.test/one.bin", "filename": "one.bin"},
            {"url": "https://example.test/two.bin", "filename": "two.bin"},
        ],
        "owner-1",
    )

    assert result == ["attach-1"]
    assert len(staged) == 1
