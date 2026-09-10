"""get_quota 回归：非 BYOK 用户走默认统计 dict 时不能缺 cache_write 键。"""
import asyncio
from types import SimpleNamespace

from app.api.v1.auth import get_quota


def _user():
    return SimpleNamespace(
        id="u1",
        quota_window_started_at=None,
        token_limit_6h=1000,
        token_limit_weekly=10_000,
    )


def test_get_quota_without_byok_returns_cache_rate_zero(monkeypatch):
    from agent import quota as _quota

    async def fake_has_byok(*_a, **_k):
        return False

    async def fake_usage_sum(*_a, **_k):
        return 0

    monkeypatch.setattr(_quota, "has_active_byok_llm", fake_has_byok)
    monkeypatch.setattr("app.api.v1.auth.usage_sum", fake_usage_sum)

    result = asyncio.get_event_loop().run_until_complete(get_quota(_user(), db=None))

    assert result["usage_kind"] == "platform"
    assert result["byok_cache_rate"] == 0
