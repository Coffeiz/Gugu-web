"""后台反思缓存前缀跨 Worker 协调的行为回归。"""
import asyncio

import pytest

from agent.providers import cache_probe, cache_singleflight
from agent.runtime.loopscope_trace.cache_probe import _safe_reflection_observation


class _FakeLock:
    def __init__(self, lock):
        self._lock = lock
        self.renewals = 0

    async def acquire(self, *, blocking, blocking_timeout=None):
        if not blocking:
            return self._lock.acquire(blocking=False)
        try:
            await asyncio.wait_for(self._lock.acquire(), timeout=blocking_timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def extend(self, _seconds, *, replace_ttl):
        assert replace_ttl is True
        self.renewals += 1
        return True

    async def release(self):
        self._lock.release()


class _FakeRedis:
    def __init__(self):
        self.locks = {}

    def lock(self, key, *, timeout, thread_local):
        assert timeout > 0
        assert thread_local is False
        return _FakeLock(self.locks.setdefault(key, asyncio.Lock()))


def _probe(digest="same"):
    return {"wire_prefix": {"digest": digest, "anchor_paths": ["messages[0]"]}}


async def _run_locked(probe, action):
    async with cache_singleflight.cache_prefix_singleflight(probe, enabled=True):
        await action()


def test_wire_cache_fingerprint_ignores_dynamic_tail_but_captures_stable_request():
    def request(stable, tail, tools=None):
        return {
            "model": "model-a",
            "tools": tools or [],
            "messages": [
                {"role": "user", "content": stable,
                 "cache_control": {"type": "ephemeral"}},
                {"role": "user", "content": tail},
            ],
        }

    first = cache_probe.start_request_probe([], request("history", "delta-a"))
    second = cache_probe.start_request_probe([], request("history", "delta-b"))
    changed_prefix = cache_probe.start_request_probe([], request("other", "delta-a"))
    changed_tools = cache_probe.start_request_probe(
        [], request("history", "delta-a", [{"name": "tool"}]),
    )

    assert first["wire_prefix"]["digest"] == second["wire_prefix"]["digest"]
    assert first["wire_prefix"]["digest"] != changed_prefix["wire_prefix"]["digest"]
    assert first["wire_prefix"]["digest"] != changed_tools["wire_prefix"]["digest"]
    assert cache_singleflight.provider_branch_fingerprint(
        request("history", "delta-a"), stable_row_count=1,
    ) == cache_singleflight.provider_branch_fingerprint(
        request("history", "delta-b"), stable_row_count=1,
    )
    assert cache_singleflight.provider_branch_fingerprint(
        request("history", "delta-a"), stable_row_count=1,
    ) != cache_singleflight.provider_branch_fingerprint(
        request("other", "delta-a"), stable_row_count=1,
    )


def test_reflection_trace_keeps_only_cache_fingerprint_and_singleflight_diagnostics():
    safe = _safe_reflection_observation({
        "scenario": "reflection",
        "wire_prefix": {"digest": "a" * 64, "anchor_paths": ["messages[0]"]},
        "cache_key_fingerprint": "b" * 64,
        "singleflight_state": "acquired",
        "singleflight_wait_ms": 12.5,
        "singleflight_lease_renewals": 1,
        "singleflight_lease_lost": False,
        "request": {"messages": [{"content": "private prompt"}]},
    })

    assert safe["cache_key_fingerprint"] == "b" * 64
    assert safe["singleflight_state"] == "acquired"
    assert safe["singleflight_wait_ms"] == 12.5
    assert safe["singleflight_lease_renewals"] == 1
    assert "private prompt" not in repr(safe)


def test_responses_branch_fingerprint_excludes_task_tail_and_checks_cache_support():
    first = {
        "model": "model-a",
        "prompt_cache_key": "stable",
        "input": [{"role": "user", "content": "history"}, {"role": "user", "content": "task-a"}],
    }
    second = {**first, "input": [first["input"][0], {"role": "user", "content": "task-b"}]}

    assert cache_singleflight.responses_branch_fingerprint(
        first, stable_history_count=1, cache_supported=True,
    ) == cache_singleflight.responses_branch_fingerprint(
        second, stable_history_count=1, cache_supported=True,
    )
    assert cache_singleflight.responses_branch_fingerprint(
        first, stable_history_count=0, cache_supported=True,
    ) is None
    assert cache_singleflight.responses_branch_fingerprint(
        first, stable_history_count=1, cache_supported=False,
    ) is None


def test_provider_branch_coordination_requires_explicit_cache_support():
    class _Adapter:
        def supports_active_cache(self, _model):
            return False

        def supports_explicit_cache(self, model):
            return model == "cache-model"

    assert cache_singleflight.provider_branch_cache_supported(
        _Adapter(), type("AI", (), {"model": "cache-model"})(),
    )
    assert not cache_singleflight.provider_branch_cache_supported(
        _Adapter(), type("AI", (), {"model": "uncached-model"})(),
    )


@pytest.mark.asyncio
async def test_same_prefix_waits_across_workers_and_different_prefixes_run_parallel(monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)
    entered = []
    both_different_entered = asyncio.Event()
    active = 0
    max_active = 0
    same_active = 0
    same_max_active = 0

    async def same(name, probe):
        nonlocal same_active, same_max_active
        async def action():
            nonlocal same_active, same_max_active
            entered.append(name)
            same_active += 1
            same_max_active = max(same_max_active, same_active)
            await asyncio.sleep(0.04)
            same_active -= 1
        await _run_locked(probe, action)

    first = asyncio.create_task(same("first", _probe("same")))
    await asyncio.sleep(0.005)
    second_probe = _probe("same")
    second = asyncio.create_task(same("second", second_probe))
    await asyncio.gather(first, second)
    assert entered == ["first", "second"]
    assert same_max_active == 1
    assert second_probe["singleflight_state"] == "acquired"
    assert second_probe["singleflight_wait_ms"] > 0

    async def different(probe):
        nonlocal active, max_active
        async def action():
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            if active == 2:
                both_different_entered.set()
            await asyncio.wait_for(both_different_entered.wait(), timeout=1)
            active -= 1
        await _run_locked(probe, action)

    await asyncio.gather(different(_probe("a")), different(_probe("b")))
    assert max_active == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("exit_kind", ["error", "cancel"])
async def test_lock_is_released_after_provider_error_or_cancellation(monkeypatch, exit_kind):
    redis = _FakeRedis()
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)
    entered = asyncio.Event()

    async def held_call():
        async with cache_singleflight.cache_prefix_singleflight(_probe(), enabled=True):
            entered.set()
            if exit_kind == "error":
                raise RuntimeError("provider failed")
            await asyncio.Future()

    task = asyncio.create_task(held_call())
    await entered.wait()
    if exit_kind == "error":
        with pytest.raises(RuntimeError, match="provider failed"):
            await task
    else:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    probe = _probe()
    async with cache_singleflight.cache_prefix_singleflight(probe, enabled=True):
        assert probe["singleflight_state"] == "acquired"


@pytest.mark.asyncio
async def test_redis_failure_does_not_fail_background_provider_call(monkeypatch):
    def unavailable():
        raise OSError("redis unavailable")

    monkeypatch.setattr("app.core.redis.get_redis", unavailable)
    probe = _probe()
    async with cache_singleflight.cache_prefix_singleflight(probe, enabled=True):
        assert probe["singleflight_state"] == "redis_unavailable"


@pytest.mark.asyncio
async def test_lock_lease_renews_during_long_provider_call(monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)
    monkeypatch.setattr(cache_singleflight, "_HEARTBEAT_SECONDS", 0.005)
    probe = _probe()
    async with cache_singleflight.cache_prefix_singleflight(probe, enabled=True):
        await asyncio.sleep(0.02)
    assert probe["singleflight_lease_renewals"] >= 1
