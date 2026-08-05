"""pattern 自动维护的水位、冷却和后台调度测试。"""
import asyncio
import time
from unittest.mock import AsyncMock

import pytest

from agent.memory import periodic


@pytest.fixture(autouse=True)
def reset_periodic_state():
    periodic._pending_users.clear()
    periodic._tasks.clear()
    periodic._locks.clear()
    yield
    periodic._pending_users.clear()
    periodic._tasks.clear()
    periodic._locks.clear()


@pytest.mark.asyncio
async def test_below_threshold_does_not_schedule(monkeypatch):
    monkeypatch.setattr(periodic.store, "read_pattern_list", AsyncMock(return_value=_patterns(99)))

    assert await periodic.maybe_schedule("u1", None) is False


@pytest.mark.asyncio
async def test_threshold_schedules_once_for_active_user(monkeypatch):
    calls = []
    monkeypatch.setattr(periodic.store, "read_pattern_list", AsyncMock(return_value=_patterns(100)))
    monkeypatch.setattr(periodic.store, "read_pattern_maintenance", AsyncMock(return_value={}))

    async def fake_review(user_id, _settings, count):
        calls.append((user_id, count))
        await asyncio.sleep(0)
        return True

    monkeypatch.setattr(periodic, "_run_review", fake_review)
    assert await periodic.maybe_schedule("u1", None) is True
    # 同一个活跃反思链路可能连续触发检查，不能重复启动维护任务。
    assert await periodic.maybe_schedule("u1", None) is False
    await asyncio.gather(*list(periodic._tasks))
    assert calls == [("u1", 100)]


@pytest.mark.asyncio
async def test_cooldown_and_growth_gate(monkeypatch):
    monkeypatch.setattr(periodic.store, "read_pattern_list", AsyncMock(return_value=_patterns(120)))
    now = time.time()
    monkeypatch.setattr(
        periodic.store,
        "read_pattern_maintenance",
        AsyncMock(return_value={"last_review_at": now - 1, "reviewed_count": 100}),
    )
    assert await periodic.maybe_schedule("u1", None) is False

    monkeypatch.setattr(
        periodic.store,
        "read_pattern_maintenance",
        AsyncMock(return_value={"last_review_at": now - periodic.PATTERN_AUTO_COOLDOWN - 1, "reviewed_count": 100}),
    )
    # 冷却已过，但只增长 20 条，不达到 +30 水位。
    assert await periodic.maybe_schedule("u1", None) is False


@pytest.mark.asyncio
async def test_review_error_does_not_advance_watermark(monkeypatch):
    written = []
    monkeypatch.setattr(
        "scripts.refresh_memory._review_patterns",
        lambda *_args, **_kwargs: {"error": "parse failed"},
    )
    async def capture_write(_user_id, state):
        written.append(state)

    monkeypatch.setattr(periodic.store, "write_pattern_maintenance", capture_write)

    assert await periodic._run_review("u1", None, 100) is False
    assert written == []


def _patterns(count: int) -> list[dict]:
    return [{"id": str(index), "text": f"模式 {index}"} for index in range(count)]
