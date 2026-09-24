from datetime import timezone
from types import SimpleNamespace

from agent.tools.time import _get_current_time


def test_get_current_time_returns_date_weekday_and_time(monkeypatch):
    class FixedDatetime:
        @classmethod
        def now(cls, tz=None):
            from datetime import datetime
            return datetime(2026, 9, 25, 12, 34, 56, tzinfo=tz or timezone.utc)

    monkeypatch.setattr("app.core.tz.datetime", FixedDatetime)

    result = _get_current_time(None, "user", {})

    assert result["date"] == "2026-09-25"
    assert result["weekday"] == "星期五"
    assert result["time"] == "12:34:56"
    assert result["datetime"] == "2026-09-25 12:34:56"
