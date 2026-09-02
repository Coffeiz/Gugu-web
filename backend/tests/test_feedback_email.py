from types import SimpleNamespace

from app.services import email


def _settings(enabled=True):
    return SimpleNamespace(
        smtp=SimpleNamespace(
            feedback_email_enabled=enabled,
            host="smtp.example.com",
            to_addr="support@example.com",
        )
    )


def test_notify_feedback_sends_when_enabled(monkeypatch):
    sent = []
    monkeypatch.setattr(email, "get_settings", lambda: _settings())
    monkeypatch.setattr(email, "send_email", lambda subject, body, **kwargs: sent.append((subject, body)) or True)

    email.notify_feedback("moon_xiaobei", "bug", "page unavailable")

    assert len(sent) == 1
    assert sent[0][0].startswith("[咕咕反馈] Bug 反馈")


def test_notify_feedback_skips_when_disabled(monkeypatch):
    sent = []
    monkeypatch.setattr(email, "get_settings", lambda: _settings(False))
    monkeypatch.setattr(email, "send_email", lambda *args, **kwargs: sent.append(True))

    email.notify_feedback("moon_xiaobei", "suggestion", "add shortcut")

    assert sent == []
