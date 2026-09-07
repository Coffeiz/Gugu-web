import json

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

    async def exists(self, key):
        return int(key in self.values)

    async def expire(self, key, _ttl):
        return key in self.values

    async def delete(self, *keys):
        self.deleted.extend(keys)
        for key in keys:
            self.values.pop(key, None)

    async def eval(self, _script, numkeys, *args):
        keys = args[:numkeys]
        requested_owner = str(args[numkeys])
        state_key, cancel_key, lease_key, owner_key = keys
        owner = self.values.get(owner_key)
        lease_owner = self.values.get(lease_key)
        if owner and str(owner) != requested_owner:
            return 0
        if not owner and lease_owner and str(lease_owner) != requested_owner:
            return 0
        raw = self.values.get(state_key)
        state = json.loads(raw) if raw else None
        if state and state.get("done"):
            await self.delete(cancel_key, lease_key, owner_key)
            return 1
        await self.delete(state_key, cancel_key, lease_key, owner_key)
        return 1


class _FakePubSub:
    async def subscribe(self, *_channels):
        return None

    async def get_message(self, **_kwargs):
        return None

    async def unsubscribe(self, *_channels):
        return None

    async def aclose(self):
        return None


class _FakeRedisWithPubSub(_FakeRedis):
    def pubsub(self):
        return _FakePubSub()


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


@pytest.mark.asyncio
async def test_active_generation_does_not_depend_on_lease(monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)

    await genstream.begin(478)

    # lease 是并发归属，不是生成业务状态；刚启动或续看时不能因 lease
    # 尚未建立而把正常生成判断成孤儿流。
    assert await genstream.is_active(478)


@pytest.mark.asyncio
async def test_subscribe_finishes_when_no_generation_snapshot_exists(monkeypatch):
    redis = _FakeRedisWithPubSub()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)

    stream = genstream.subscribe(479)
    line = await anext(stream)
    assert '"type": "done"' in line
    assert '"idle": true' in line
    await stream.aclose()


@pytest.mark.asyncio
async def test_snapshot_keeps_tool_timeline_for_refresh_resume(monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)

    await genstream.begin(479)
    await genstream.publish(479, {
        "type": "round_start", "run_id": "run-1", "round_id": "round-2",
    })
    await genstream.publish(479, {
        "type": "tool_call", "run_id": "run-1", "round_id": "round-2",
        "tool_call_id": "call-1", "name": "shell", "label": "执行 Shell 命令",
        "input": {"command": "pwd"}, "status": "running",
    })
    await genstream.publish(479, {
        "type": "token", "content": "工具之后的回复",
    })
    await genstream.publish(479, {
        "type": "token", "content": "，继续输出",
    })

    snap = await genstream.snapshot(479)
    assert snap["run_id"] == "run-1"
    assert snap["round_id"] == "round-2"
    assert snap["tools"] == [{
        "run_id": "run-1", "round_id": "round-2", "tool_call_id": "call-1",
        "name": "shell", "label": "执行 Shell 命令",
        "input": {"command": "pwd"}, "status": "running",
    }]
    assert [item["type"] for item in snap["timeline"]] == ["round_start", "tool_call", "token"]
    assert snap["timeline"][-1]["content"] == "工具之后的回复，继续输出"


@pytest.mark.asyncio
async def test_end_keeps_done_snapshot_for_late_subscriber(monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)

    await genstream.begin(480)
    await genstream.publish(480, {"type": "done"})
    await genstream.end(480)

    snap = await genstream.snapshot(480)
    assert snap and snap["done"] is True
    assert genstream._lease_key(480) in redis.deleted


@pytest.mark.asyncio
async def test_stale_generation_cannot_end_new_generation(monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)

    await genstream.begin(482, owner_run_id="run-new")
    await genstream.claim_lease(482, "run-new")

    # 旧任务的 finally 晚到，不能删除新任务的快照、租约或 owner。
    await genstream.end(482, owner_run_id="run-old")
    assert await genstream.is_active(482)
    assert await redis.get(genstream._lease_key(482)) == "run-new"

    await genstream.end(482, owner_run_id="run-new")
    assert not await genstream.snapshot(482)


@pytest.mark.asyncio
async def test_subscribe_replays_done_when_broadcast_was_missed(monkeypatch):
    redis = _FakeRedisWithPubSub()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)

    await genstream.begin(481)
    await genstream.publish(481, {"type": "done"})
    await genstream.end(481)

    stream = genstream.subscribe(481)
    line = await anext(stream)
    assert '"type": "done"' in line
    await stream.aclose()
