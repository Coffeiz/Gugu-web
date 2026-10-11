import asyncio
import json

import pytest

from agent.sandbox import LocalWorkspaceExecutor
from agent.sandbox.client import SandboxdClient
from agent.sandbox.protocol import ExecuteRequest


@pytest.mark.asyncio
async def test_local_executor_reports_stdout_and_stderr_chunks(tmp_path):
    chunks = []

    async def on_output(stream, data):
        chunks.append((stream, data))

    result = await LocalWorkspaceExecutor(tmp_path).execute("printf out", on_output=on_output)
    error_result = await LocalWorkspaceExecutor(tmp_path).execute("ls missing-file", on_output=on_output)

    assert result.ok
    assert result.stdout == "out"
    assert ("stdout", "out") in chunks
    assert not error_result.ok
    assert any(stream == "stderr" and data for stream, data in chunks)


@pytest.mark.asyncio
async def test_sandboxd_client_consumes_output_before_complete(tmp_path):
    socket_path = f"/tmp/gugu-test-sandboxd-{id(tmp_path)}.sock"
    seen = []

    async def handle(reader, writer):
        request = json.loads((await reader.readline()).decode())
        assert request["operation"] == "execute"
        writer.write(b'{"type":"output","stream":"stdout","data":"partial"}\n')
        writer.write(b'{"type":"complete","ok":true,"stdout":"partial","stderr":"","exit_code":0}\n')
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    try:
        async def on_output(stream, data):
            seen.append((stream, data))

        result = await SandboxdClient(socket_path).execute_stream(
            ExecuteRequest(str(tmp_path), "printf partial", request_id="run-1"), on_output=on_output,
        )
    finally:
        server.close()
        await server.wait_closed()

    assert result["type"] == "complete"
    assert seen == [("stdout", "partial")]


@pytest.mark.asyncio
async def test_sandboxd_client_cancel_sends_scoped_request(tmp_path):
    socket_path = f"/tmp/gugu-test-sandboxd-cancel-{id(tmp_path)}.sock"
    received = {}

    async def handle(reader, writer):
        received.update(json.loads((await reader.readline()).decode()))
        writer.write(b'{"cancelled":true,"request_id":"run-2"}\n')
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    try:
        assert await SandboxdClient(socket_path).cancel("run-2") is True
    finally:
        server.close()
        await server.wait_closed()

    assert received == {"operation": "cancel", "request_id": "run-2"}


@pytest.mark.asyncio
async def test_cancelling_sandboxd_stream_notifies_running_command(tmp_path):
    """取消 Shell 输出流时仍通知 sandboxd 终止对应命令，而不只是断开 SSE/Socket。"""
    socket_path = f"/tmp/gugu-test-sandboxd-stream-cancel-{id(tmp_path)}.sock"
    execute_started = asyncio.Event()
    cancel_received = asyncio.Event()
    received = {}

    async def handle(reader, writer):
        request = json.loads((await reader.readline()).decode())
        if request["operation"] == "execute":
            received["execute"] = request
            execute_started.set()
            await reader.readline()
        elif request["operation"] == "cancel":
            received["cancel"] = request
            writer.write(b'{"cancelled":true}\n')
            await writer.drain()
            cancel_received.set()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    client = SandboxdClient(socket_path)
    execution = asyncio.create_task(client.execute_stream(
        ExecuteRequest(str(tmp_path), "sleep 60", request_id="command-1"),
    ))
    try:
        await asyncio.wait_for(execute_started.wait(), timeout=1)
        execution.cancel()
        with pytest.raises(asyncio.CancelledError):
            await execution
        await asyncio.wait_for(cancel_received.wait(), timeout=1)
    finally:
        if not execution.done():
            execution.cancel()
        server.close()
        await server.wait_closed()

    assert received["cancel"] == {"operation": "cancel", "request_id": "command-1"}
