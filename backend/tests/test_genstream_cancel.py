import pytest

from agent.llm import genstream


class _FakeRedis:
    def __init__(self):
        self.values = {}
        self.deleted = []

    async def set(self, key, value, **_kwargs):
        self.values[key] = value

    async def get(self, key):
        return self.values.get(key)

    async def delete(self, *keys):
        self.deleted.extend(keys)
        for key in keys:
            self.values.pop(key, None)


@pytest.mark.asyncio
async def test_web_cancel_is_scoped_to_generation_lifecycle(monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)

    await genstream.begin(477)
    assert not await genstream.is_cancelled(477)

    await genstream.request_cancel(477)
    assert await genstream.is_cancelled(477)

    # 新一轮生成不会继承上一轮已消费的取消标记。
    await genstream.begin(477)
    assert not await genstream.is_cancelled(477)

    await genstream.request_cancel(477)
    await genstream.end(477)
    assert not await genstream.is_cancelled(477)
    assert genstream._state_key(477) in redis.deleted
    assert genstream._cancel_key(477) in redis.deleted
