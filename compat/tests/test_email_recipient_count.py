"""邮件收件人数 Python 直接对照，不发送邮件。"""
import asyncio
from types import SimpleNamespace

from app.api.v1 import email_admin


def test_recipient_count_matches_python_email_and_locale_rules(monkeypatch):
    rows = [
        (" a@example.test ", '{"locale":"en-US"}'),
        ("b@example.test", '{"locale":"ja-JP"}'),
        ("c@example.test", 'broken'),
        ("d@example.test", '[]'),
        ("not-email", '{}'),
    ]
    async def read(_db):
        return rows
    monkeypatch.setattr(email_admin, "get_active_recipient_rows", read)
    assert asyncio.run(email_admin.recipient_count(db=SimpleNamespace())) == {
        "count": 4, "locale_counts": {"zh-CN": 2, "ja-JP": 1, "en-US": 1},
    }
