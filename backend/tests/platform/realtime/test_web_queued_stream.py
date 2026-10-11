"""Web 排队 run 的 SSE 语义回归（run 进行中到达的消息）。

stream() 的排队分支：消息落库后创建后台任务进 session gate 等待；
`_stream_queued_run` 负责这条连接的事件转发——订阅在「先订阅后启动」时建立
并一路保持，本 run 的每个事件带 owner_run_id，第一个带本 run 标记的事件即
接管点；旧 run 的事件（含它的 done）一律不转发也不终止本连接。
"""
import asyncio
import json

import pytest

from agent.gateway import web
from agent.llm import genstream


class _LivePubSub:
    """真正投递 publish 消息的 pubsub 假件：队列 + timeout 语义与 redis-py 对齐。"""

    def __init__(self, bus: "_LiveRedis"):
        self.bus = bus
        self.queue: asyncio.Queue = asyncio.Queue()

    async def subscribe(self, *_channels):
        return None

    async def unsubscribe(self, *_channels):
        return None

    async def aclose(self):
        return None

    async def get_message(self, ignore_subscribe_messages=True, timeout=None):
        if timeout is not None and timeout <= 0:
            # 非阻塞检查：直接看队列，不走 wait_for——timeout=0 的 wait_for
            # 会立即超时（新任务还没机会执行），永远拿不到已缓冲的消息。
            if self.queue.empty():
                return None
            return self.queue.get_nowait()
        try:
            return await asyncio.wait_for(self.queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None


class _LiveRedis:
    """带频道广播的 Redis 假件：genstream.publish 的事件会送达所有订阅者。"""

    def __init__(self):
        self.values: dict = {}
        self.subs: list[_LivePubSub] = []

    def pubsub(self):
        ps = _LivePubSub(self)
        self.subs.append(ps)
        return ps

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, **_kwargs):
        self.values[key] = value

    async def delete(self, *keys):
        for key in keys:
            self.values.pop(key, None)

    async def expire(self, key, _ttl):
        return key in self.values

    async def exists(self, key):
        return int(key in self.values)

    async def publish(self, _channel, payload):
        for ps in list(self.subs):
            ps.queue.put_nowait({"type": "message", "data": payload})


def _write_snapshot(redis: _LiveRedis, sid: int, **state) -> None:
    redis.values[genstream._state_key(sid)] = json.dumps(state, ensure_ascii=False)


async def _consume(sid: int, task: asyncio.Task, pubsub) -> list[str]:
    lines = []
    async for line in web._stream_queued_run(sid, "run-B", task, pubsub):
        lines.append(line)
        if '"type": "done"' in line:
            break
    return lines


@pytest.mark.asyncio
async def test_queued_stream_filters_old_run_and_forwards_own_run(monkeypatch):
    """旧 run 的尾部事件（含 done）不转发、不终止连接；自己的 run 从第一个
    带它 run_id 的事件起全数转发到终态。"""
    redis = _LiveRedis()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)
    monkeypatch.setattr(web, "_QUEUED_RUN_POLL_INTERVAL_SECONDS", 0.01)

    sid = 601
    await genstream.begin(sid, owner_run_id="run-A")
    task = asyncio.create_task(asyncio.sleep(3600))
    # 生产顺序：订阅先于排队任务创建。
    pubsub = await genstream.open_subscription(sid)

    async def consume():
        lines = []
        async for line in web._stream_queued_run(sid, "run-B", task, pubsub):
            lines.append(line)
        return lines

    consumer = asyncio.create_task(consume())
    await asyncio.sleep(0.05)
    # 旧 run 的尾部事件：不属于本条消息，且它的 done 不能收口本连接。
    await genstream.publish(sid, {"type": "token", "run_id": "run-A", "content": "旧回复尾部"})
    await genstream.publish(sid, {"type": "done", "run_id": "run-A"})
    await asyncio.sleep(0.05)
    # 本 run 接管快照（_generate 的 begin_after_gate 语义）并开始产出。
    await genstream.begin(sid, owner_run_id="run-B")
    await genstream.publish(sid, {"type": "round_start", "run_id": "run-B", "round_id": "r1"})
    await genstream.publish(sid, {"type": "token", "run_id": "run-B", "content": "新回复"})
    await genstream.publish(sid, {"type": "done", "run_id": "run-B"})
    lines = await asyncio.wait_for(consumer, timeout=5)

    assert '"type": "queued"' in lines[0]
    assert not any("旧回复尾部" in line for line in lines)
    assert any('"type": "round_start"' in line for line in lines)
    assert any("新回复" in line for line in lines)
    assert sum('"type": "done"' in line for line in lines) == 1
    task.cancel()


@pytest.mark.asyncio
async def test_queued_stream_forwards_events_published_before_takeover(monkeypatch):
    """回归（P1 事件丢失窗口）：begin 之后、轮询确认归属之前 publish 的事件
    必须原样送达。旧实现在发现归属后才 open_subscription，这一段 token 全丢，
    很快的排队回复会「已落库但界面没有内容」。"""
    redis = _LiveRedis()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)
    monkeypatch.setattr(web, "_QUEUED_RUN_POLL_INTERVAL_SECONDS", 0.01)

    sid = 603
    await genstream.begin(sid, owner_run_id="run-A")
    task = asyncio.create_task(asyncio.sleep(3600))
    pubsub = await genstream.open_subscription(sid)

    consumer = asyncio.create_task(_consume(sid, task, pubsub))
    await asyncio.sleep(0.05)
    # begin 后立即 publish，不等任何轮询：这些事件躺在 pubsub 连接缓冲里。
    await genstream.begin(sid, owner_run_id="run-B")
    await genstream.publish(sid, {"type": "token", "run_id": "run-B", "content": "你好"})
    await genstream.publish(sid, {"type": "token", "run_id": "run-B", "content": "呀"})
    await genstream.publish(sid, {"type": "done", "run_id": "run-B"})
    lines = await asyncio.wait_for(consumer, timeout=5)

    assert '"type": "queued"' in lines[0]
    tokens = [line for line in lines if '"type": "token"' in line]
    assert len(tokens) == 2
    assert "你好" in tokens[0] and "呀" in tokens[1]
    assert any('"type": "done"' in line for line in lines)
    task.cancel()


@pytest.mark.asyncio
async def test_queued_stream_reports_idle_when_task_ends_without_owning_snapshot(monkeypatch):
    """后台任务结束但快照从未归属本 run（排队中被取消/preflight 失败）：补 idle done 收口。"""
    redis = _LiveRedis()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)
    monkeypatch.setattr(web, "_QUEUED_RUN_POLL_INTERVAL_SECONDS", 0.01)

    sid = 602
    await genstream.begin(sid, owner_run_id="run-A")
    task = asyncio.create_task(asyncio.sleep(0))   # 立即结束，从未接管快照
    pubsub = await genstream.open_subscription(sid)

    lines = await asyncio.wait_for(_consume(sid, task, pubsub), timeout=5)

    assert '"type": "queued"' in lines[0]
    assert any('"type": "done"' in line and '"idle": true' in line for line in lines)


@pytest.mark.asyncio
async def test_queued_stream_replays_done_from_snapshot_when_event_missed(monkeypatch):
    """兜底：已接管但终态事件丢失（Redis 抖动），按快照补发 replayed done。"""
    redis = _LiveRedis()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)
    monkeypatch.setattr(web, "_QUEUED_RUN_POLL_INTERVAL_SECONDS", 0.01)

    sid = 604
    await genstream.begin(sid, owner_run_id="run-A")
    task = asyncio.create_task(asyncio.sleep(3600))
    pubsub = await genstream.open_subscription(sid)

    consumer = asyncio.create_task(_consume(sid, task, pubsub))
    await asyncio.sleep(0.05)
    await genstream.begin(sid, owner_run_id="run-B")
    # 只发一个 token 让连接接管；done 事件「丢」——只写快照、不广播。
    await genstream.publish(sid, {"type": "token", "run_id": "run-B", "content": "半截"})
    await asyncio.sleep(0.05)
    _write_snapshot(redis, sid, done=True, text="半截", owner_run_id="run-B")
    lines = await asyncio.wait_for(consumer, timeout=5)

    assert any("半截" in line for line in lines)
    assert any('"type": "done"' in line and '"replayed": true' in line for line in lines)
    task.cancel()


@pytest.mark.asyncio
async def test_queued_run_ended_before_events_yields_done_from_snapshot(monkeypatch):
    """run 在任何事件前就结束（排队中被取消等）：快照已归属本 run 且终态，
    补发终态让前端收口。"""
    redis = _LiveRedis()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)
    monkeypatch.setattr(web, "_QUEUED_RUN_POLL_INTERVAL_SECONDS", 0.01)

    sid = 605
    await genstream.begin(sid, owner_run_id="run-A")
    task = asyncio.create_task(asyncio.sleep(3600))
    pubsub = await genstream.open_subscription(sid)

    consumer = asyncio.create_task(_consume(sid, task, pubsub))
    await asyncio.sleep(0.05)
    # begin 后没发过任何事件就终态。
    _write_snapshot(redis, sid, done=True, text="", owner_run_id="run-B")
    lines = await asyncio.wait_for(consumer, timeout=5)

    assert '"type": "queued"' in lines[0]
    assert any('"type": "done"' in line and '"idle"' not in line for line in lines)
    task.cancel()


def test_queued_stream_poll_constants_sane():
    """轮询/上限常量保持可用的量级：轮询要快过 run 切换，上限兜底不能是无限等。"""
    assert 0 < web._QUEUED_RUN_POLL_INTERVAL_SECONDS <= 2
    assert web._QUEUED_RUN_PING_INTERVAL_SECONDS >= web._QUEUED_RUN_POLL_INTERVAL_SECONDS
    assert web._QUEUED_RUN_MAX_WAIT_SECONDS >= 60
