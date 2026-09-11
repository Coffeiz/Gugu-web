"""Web 排队 run 的 SSE 语义回归（run 进行中到达的消息）。

stream() 的排队分支：消息落库后创建后台任务进 session gate 等待；
`_stream_queued_run` 负责这条连接的事件转发——当前 run 的尾部事件
（含它的 done）一律不转发，自己的 run 接管快照后才开始转发。
"""
import asyncio

import pytest

from agent.gateway import web
from agent.llm import genstream


@pytest.mark.asyncio
async def test_queued_stream_waits_for_own_run_then_forwards_done(monkeypatch):
    """排队连接：先声明 queued；别的 run 期间不发任何事件；自己的 run 接管后转发到终态。"""
    from tests.test_genstream_cancel import _FakeRedisWithPubSub

    redis = _FakeRedisWithPubSub()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)
    monkeypatch.setattr(web, "_QUEUED_RUN_POLL_INTERVAL_SECONDS", 0.01)

    sid = 601
    # 别的 run 正在跑，快照归属是 run-A。
    await genstream.begin(sid, owner_run_id="run-A")
    task = asyncio.create_task(asyncio.sleep(3600))

    async def consume():
        lines = []
        async for line in web._stream_queued_run(sid, "run-B", task):
            lines.append(line)
            if '"type": "done"' in line:
                break
        return lines

    consumer = asyncio.create_task(consume())
    await asyncio.sleep(0.05)
    # 本 run 接管快照（_generate 的 begin_after_gate 语义）。
    await genstream.begin(sid, owner_run_id="run-B")
    await genstream.publish(sid, {"type": "round_start", "run_id": "run-B", "round_id": "r1"})
    await genstream.publish(sid, {"type": "done"})
    lines = await asyncio.wait_for(consumer, timeout=5)

    assert '"type": "queued"' in lines[0]
    # A 的任何事件都不允许出现在这条连接上（回复归属别的消息）。
    assert not any('"type": "token"' in line for line in lines)
    assert any('"type": "done"' in line for line in lines)
    task.cancel()


@pytest.mark.asyncio
async def test_queued_stream_reports_idle_when_task_ends_without_owning_snapshot(monkeypatch):
    """后台任务结束但快照从未归属本 run（排队中被取消/preflight 失败）：补 idle done 收口。"""
    from tests.test_genstream_cancel import _FakeRedisWithPubSub

    redis = _FakeRedisWithPubSub()
    monkeypatch.setattr(genstream, "get_redis", lambda: redis)
    monkeypatch.setattr(web, "_QUEUED_RUN_POLL_INTERVAL_SECONDS", 0.01)

    sid = 602
    await genstream.begin(sid, owner_run_id="run-A")
    task = asyncio.create_task(asyncio.sleep(0))   # 立即结束，从未接管快照

    lines = []
    async for line in web._stream_queued_run(sid, "run-B", task):
        lines.append(line)
        if '"type": "done"' in line:
            break

    assert '"type": "queued"' in lines[0]
    assert any('"type": "done"' in line and '"idle": true' in line for line in lines)


def test_queued_stream_poll_constants_sane():
    """轮询/上限常量保持可用的量级：轮询要快过 run 切换，上限兜底不能是无限等。"""
    assert 0 < web._QUEUED_RUN_POLL_INTERVAL_SECONDS <= 2
    assert web._QUEUED_RUN_PING_INTERVAL_SECONDS >= web._QUEUED_RUN_POLL_INTERVAL_SECONDS
    assert web._QUEUED_RUN_MAX_WAIT_SECONDS >= 60
