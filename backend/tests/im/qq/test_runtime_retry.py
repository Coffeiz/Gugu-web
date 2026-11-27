"""QQ token 获取异常必须保留进程内退避重试。"""
import asyncio

import pytest

from agent.gateway.qq import runtime


@pytest.mark.asyncio
async def test_token_timeout_reaches_backoff_without_crashing(monkeypatch):
    delays = []

    async def token_timeout(*args):
        raise TimeoutError("synthetic token timeout")

    async def stop_at_backoff(delay):
        delays.append(delay)
        raise asyncio.CancelledError

    monkeypatch.setattr(runtime, "_qq_access_token", token_timeout)
    monkeypatch.setattr(runtime.asyncio, "sleep", stop_at_backoff)
    with pytest.raises(asyncio.CancelledError):
        await runtime._run_raw_ws("test-app", "test-secret", False, "test-channel", "test-owner")
    assert delays == [1]
