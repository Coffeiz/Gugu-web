import pytest


@pytest.mark.asyncio
async def test_shortcut_redis_failure_continues_to_worker(monkeypatch):
    from agent.im import loop

    async def fail(*_args, **_kwargs):
        raise RuntimeError("redis unavailable")

    monkeypatch.setattr("agent.runtime.runtime_state.get_state", fail)
    assert await loop.decide_im_shortcut("qq", "member-1", "你好") == {"action": "run"}


def test_sync_shortcut_redis_failure_continues_to_worker(monkeypatch):
    from agent.im import loop

    def fail(*_args, **_kwargs):
        raise RuntimeError("redis unavailable")

    monkeypatch.setattr("agent.runtime.runtime_state.get_state_sync", fail)
    assert loop.decide_im_shortcut_sync("qq", "member-1", "你好") == {"action": "run"}


def test_stop_uses_active_loop_when_state_ttl_expired():
    """忙碌态过期但活跃集合仍在时，/stop 仍必须写取消标志。"""
    from agent import router

    decision = router.decide("/stop", "idle", current_puid="member-1", active_puid={"member-1"})

    assert decision["action"] == "cancel"
