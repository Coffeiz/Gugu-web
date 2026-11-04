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


@pytest.mark.asyncio
async def test_model_stream_wait_is_interrupted_without_waiting_for_next_token(monkeypatch):
    cancel_requested = asyncio.Event()
    stream_cancelled = asyncio.Event()

    async def is_requested(_self):
        return cancel_requested.is_set()

    async def blocked_stream():
        try:
            await asyncio.Event().wait()
            yield "unreachable"
        except asyncio.CancelledError:
            stream_cancelled.set()
            raise

    monkeypatch.setattr(RunCancellation, "is_requested", is_requested)
    monkeypatch.setattr("agent.runtime.cancellation._CANCEL_POLL_INTERVAL", 0.005)
    cancellation = RunCancellation(44)

    async def consume():
        async for _ in cancellation.iterate(blocked_stream()):
            pass

    task = asyncio.create_task(consume())
    await asyncio.sleep(0)
    cancel_requested.set()
    with pytest.raises(RunCancellationRequested):
        await asyncio.wait_for(task, timeout=0.5)
    assert stream_cancelled.is_set()


@pytest.mark.asyncio
async def test_model_stream_reuses_one_cancellation_listener_for_all_events(monkeypatch):
    listener_started = asyncio.Event()
    listener_count = 0

    async def wait_until_requested(_self):
        nonlocal listener_count
        listener_count += 1
        listener_started.set()
        await asyncio.Event().wait()

    async def stream():
        for event in range(5):
            await asyncio.sleep(0)
            yield event

    monkeypatch.setattr(RunCancellation, "_wait_until_requested", wait_until_requested)
    cancellation = RunCancellation(46)
    results = [event async for event in cancellation.iterate(stream())]

    assert listener_started.is_set()
    assert listener_count == 1
    assert results == list(range(5))


@pytest.mark.asyncio
async def test_parallel_run_registry_tracks_source_session_and_task_until_completion(monkeypatch):
    from agent.runtime import cancellation
    async def run():
        task = asyncio.current_task()
        record = cancellation.register_current_run(45, "run-registry")
        assert record is not None
        assert record.session_id == 45
        assert record.run_id == "run-registry"
        assert record.task is task
        assert record.source in {"web", "im"}
        assert cancellation.active_run("run-registry") is record

    task = asyncio.create_task(run())
    await task
    await asyncio.sleep(0)
    assert cancellation.active_run("run-registry") is None


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


@pytest.mark.asyncio
async def test_async_im_cancel_uses_shared_cancellation_entrypoint(monkeypatch):
    from agent.runtime import cancellation, runtime_state

    calls = []

    async def request_cancel(*args):
        calls.append(args)
        return True

    monkeypatch.setattr(runtime_state, "request_cancel", request_cancel)
    assert await cancellation.request_cancel(
        platform="qq", bot_id="bot-test", scope_id="group-test", puid="user-test",
    ) is True
    assert calls == [("qq", "bot-test", "group-test", "user-test")]


@pytest.mark.asyncio
async def test_session_tool_cancel_stops_process_and_allows_next_dispatch(monkeypatch, tmp_path):
    """取消必须穿过真实工具入口终止进程，后续请求不能被旧工具阻塞。"""
    import os
    import shlex
    import sys

    from agent.im import imctx
    from agent.llm import genstream
    from agent.loop.tools import dispatch_in_session
    from agent.runtime import runtime_state
    from agent.sandbox import LocalWorkspaceExecutor
    from agent.tools import registry

    cancelled = asyncio.Event()
    started = asyncio.Event()
    refreshed = []
    process_ids = []
    script = tmp_path / "waiting.py"
    script.write_text("import os,time\nprint(os.getpid(),flush=True)\ntime.sleep(60)\n")

    async def on_output(_stream, data):
        process_ids.append(int(data.strip()))
        started.set()

    async def dispatch(_user, _target, _input):
        return await LocalWorkspaceExecutor("/").execute(
            f"{shlex.quote(sys.executable)} waiting.py",
            cwd=str(tmp_path), timeout=60, on_output=on_output,
        )

    async def is_cancelled(*_args):
        return cancelled.is_set()

    async def refresh(*args):
        refreshed.append(args)

    async def not_web_cancelled(*_args):
        return False

    monkeypatch.setattr(imctx, "get_im", lambda: {
        "platform": "qq", "channel_id": "bot-test", "chat_id": "chat-test", "puid": "member-test",
    })
    monkeypatch.setattr(registry, "dispatch", dispatch)
    monkeypatch.setattr(runtime_state, "is_cancelled", is_cancelled)
    monkeypatch.setattr(runtime_state, "refresh_activity", refresh)
    monkeypatch.setattr(genstream, "is_cancelled", not_web_cancelled)
    monkeypatch.setattr("agent.runtime.cancellation._CANCEL_POLL_INTERVAL", 0.005)
    kwargs = dict(session_id=42, session=None, run_id="run-test", tool_snapshot={}, skill_state={})
    task = asyncio.create_task(dispatch_in_session(1, "shell", {}, **kwargs))
    try:
        ready = asyncio.create_task(started.wait())
        done, _ = await asyncio.wait((ready, task), timeout=3, return_when=asyncio.FIRST_COMPLETED)
        if task in done:
            pytest.fail(f"Shell 提前结束：{task.result()}")
        ready.cancel()
        await asyncio.gather(ready, return_exceptions=True)
        assert started.is_set()
        cancelled.set()
        with pytest.raises(RunCancellationRequested):
            await asyncio.wait_for(task, timeout=2)
        with pytest.raises(ProcessLookupError):
            os.kill(process_ids[0], 0)
        assert refreshed

        cancelled.clear()

        async def completed(*_args):
            return "完成", None

        monkeypatch.setattr(registry, "dispatch", completed)
        assert await dispatch_in_session(1, "shell", {}, **kwargs) == ("完成", None)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_waiting_tool_periodically_refreshes_im_activity(monkeypatch):
    """工具无输出时也续期忙碌状态，避免长任务被网关当作 idle。"""
    from agent.im import imctx
    from agent.llm import genstream
    from agent.loop.tools import dispatch_in_session
    from agent.runtime import cancellation, runtime_state
    from agent.tools import registry

    refreshed_twice = asyncio.Event()
    calls = []
    controller = RunCancellation(42)

    async def refresh(*args):
        calls.append(args)
        if len(calls) == 2:
            refreshed_twice.set()

    async def not_cancelled(*_args):
        controller._last_im_activity_refresh -= 21
        return False

    async def waiting(*_args):
        await refreshed_twice.wait()
        return "完成", None

    monkeypatch.setattr(imctx, "get_im", lambda: {
        "platform": "qq", "channel_id": "bot-test", "chat_id": "chat-test", "puid": "member-test",
    })
    monkeypatch.setattr(runtime_state, "refresh_activity", refresh)
    monkeypatch.setattr(runtime_state, "is_cancelled", not_cancelled)
    monkeypatch.setattr(genstream, "is_cancelled", not_cancelled)
    monkeypatch.setattr(cancellation, "current_cancellation", lambda _session: controller)
    monkeypatch.setattr(registry, "dispatch", waiting)
    assert await asyncio.wait_for(dispatch_in_session(
        1, "shell", {}, session_id=42, session=None, run_id="run-test",
        tool_snapshot={}, skill_state={},
    ), timeout=1) == ("完成", None)
    assert len(calls) >= 2


@pytest.mark.asyncio
async def test_serial_tool_cancel_closes_bubble_and_skips_remaining_calls():
    """取消当前工具后必须关闭气泡，并阻止本批次后续操作。"""
    import json
    from types import SimpleNamespace

    from agent.loop.tool_round import SerialToolBatchRuntime, SerialToolBindings

    executed = []

    async def dispatch(_user, target, *_args, **_kwargs):
        executed.append(target)
        raise RunCancellationRequested

    async def set_state(_name):
        pass

    calls = [SimpleNamespace(name="shell", input={}, id=f"tool-{i}") for i in range(2)]
    runtime = SerialToolBatchRuntime(
        tool_calls=calls,
        runner=SimpleNamespace(_label=lambda name: name, capability_context=None),
        run_state=SimpleNamespace(tool_call_count=0, invalid_tool_input_signatures=set()),
        bindings=SerialToolBindings(
            resolve_tool_call=lambda name, args: (name, args, None),
            set_tool_state=set_state, dispatch_in_session=dispatch,
            is_successful_result=lambda _result: False,
            json_dumps=json.dumps, json_loads=json.loads,
            pending_interaction_type=None, truncated_args_error="无效参数",
        ),
        user_id=1, session_id=42, session=None, run_id="run-test", round_id="round-test",
        verify_mode=False, tool_snapshot={"shell": object()}, loaded_skill_ids={},
    )
    emissions = [item async for item in runtime.run()]
    statuses = [item.value["status"] for item in emissions
                if item.kind == "event" and item.value["type"] == "tool_done"]
    assert executed == ["shell"]
    assert statuses == ["cancelled", "deferred"]
    assert emissions[-1].value.cancelled
    assert len(emissions[-1].value.dispatched) == 2


@pytest.mark.asyncio
async def test_parallel_shared_cancel_stops_sibling_tools():
    """共享取消不能退化为普通工具错误，让同批其他命令继续执行。"""
    from agent.loop.tool_scheduler import ParallelDispatchCancelled, run_parallel_dispatches

    sibling_started = asyncio.Event()
    sibling_stopped = asyncio.Event()

    async def dispatch(index):
        if index == 0:
            await sibling_started.wait()
            raise RunCancellationRequested
        sibling_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            sibling_stopped.set()

    with pytest.raises(ParallelDispatchCancelled):
        await asyncio.wait_for(run_parallel_dispatches([0, 1], dispatch), timeout=1)
    assert sibling_stopped.is_set()
