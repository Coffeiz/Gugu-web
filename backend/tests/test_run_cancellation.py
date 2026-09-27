import asyncio

import pytest

from agent.runtime.cancellation import RunCancellation, RunCancellationRequested


@pytest.mark.asyncio
async def test_running_tool_and_sandbox_request_stop_on_shared_cancel_signal(monkeypatch):
    started = asyncio.Event()
    cancel_requested = asyncio.Event()
    sandbox_cancelled = []
    operation_cancelled = []

    async def is_requested(_self):
        return cancel_requested.is_set()

    async def cancel_sandbox_request(request_id):
        sandbox_cancelled.append(request_id)
        return True

    async def operation():
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            operation_cancelled.append(True)
            raise

    cancellation = RunCancellation(42)
    monkeypatch.setattr(RunCancellation, "is_requested", is_requested)
    monkeypatch.setattr(
        RunCancellation, "cancel_sandbox_request", staticmethod(cancel_sandbox_request),
    )
    monkeypatch.setattr("agent.runtime.cancellation._CANCEL_POLL_INTERVAL", 0.005)

    task = asyncio.create_task(cancellation.dispatch(operation, request_id="run-42"))
    await started.wait()
    cancel_requested.set()

    with pytest.raises(RunCancellationRequested):
        await task

    assert operation_cancelled == [True]
    assert sandbox_cancelled == ["run-42"]


@pytest.mark.asyncio
async def test_completed_tool_result_wins_if_cancel_arrives_after_completion(monkeypatch):
    async def is_requested(_self):
        return False

    cancellation = RunCancellation(43)
    monkeypatch.setattr(RunCancellation, "is_requested", is_requested)

    async def operation():
        return "completed"

    assert await cancellation.dispatch(operation, request_id="run-43") == "completed"


def test_sync_im_cancel_uses_shared_cancellation_entrypoint(monkeypatch):
    from agent.runtime import cancellation
    from agent.runtime import runtime_state

    calls = []

    def request_cancel_sync(*args):
        calls.append(args)
        return True

    monkeypatch.setattr(runtime_state, "request_cancel_sync", request_cancel_sync)
    assert cancellation.request_cancel_sync(
        platform="qq", bot_id="bot-test", scope_id="group-test", puid="user-test",
    ) is True
    assert calls == [("qq", "bot-test", "group-test", "user-test")]
