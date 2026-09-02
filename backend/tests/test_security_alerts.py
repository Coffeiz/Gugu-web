"""Phase 6 外部安全告警测试。"""
from types import SimpleNamespace

import app.security.alerts as alerts


async def test_alert_is_disabled_by_default(monkeypatch):
    monkeypatch.setattr(alerts, "get_settings", lambda: SimpleNamespace(
        security=SimpleNamespace(alert_email_enabled=False, alert_email_recipients=["admin@example.com"])
    ))
    called = False

    async def fail(*args, **kwargs):
        nonlocal called
        called = True

    monkeypatch.setattr(alerts.asyncio, "to_thread", fail)
    await alerts.notify_risk_action(action="throttled", user_count=5, reason_code="ownership_mismatch")
    assert called is False


async def test_alert_sends_only_to_valid_configured_recipients(monkeypatch):
    monkeypatch.setattr(alerts, "get_settings", lambda: SimpleNamespace(
        security=SimpleNamespace(
            alert_email_enabled=True,
            alert_email_recipients=["alerts@example.com", "not-an-email"],
        )
    ))
    calls = []

    async def capture(fn, subject, body, **kwargs):
        calls.append((subject, body, kwargs))

    monkeypatch.setattr(alerts.asyncio, "to_thread", capture)
    await alerts.notify_risk_action(action="suspended", user_count=10, reason_code="ownership_mismatch")
    assert len(calls) == 1
    assert calls[0][2] == {
        "to_addr": "alerts@example.com",
        "template": "security",
        "title": "咕咕安全告警 · suspended",
        "sections": [{"heading": "事件摘要", "text": calls[0][1]}],
    }
    assert "IP" in calls[0][1]
    assert "Token" in calls[0][1]
