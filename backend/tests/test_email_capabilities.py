from app.core.config import AppSettings, SmtpSettings
from app.services.email.capabilities import email_capabilities, is_system_email_available


def test_system_email_requires_complete_admin_smtp_configuration():
    assert not is_system_email_available(AppSettings(smtp=SmtpSettings()))
    assert not is_system_email_available(AppSettings(smtp=SmtpSettings(
        host="smtp.example.test", user="mailer@example.test", from_addr="mailer@example.test",
    )))
    assert not is_system_email_available(AppSettings(smtp=SmtpSettings(
        host="smtp.example.test", user="mailer@example.test", password="secret",
        from_addr="not-an-email",
    )))


def test_system_email_capability_is_available_only_when_admin_smtp_is_enabled():
    settings = AppSettings(smtp=SmtpSettings(
        host="smtp.example.test", user="mailer@example.test", password="secret",
        from_addr="mailer@example.test",
    ))

    assert is_system_email_available(settings)
    assert email_capabilities(settings) == {"email_change": True}

    settings.smtp.enabled = False
    assert email_capabilities(settings) == {"email_change": False}
