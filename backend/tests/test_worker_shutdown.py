"""worker 异常退出时的资源释放回归。"""

import asyncio
from types import SimpleNamespace

import worker
from agent.rag import ts_sidecar
from app.db import session as db_session


async def test_emergency_shutdown_cancels_tasks_before_disposing_db(monkeypatch):
    calls: list[str] = []
    blocker = asyncio.Event()

    async def lingering_task():
        try:
            await blocker.wait()
        finally:
            calls.append("task-finally")

    task = asyncio.create_task(lingering_task())
    await asyncio.sleep(0)

    async def dispose_engine():
        calls.append("db-dispose")

    async def reset_redis():
        calls.append("redis-reset")
        raise RuntimeError("redis cleanup failed")

    async def close_rank_clients():
        calls.append("sidecar-close")

    monkeypatch.setattr(db_session, "dispose_engine", dispose_engine)
    # 替换 worker 的模块别名，避免污染测试夹具的全局 Redis 清理。
    monkeypatch.setattr(worker, "R", SimpleNamespace(reset=reset_redis))
    monkeypatch.setattr(ts_sidecar, "close_rank_clients", close_rank_clients)

    worker._stop.clear()
    await worker._emergency_shutdown(tasks=[task])

    assert task.cancelled()
    assert calls.index("task-finally") < calls.index("db-dispose")
    assert "db-dispose" in calls
    assert "redis-reset" in calls
    assert "sidecar-close" in calls
