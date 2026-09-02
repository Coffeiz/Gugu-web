"""Agent 邮件工具：收件人解析、确认门和 SMTP 调用边界。"""

import asyncio
import json

import pytest

from agent.tools.email import _mask_email, _send_email
from agent.tools.base import reset_automation_allowed_tools, set_automation_allowed_tools
from app.models import Client, UserSmtpConfig
from app.services.email import _build_msg, sanitize_email_html
from app.services.email.templates import EmailInlineImage


@pytest.mark.asyncio
async def test_send_email_defaults_to_registered_email_and_requires_confirmation(db, user_a, monkeypatch):
    sent = []

    def fake_send(subject, body, *, to_addr, smtp_config=None):
        sent.append((subject, body, to_addr, smtp_config))
        return True

    monkeypatch.setattr("agent.tools.email.send_email_with_status", lambda *args, **kwargs: fake_send(*args, **kwargs) and {"status": "sent"})
    result = await _send_email(db, user_a.id, {"subject": "测试", "body": "正文"})

    payload = json.loads(result)
    assert payload["needs_confirm"] is True
    assert sent == []
    assert _mask_email(user_a.email) in payload["summary"]
    assert user_a.email not in payload["summary"]


@pytest.mark.asyncio
async def test_send_email_uses_client_email_after_confirmation(db, user_a, monkeypatch):
    client = Client(user_id=user_a.id, name="测试客户", email="client@example.com")
    db.add(client)
    await db.commit()
    monkeypatch.setattr("agent.tools.email.confirm.needs_confirmation", lambda *args, **kwargs: None)
    sent = []
    monkeypatch.setattr(
        "agent.tools.email.send_email_with_status",
        lambda subject, body, *, to_addr, smtp_config=None: sent.append((subject, body, to_addr, smtp_config)) or {"status": "sent"},
    )

    result = await _send_email(
        db, user_a.id, {"client_id": client.id, "subject": "跟进", "body": "请查看附件"},
    )

    assert result == {
        "status": "sent", "delivery": "smtp_accepted", "success": True,
        "message": "邮件已提交给 SMTP（收件人：c****t@example.com），不代表最终送达",
    }
    assert sent == [("跟进", "请查看附件", "client@example.com", None)]


@pytest.mark.asyncio
async def test_send_email_passes_optional_html_version(db, user_a, monkeypatch):
    monkeypatch.setattr("agent.tools.email.confirm.needs_confirmation", lambda *args, **kwargs: None)
    sent = []
    monkeypatch.setattr(
        "agent.tools.email.send_email_with_status",
        lambda subject, body, *, to_addr, smtp_config=None, html=None: sent.append(
            (subject, body, to_addr, html)
        ) or {"status": "sent"},
    )

    result = await _send_email(
        db, user_a.id,
        {"subject": "排版测试", "body": "纯文本 fallback", "html": "<p><strong>排版测试</strong></p>"},
    )

    assert result["success"] is True
    assert sent == [("排版测试", "纯文本 fallback", user_a.email, "<p><strong>排版测试</strong></p>")]


@pytest.mark.asyncio
async def test_send_email_passes_semantic_template_fields(db, user_a, monkeypatch):
    monkeypatch.setattr("agent.tools.email.confirm.needs_confirmation", lambda *args, **kwargs: None)
    sent = []
    monkeypatch.setattr(
        "agent.tools.email.send_email_with_status",
        lambda *args, **kwargs: sent.append(kwargs) or {"status": "sent"},
    )

    result = await _send_email(db, user_a.id, {
        "subject": "项目更新", "body": "项目已进入执行阶段。",
        "template": "notification", "title": "本周进展",
        "preheader": "咕咕为你整理了最新进展",
        "sections": [{"heading": "状态", "text": "执行中"}],
        "actions": [{"label": "打开项目", "url": "https://example.com/projects/1"}],
    })

    assert result["success"] is True
    assert sent[0]["template"] == "notification"
    assert sent[0]["title"] == "本周进展"
    assert sent[0]["sections"] == [{"heading": "状态", "text": "执行中"}]


@pytest.mark.asyncio
@pytest.mark.parametrize("template", ["notification", "reminder", "report", "security", "test"])
async def test_send_email_accepts_every_standard_template(db, user_a, template, monkeypatch):
    monkeypatch.setattr("agent.tools.email.confirm.needs_confirmation", lambda *args, **kwargs: None)
    sent = []
    monkeypatch.setattr(
        "agent.tools.email.send_email_with_status",
        lambda *args, **kwargs: sent.append(kwargs) or {"status": "sent"},
    )

    result = await _send_email(db, user_a.id, {
        "subject": "模板测试", "body": "正文", "template": template,
    })

    assert result["status"] == "sent"
    assert sent[0]["template"] == template


@pytest.mark.asyncio
async def test_send_email_passes_owned_custom_smtp(db, user_a, monkeypatch):
    smtp = UserSmtpConfig(user_id=user_a.id, host="smtp.example.com", port=465, user="user@example.com", password="secret", use_ssl=True)
    db.add(smtp)
    await db.commit()
    monkeypatch.setattr("agent.tools.email.confirm.needs_confirmation", lambda *args, **kwargs: None)
    sent = []
    monkeypatch.setattr("agent.tools.email.send_email_with_status", lambda *args, **kwargs: sent.append(kwargs) or {"status": "sent"})

    result = await _send_email(db, user_a.id, {"subject": "测试", "body": "正文"})

    assert result["success"] is True
    assert sent[0]["smtp_config"] is smtp


@pytest.mark.asyncio
async def test_send_email_returns_structured_smtp_failure(db, user_a, monkeypatch):
    monkeypatch.setattr("agent.tools.email.confirm.needs_confirmation", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        "agent.tools.email.send_email_with_status",
        lambda *args, **kwargs: {
            "status": "failed", "error_code": "smtp_tls_mismatch",
            "message": "SMTP TLS 连接失败，请检查端口与 SSL/TLS 设置",
        },
    )

    result = await _send_email(db, user_a.id, {"subject": "测试", "body": "正文"})

    assert result == {
        "status": "failed", "error_code": "smtp_tls_mismatch",
        "message": "SMTP TLS 连接失败，请检查端口与 SSL/TLS 设置",
    }


@pytest.mark.asyncio
async def test_send_email_has_a_total_delivery_timeout(db, user_a, monkeypatch):
    monkeypatch.setattr("agent.tools.email.confirm.needs_confirmation", lambda *args, **kwargs: None)
    monkeypatch.setattr("agent.tools.email._EMAIL_DELIVERY_TIMEOUT_SECONDS", 0.01)

    async def never_finishes(*_args, **_kwargs):
        await asyncio.sleep(60)

    monkeypatch.setattr("agent.tools.email.asyncio.to_thread", never_finishes)

    result = await _send_email(db, user_a.id, {"subject": "测试", "body": "正文"})

    assert result == {
        "status": "failed",
        "error_code": "smtp_timeout",
        "message": "邮件发送超时，SMTP 服务未在规定时间内响应",
    }


@pytest.mark.asyncio
async def test_scheduled_email_uses_task_authorization_without_confirmation(db, user_a, monkeypatch):
    monkeypatch.setattr("agent.tools.email.confirm.needs_confirmation", lambda *args, **kwargs: pytest.fail("不应再次确认"))
    monkeypatch.setattr(
        "agent.tools.email.send_email_with_status",
        lambda *args, **kwargs: {"status": "sent"},
    )
    token = set_automation_allowed_tools({"send_email"})
    try:
        result = await _send_email(db, user_a.id, {"subject": "定时测试", "body": "正文"})
    finally:
        reset_automation_allowed_tools(token)

    assert result["status"] == "sent"


@pytest.mark.asyncio
async def test_send_email_rejects_other_users_client(db, user_a, user_b):
    client = Client(user_id=user_b.id, name="其他客户", email="other@example.com")
    db.add(client)
    await db.commit()

    result = await _send_email(db, user_a.id, {"client_id": client.id, "subject": "测试", "body": "正文"})

    assert result == {"error": "客户不存在"}


@pytest.mark.asyncio
async def test_send_email_rejects_ambiguous_recipient(db, user_a):
    result = await _send_email(
        db, user_a.id,
        {"to": "one@example.com", "client_id": 1, "subject": "测试", "body": "正文"},
    )

    assert result == {"error": "to 与 client_id 不能同时指定"}


def test_build_msg_creates_plain_text_and_sanitized_html_alternative():
    msg = _build_msg(
        "主题", "纯文本", "咕咕", "sender@example.com", "user@example.com",
        '<p style="color:red"><strong>你好</strong></p><script>alert(1)</script>'
        '<a href="javascript:alert(1)" onclick="steal()">链接</a>',
    )

    assert msg.is_multipart()
    payload = msg.get_payload()
    assert len(payload) == 2
    assert payload[0].get_content_type() == "text/plain"
    assert payload[1].get_content_type() == "text/html"
    html = payload[1].get_content()
    assert "你好" in html
    assert "style=" not in html
    assert "script" not in html
    assert "onclick" not in html
    assert "javascript:" not in html


def test_email_sanitizer_keeps_safe_layout_attributes_and_drops_unsafe_values():
    msg = _build_msg(
        "主题", "纯文本", "咕咕", "sender@example.com", "user@example.com",
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" align="center">'
        '<tr><td valign="middle" width="640" style="text-align:center">内容</td></tr></table>'
        '<table role="alert" width="javascript:alert(1)"><tr><td>危险属性应被删除</td></tr></table>',
    )

    html = msg.get_payload()[1].get_content()
    assert 'role="presentation"' in html
    assert 'width="100%"' in html
    assert 'cellpadding="0"' in html
    assert 'cellspacing="0"' in html
    assert 'align="center"' in html
    assert 'valign="middle"' in html
    assert 'role="alert"' not in html
    assert 'javascript:alert' not in html


def test_email_images_allow_cid_and_https_only():
    html = sanitize_email_html(
        '<img src="cid:logo" alt="logo">'
        '<img src="https://cdn.example.com/logo.png" alt="remote">'
        '<img src="data:image/png;base64,AAAA" alt="data">'
        '<img src="http://example.com/logo.png" alt="http">'
    )

    assert 'src="cid:logo"' in html
    assert 'src="https://cdn.example.com/logo.png"' in html
    assert "data:image" not in html
    assert 'src="http://example.com/logo.png"' not in html


def test_build_msg_attaches_cid_images_as_inline_related_parts():
    image = EmailInlineImage("test-logo", b"png-data")
    msg = _build_msg(
        "主题", "纯文本", "咕咕", "sender@example.com", "user@example.com",
        '<p><img src="cid:test-logo" alt="logo"></p>', (image,),
    )

    html_part = next(part for part in msg.walk() if part.get_content_type() == "text/html")
    image_parts = [part for part in msg.walk() if part.get_content_type() == "image/png"]
    assert 'src="cid:test-logo"' in html_part.get_content()
    assert len(image_parts) == 1
    assert image_parts[0]["Content-ID"] == "<test-logo>"
    assert image_parts[0].get_content_disposition() == "inline"
