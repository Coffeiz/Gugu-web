"""Telegram 媒体暂存的所有权、尺寸与引用边界。"""

import pytest

from agent.im import media_ingress_telegram


@pytest.mark.asyncio
async def test_incoming_document_downloads_and_stages_under_current_bot_message(monkeypatch):
    calls = []
    staged = []

    async def token(owner_id, bot_id):
        assert (owner_id, bot_id) == ("synthetic-owner", "41")
        return "synthetic-token"

    async def api_call(value, method, *, payload):
        calls.append((value, method, payload))
        return {"file_path": "documents/sample.txt", "file_size": 4}

    async def download(value, path, *, max_bytes):
        calls.append((value, path, max_bytes))
        return b"data"

    async def stage(owner, name, ext, mime, data, **kwargs):
        staged.append((owner, name, ext, mime, data, kwargs))
        return {"attach_id": "attachment-1"}

    monkeypatch.setattr(media_ingress_telegram, "_get_owned_bot_token", token)
    monkeypatch.setattr("app.services.telegram_bot_api.call", api_call)
    monkeypatch.setattr("app.services.telegram_bot_api.download_file", download)
    monkeypatch.setattr("agent.im.files.stage", stage)

    result = await media_ingress_telegram.ingest_telegram_media(
        [{"file_id": "telegram-file", "file_size": 4, "file_name": "sample.txt",
          "mime_type": "text/plain", "media_type": "document"}],
        [], "synthetic-owner", "41", "41:-1007002:55",
    )

    assert result.attachment_ids == ["attachment-1"]
    assert result.failure_notice is None
    assert calls[0] == ("synthetic-token", "getFile", {"file_id": "telegram-file"})
    assert calls[1] == ("synthetic-token", "documents/sample.txt", 20_000_000)
    assert staged[0] == (
        "synthetic-owner", "sample", "txt", "text/plain", b"data",
        {"platform": "telegram", "platform_message_id": "41:-1007002:55",
         "attachment_index": 0},
    )


@pytest.mark.asyncio
async def test_oversized_telegram_file_is_rejected_before_download(monkeypatch):
    fetched = []

    async def token(*_args):
        return "synthetic-token"

    async def api_call(*_args, **_kwargs):
        fetched.append(True)
        return {}

    monkeypatch.setattr(media_ingress_telegram, "_get_owned_bot_token", token)
    monkeypatch.setattr("app.services.telegram_bot_api.call", api_call)

    result = await media_ingress_telegram.ingest_telegram_media(
        [{"file_id": "large-file", "file_size": 20_000_001,
          "file_name": "large.zip", "media_type": "document"}],
        [], "synthetic-owner", "41", "41:-1007002:55",
    )

    assert result.attachment_ids == []
    assert result.size_limit_exceeded is True
    assert "20 MB" in result.failure_notice
    assert fetched == []


@pytest.mark.asyncio
async def test_unavailable_file_returns_safe_notice_without_staging(monkeypatch):
    from app.services.telegram_bot_api import TelegramBotApiError

    staged = []

    async def token(*_args):
        return "synthetic-token"

    async def api_call(*_args, **_kwargs):
        raise TelegramBotApiError("getFile", status_code=404)

    async def stage(*_args, **_kwargs):
        staged.append(True)

    monkeypatch.setattr(media_ingress_telegram, "_get_owned_bot_token", token)
    monkeypatch.setattr("app.services.telegram_bot_api.call", api_call)
    monkeypatch.setattr("agent.im.files.stage", stage)

    result = await media_ingress_telegram.ingest_telegram_media(
        [{"file_id": "expired-file", "file_name": "x.bin", "media_type": "document"}],
        [], "synthetic-owner", "41", "41:-1007002:55",
    )

    assert result.attachment_ids == []
    assert result.failure_notice == media_ingress_telegram._DOWNLOAD_FAILURE_NOTICE
    assert staged == []


@pytest.mark.asyncio
async def test_quoted_media_only_reuses_same_platform_message_attachment(monkeypatch):
    reused = []

    async def reuse(owner, **kwargs):
        reused.append((owner, kwargs))
        return {"attach_id": "quoted-attachment"}

    async def should_not_download(*_args, **_kwargs):
        raise AssertionError("quoted attachment must not be fetched from Telegram history")

    monkeypatch.setattr("app.core.chat_attach.reuse_attachment", reuse)
    monkeypatch.setattr("app.services.telegram_bot_api.call", should_not_download)

    result = await media_ingress_telegram.ingest_telegram_media(
        [], [{"source_platform_message_id": "41:-1007002:54", "source_attachment_index": 0}],
        "synthetic-owner", "41", "41:-1007002:55",
    )

    assert result.attachment_ids == ["quoted-attachment"]
    assert reused == [(
        "synthetic-owner", {
            "platform": "telegram", "platform_message_id": "41:-1007002:54",
            "attachment_index": 0, "extra": {"quoted": True},
        },
    )]


@pytest.mark.asyncio
async def test_media_token_lookup_is_scoped_to_owner_and_telegram_bot(db, user_a, user_b):
    from app.models import UserBot

    bot = UserBot(
        user_id=user_a.id, platform="telegram", app_id="9001",
        app_secret="synthetic-token", enabled=True,
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)

    assert await media_ingress_telegram._get_owned_bot_token(user_a.id, str(bot.id)) == "synthetic-token"
    assert await media_ingress_telegram._get_owned_bot_token(user_b.id, str(bot.id)) is None


def test_media_mime_type_is_validated_against_telegram_media_kind():
    assert media_ingress_telegram._mime_type(
        {"mime_type": "text/html"}, "jpg", "photo"
    ) == "image/jpeg"
    assert media_ingress_telegram._mime_type(
        {"mime_type": "not a mime"}, "txt", "document"
    ) == "text/plain"
