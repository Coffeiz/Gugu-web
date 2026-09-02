import asyncio

import pytest
from pydantic import ValidationError

from app.api.v1.email_admin import (
    EmailDraft,
    EmailTestRequest,
    LocalizedEmailContent,
    _normalize_translation_content,
    _prepare_translation_payload,
    preview_email,
)


def _draft() -> EmailDraft:
    return EmailDraft(
        subject="站点更新",
        title="咕咕有一条更新",
        body="这是正文。",
        sections=[{"heading": "重点", "text": "请查看详情。"}],
        actions=[{"label": "查看详情", "url": "https://example.com"}],
    )


def test_admin_email_preview_uses_shared_template_and_returns_plain_text():
    result = asyncio.run(preview_email(_draft()))

    assert "咕咕有一条更新" in result["html"]
    assert "查看详情" in result["html"]
    assert "这是正文。" in result["plain"]


def test_admin_email_test_recipient_rejects_invalid_address():
    with pytest.raises(ValidationError):
        EmailTestRequest(**_draft().model_dump(), recipient="not-an-email")


def test_translation_drops_model_added_blocks_and_buttons_when_source_is_empty():
    source = LocalizedEmailContent(subject="主题", title="标题", body="正文")
    generated = LocalizedEmailContent(
        subject="Subject",
        title="Title",
        body="Body",
        sections=[{"heading": "Extra", "text": "不要添加"}],
        actions=[{"label": "Extra", "url": "https://untrusted.example"}],
    )

    normalized = _normalize_translation_content(generated, source)

    assert normalized.sections == []
    assert normalized.actions == []


def test_translation_keeps_source_action_urls_and_discards_extra_items():
    source = _draft()
    generated = LocalizedEmailContent(
        subject="Subject",
        title="Title",
        body="Body",
        sections=[
            {"heading": "重点", "text": "Translated"},
            {"heading": "Extra", "text": "不要添加"},
        ],
        actions=[
            {"label": "View details", "url": "https://untrusted.example"},
            {"label": "Extra", "url": "https://untrusted.example/extra"},
        ],
    )

    normalized = _normalize_translation_content(generated, source)

    assert len(normalized.sections) == 1
    assert len(normalized.actions) == 1
    assert normalized.actions[0].label == "View details"
    assert normalized.actions[0].url == "https://example.com"


def test_translation_payload_fills_optional_fields_and_source_action_urls():
    source = _draft()
    payload = {
        "subject": "Subject",
        "title": "Title",
        "body": "Body",
        "sections": [{"heading": "重点", "text": "Translated"}],
        "actions": [{"label": "View details"}],
    }

    prepared = _prepare_translation_payload(payload, source)

    assert prepared["preheader"] == ""
    assert prepared["actions"][0]["url"] == "https://example.com"


def test_translation_payload_falls_back_to_source_for_empty_required_fields():
    source = _draft()
    payload = {"subject": "", "title": None, "body": "", "sections": [], "actions": []}

    prepared = _prepare_translation_payload(payload, source)

    assert prepared["subject"] == source.subject
    assert prepared["title"] == source.title
    assert prepared["body"] == source.body
