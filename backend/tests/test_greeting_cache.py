"""验证默认问候的 Redis 缓存和十分钟限频。"""

import pytest

from agent import greeting


class _FakeLock:
    async def acquire(self, *, blocking: bool, blocking_timeout: int) -> bool:
        assert blocking is True
        assert blocking_timeout == 15
        return True

    async def release(self) -> None:
        return None


class _FakeRedis:
    def __init__(self) -> None:
        self.value: str | None = None
        self.set_calls: list[tuple[str, int]] = []

    async def get(self, key: str) -> str | None:
        return self.value

    def lock(self, key: str, *, timeout: int, thread_local: bool) -> _FakeLock:
        assert key.endswith(":lock")
        assert timeout == 30
        assert thread_local is False
        return _FakeLock()

    async def set(self, key: str, value: str, *, ex: int) -> None:
        self.value = value
        self.set_calls.append((key, ex))


@pytest.mark.asyncio
async def test_greeting_reuses_cached_text_for_ten_minutes(monkeypatch):
    redis = _FakeRedis()
    calls = 0

    async def generate_uncached(*args, **kwargs) -> str:
        nonlocal calls
        calls += 1
        return "欢迎回来，今天也慢慢来。"

    monkeypatch.setattr(greeting.redis_core, "get_redis", lambda: redis)
    monkeypatch.setattr(greeting, "_generate_uncached", generate_uncached)

    first = await greeting.generate(None, 7, None, locale="zh-CN")
    second = await greeting.generate(None, 7, None, locale="zh-CN")

    assert first == second == "欢迎回来，今天也慢慢来。"
    assert calls == 1
    assert redis.set_calls == [("agent:greeting:7:zh-CN", 600)]
