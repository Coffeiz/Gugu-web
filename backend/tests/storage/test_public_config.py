from app.api.v1 import public_config
from app.core.config import AppSettings, SmtpSettings


async def test_site_config_hides_password_reset_without_smtp(monkeypatch):
    monkeypatch.setattr(
        public_config,
        "get_settings",
        lambda: AppSettings(smtp=SmtpSettings(host="")),
    )

    result = await public_config.site_config()

    assert result["passwordResetEnabled"] is False


async def test_site_config_exposes_only_password_reset_capability(monkeypatch):
    monkeypatch.setattr(
        public_config,
        "get_settings",
        lambda: AppSettings(
            smtp=SmtpSettings(
                host="smtp.example.test",
                user="mailer@example.test",
                password="not-returned",
            ),
        ),
    )

    result = await public_config.site_config()

    assert result["passwordResetEnabled"] is True
    assert "password" not in result
    assert "host" not in result
