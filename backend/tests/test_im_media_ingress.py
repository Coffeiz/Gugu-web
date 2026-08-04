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

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def read(self):
        return b"image-bytes"


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
async def test_qq_media_ingress_does_not_stage_without_owner(monkeypatch):
    from agent.im.media_ingress import ingest_qq_media

    monkeypatch.setattr("aiohttp.ClientSession", _FakeSession)

    assert await ingest_qq_media([{"url": "https://example.test/a.png"}], "") == []
