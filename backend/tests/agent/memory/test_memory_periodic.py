"""pattern 自动维护的水位、冷却和后台调度测试。"""
import asyncio
import time
from unittest.mock import AsyncMock

import pytest

from agent.memory import periodic


@pytest.fixture(autouse=True)
def isolate_maintenance_store(monkeypatch, tmp_path):
    from app.services.storage import LocalStorageBackend

    monkeypatch.setattr(periodic.store, "get_storage", lambda: LocalStorageBackend(tmp_path))


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

    monkeypatch.setattr(periodic, "_run_pattern_compact", fake_review)
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
async def test_pattern_compaction_failure_does_not_advance_watermark(monkeypatch):
    monkeypatch.setattr(periodic.store, "read_pattern_list", AsyncMock(return_value=_patterns(100)))
    compact = AsyncMock(return_value=False)
    monkeypatch.setattr(periodic.longterm_compaction, "compact_pattern", compact)
    now = time.time()
    monkeypatch.setattr(periodic, "time", type("Clock", (), {"time": staticmethod(lambda: now)}))

    assert await periodic.maybe_schedule("u1", None)
    await asyncio.gather(*periodic._tasks)
    state = await periodic.store.read_pattern_maintenance("u1")
    assert "last_review_at" not in state and "reviewed_count" not in state
    assert not await periodic.maybe_schedule("u1", None)
    assert compact.await_count == 1

    now += periodic.MAINTENANCE_RETRY_INTERVAL
    assert await periodic.maybe_schedule("u1", None)
    await asyncio.gather(*periodic._tasks)
    assert compact.await_count == 2


@pytest.mark.asyncio
async def test_pattern_compaction_records_post_compaction_watermark(monkeypatch):
    written = []
    monkeypatch.setattr(periodic.longterm_compaction, "compact_pattern", AsyncMock(return_value=True))
    monkeypatch.setattr(periodic.store, "read_pattern_list", AsyncMock(return_value=_patterns(70)))

    async def capture_write(_user_id, state):
        written.append(dict(state))

    monkeypatch.setattr(periodic.store, "write_pattern_maintenance", capture_write)

    assert await periodic._run_pattern_compact("u1", None, 100) is True
    assert written[-1]["reviewed_count"] == 70


@pytest.mark.asyncio
async def test_profile_compaction_records_post_compaction_watermark(monkeypatch):
    written = []
    monkeypatch.setattr(periodic.longterm_compaction, "compact_profile", AsyncMock(return_value=True))
    monkeypatch.setattr(periodic.store, "read_profile_list", AsyncMock(return_value=_patterns(70)))
    monkeypatch.setattr(periodic.store, "read_pattern_maintenance", AsyncMock(return_value={}))

    async def capture_write(_user_id, state):
        written.append(dict(state))

    monkeypatch.setattr(periodic.store, "write_pattern_maintenance", capture_write)

    assert await periodic._run_profile_compact("u1", None, 100) is True
    assert written[-1]["profile_compacted_count"] == 70


@pytest.mark.asyncio
async def test_profile_threshold_schedules_profile_compaction(monkeypatch):
    calls = []
    monkeypatch.setattr(periodic.store, "read_pattern_list", AsyncMock(return_value=[]))
    monkeypatch.setattr(periodic.store, "read_profile_list", AsyncMock(return_value=_patterns(100)))
    monkeypatch.setattr(periodic.store, "read_pattern_maintenance", AsyncMock(return_value={}))

    async def fake_compact(user_id, _settings, count):
        calls.append((user_id, count))
        return True

    monkeypatch.setattr(periodic, "_run_profile_compact", fake_compact)
    assert await periodic.maybe_schedule("u1", None) is True
    await asyncio.gather(*list(periodic._tasks))
    assert calls == [("u1", 100)]


def _patterns(count: int) -> list[dict]:
    return [{"id": str(index), "text": f"模式 {index}"} for index in range(count)]


@pytest.mark.asyncio
async def test_scheduled_maintenance_uses_compaction_scenario_even_if_output_is_invalid(monkeypatch):
    from agent.llm.modelctx import get_usage_context, usage_context_scope

    monkeypatch.setattr(periodic.store, "read_pattern_list", AsyncMock(return_value=_patterns(100)))
    monkeypatch.setattr(periodic.store, "read_profile_list", AsyncMock(return_value=_patterns(100)))
    monkeypatch.setattr(periodic.store, "read_pattern_maintenance", AsyncMock(return_value={}))
    seen = []

    async def invalid_completion(*_args, **_kwargs):
        seen.append(get_usage_context())
        return {}

    monkeypatch.setattr(periodic.longterm_compaction, "complete_json", invalid_completion)
    with usage_context_scope("u1", 7, scenario="chat"):
        assert await periodic.maybe_schedule("u1", None)
        await asyncio.gather(*periodic._tasks)
        assert get_usage_context().scenario == "chat"
    assert [(item.user_id, item.session_id, item.scenario) for item in seen] == [
        ("u1", 7, "compaction"), ("u1", 7, "compaction"),
        ("u1", 7, "compaction"), ("u1", 7, "compaction"),
    ]
