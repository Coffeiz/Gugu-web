import asyncio

import pytest
from pydantic import ValidationError

from app.api.v1.email_admin import EmailDraft, EmailTestRequest, preview_email


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
