from unittest.mock import AsyncMock

import pytest

from app.models import File
from app.services.email import _build_msg
from app.services.email.attachments import EmailAttachment, EmailAttachmentError, resolve_email_attachments


class _Storage:
    def __init__(self, objects):
        self.objects = objects

    async def get(self, key):
        return self.objects[key]


def test_build_msg_attaches_regular_files_after_html():
    msg = _build_msg(
        "主题", "正文", "咕咕", "sender@example.com", "user@example.com",
        "<p>正文</p>",
        attachments=(EmailAttachment("报告.txt", b"hello", "text/plain"),),
    )

    attachments = [part for part in msg.walk() if part.get_filename() == "报告.txt"]
    assert len(attachments) == 1
    assert attachments[0].get_content_type() == "text/plain"
    assert attachments[0].get_content_disposition() == "attachment"
    assert attachments[0].get_content() == "hello"


@pytest.mark.asyncio
async def test_resolve_email_attachments_checks_ownership_and_limits(db, user_a, user_b, monkeypatch):
    owned = File(
        user_id=user_a.id, display_name="报告", ext="txt", storage_key="report.txt",
        size_bytes=5, mime_type="text/plain",
    )
    foreign = File(
        user_id=user_b.id, display_name="私密", ext="txt", storage_key="private.txt",
        size_bytes=6, mime_type="text/plain",
    )
    db.add_all([owned, foreign])
    await db.commit()
    await db.refresh(owned)
    await db.refresh(foreign)
    monkeypatch.setattr(
        "app.services.email.attachments.get_storage",
        lambda: _Storage({"report.txt": b"hello", "private.txt": b"secret"}),
    )

    attachments = await resolve_email_attachments(db, user_a.id, file_ids=[owned.id])
    assert attachments[0].filename == "报告.txt"
    assert attachments[0].content == b"hello"

    with pytest.raises(EmailAttachmentError, match="不属于当前用户"):
        await resolve_email_attachments(db, user_a.id, file_ids=[foreign.id])


@pytest.mark.asyncio
async def test_send_email_passes_owned_file_attachments(db, user_a, monkeypatch):
    from agent.tools.email import _send_email

    file_row = File(
        user_id=user_a.id, display_name="报告", ext="txt", storage_key="report.txt",
        size_bytes=5, mime_type="text/plain",
    )
    db.add(file_row)
    await db.commit()
    await db.refresh(file_row)
    monkeypatch.setattr(
        "app.services.email.attachments.get_storage",
        lambda: _Storage({"report.txt": b"hello"}),
    )
    monkeypatch.setattr("agent.tools.email.confirm.needs_confirmation", lambda *args, **kwargs: None)
    sent = []
    monkeypatch.setattr(
        "agent.tools.email.send_email_with_status",
        lambda *args, **kwargs: sent.append(kwargs) or {"status": "sent"},
    )

    result = await _send_email(db, user_a.id, {
        "subject": "报告", "body": "请查收", "file_ids": [file_row.id],
    })

    assert result["success"] is True
    assert sent[0]["attachments"][0].filename == "报告.txt"
    assert sent[0]["attachments"][0].content == b"hello"


@pytest.mark.asyncio
async def test_scheduled_email_includes_generated_file_artifacts(monkeypatch):
    import app.scheduled_tasks as scheduled

    deliver = monkeypatch.setattr
    send = AsyncMock(return_value=(True, "已发送"))
    deliver(scheduled, "_deliver_email", send)

    result = await scheduled.deliver_to_channels(
        "user-1", "日报", "正文", {"email"},
        files=[{"attach_id": "attach-1", "name": "图", "ext": "png"}],
    )

    assert result == {"邮件": "已发送"}
    send.assert_awaited_once_with(
        "user-1", "日报", "正文",
        file_ids=None,
        generated_files=[{"attach_id": "attach-1", "name": "图", "ext": "png"}],
    )


@pytest.mark.asyncio
async def test_scheduled_task_persists_owned_email_file_ids(db, user_a):
    from agent.tools.scheduled_tasks import _create_scheduled_task

    file_row = File(
        user_id=user_a.id, display_name="报告", ext="pdf", storage_key="report.pdf",
        size_bytes=5, mime_type="application/pdf",
    )
    db.add(file_row)
    await db.commit()
    await db.refresh(file_row)

    result = await _create_scheduled_task(db, user_a.id, {
        "name": "邮件报告", "instruction": "发送报告", "schedule_kind": "cron",
        "cron": "0 9 * * *", "channels": ["email"],
        "email_attachment_file_ids": [file_row.id],
    })

    assert result["success"] is True
    assert result["email_attachment_file_ids"] == [file_row.id]
