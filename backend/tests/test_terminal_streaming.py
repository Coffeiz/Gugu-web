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
