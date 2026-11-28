import pytest


@pytest.mark.asyncio
async def test_get_user_smtp_uses_service_query_without_handler_name_collision(db, user_a):
    from app.api.v1 import preferences as preferences_api
    from app.models import UserSmtpConfig

    db.add(UserSmtpConfig(
        user_id=user_a.id,
        host="smtp.example.test",
        port=465,
        user="mailer@example.test",
        password="secret",
        from_addr="mailer@example.test",
        use_ssl=True,
        enabled=True,
    ))
    await db.commit()

    result = await preferences_api.get_user_smtp(user_a, db)

    assert result.host == "smtp.example.test"
    assert result.user == "mailer@example.test"
    assert result.port == 465


@pytest.mark.asyncio
async def test_test_user_smtp_uses_saved_password_and_account_email_when_overrides_are_empty(db, user_a, monkeypatch):
    from app.api.v1 import preferences as preferences_api
    from app.models import UserSmtpConfig
    from app.schemas import UserSmtpTest

    db.add(UserSmtpConfig(
        user_id=user_a.id,
        host="smtp.example.test",
        port=587,
        user="mailer@example.test",
        password="synthetic-saved-password",
        from_addr="no-reply@example.test",
        use_ssl=False,
        enabled=True,
    ))
    await db.commit()
    sent = {}

    def capture_send(**kwargs):
        sent.update(kwargs)

    monkeypatch.setattr("app.services.email.send_test_email", capture_send)
    result = await preferences_api.test_user_smtp(UserSmtpTest(
        host="smtp.example.test",
        user="mailer@example.test",
        from_addr="no-reply@example.test",
        password="",
    ), user_a, db)

    assert result == {"ok": True, "message": "测试邮件已发送"}
    assert sent["password"] == "synthetic-saved-password"
    assert sent["to_addr"] == user_a.email


@pytest.mark.asyncio
async def test_test_user_smtp_returns_generic_failure_without_exposing_transport_error(db, user_a, monkeypatch):
    from app.api.v1 import preferences as preferences_api
    from app.core import redaction
    from app.schemas import UserSmtpTest

    monkeypatch.setattr(redaction, "diag_log", lambda *_args, **_kwargs: None)

    def fail_send(**_kwargs):
        raise RuntimeError("synthetic SMTP transport failure")

    monkeypatch.setattr("app.services.email.send_test_email", fail_send)
    result = await preferences_api.test_user_smtp(UserSmtpTest(
        host="smtp.example.test",
        user="mailer@example.test",
        from_addr="no-reply@example.test",
        password="synthetic-override-password",
        to_addr="recipient@example.test",
    ), user_a, db)

    assert result == {"ok": False, "message": "SMTP 测试失败，请检查服务器、账号或密码"}
    assert "synthetic SMTP transport failure" not in str(result)
