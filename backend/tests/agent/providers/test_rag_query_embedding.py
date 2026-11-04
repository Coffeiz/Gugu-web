"""保护 Cython RAG 接管 query embedding 时的网络与凭据边界。"""
from __future__ import annotations

import asyncio
import gzip
import json
from pathlib import Path
import subprocess

import httpx
import pytest

from agent.memory import embedding


class _StreamResponse:
    status_code = 200

    def __init__(self, payload: bytes):
        self.payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def aiter_raw(self):
        yield self.payload


class _Client:
    init_options = None
    request = None
    response_payload = b""

    def __init__(self, **kwargs):
        type(self).init_options = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def stream(self, method, url, *, json, headers):
        type(self).request = {"method": method, "url": url, "json": json, "headers": headers}
        return _StreamResponse(type(self).response_payload)


@pytest.fixture(autouse=True)
def _clear_query_vector_cache(monkeypatch):
    monkeypatch.setattr(embedding, "_query_vector_cache", {})


@pytest.mark.asyncio
async def test_query_embedding_pins_destination_and_caches_vector_without_plaintext_key(monkeypatch):
    """查询向量请求固定已校验 IP、拒绝重定向，并按模型+查询短缓存结果。"""
    settings = {
        "provider": "openai", "base_url": "https://embedding.example/v1",
        "pinned_ip": "8.8.8.8", "model": "embed-test", "dimensions": 2,
        "api_key": "synthetic-secret", "multimodal": False,
    }
    monkeypatch.setattr(embedding, "query_settings", lambda: settings)
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    _Client.response_payload = json.dumps({"data": [{"embedding": [0.25, -0.5]}]}).encode()

    first = await embedding.embed_query(" synthetic query ")
    second = await embedding.embed_query("synthetic query")

    assert first == {"vector": [0.25, -0.5], "outcome": "success", "http_status": 200}
    assert second == {"vector": [0.25, -0.5], "outcome": "success"}
    assert _Client.request["url"] == "https://embedding.example/v1/embeddings"
    assert _Client.request["headers"]["authorization"] == "Bearer synthetic-secret"
    assert _Client.request["headers"]["accept-encoding"] == "identity"
    assert _Client.init_options["follow_redirects"] is False
    assert _Client.init_options["trust_env"] is False
    assert isinstance(_Client.init_options["transport"], httpx.AsyncHTTPTransport)
    assert _Client.request["json"] == {"model": "embed-test", "input": "synthetic query", "dimensions": 2}
    assert len(embedding._query_vector_cache) == 1


@pytest.mark.asyncio
async def test_query_embedding_uses_supplied_validated_config_snapshot(monkeypatch):
    """本轮配置快照与全局设置不同步时，查询仍使用已校验的本轮 endpoint/model。"""
    settings = {
        "provider": "openai", "base_url": "https://snapshot.example/v1",
        "pinned_ip": "8.8.8.8", "model": "snapshot-model", "dimensions": 3,
        "api_key": "synthetic-secret", "multimodal": False,
    }

    def unexpected_global_settings():
        raise AssertionError("显式传入本轮快照时不得重新读取全局配置")

    monkeypatch.setattr(embedding, "query_settings", unexpected_global_settings)
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    _Client.response_payload = json.dumps({"data": [{"embedding": [0.1, 0.2, 0.3]}]}).encode()

    result = await embedding.embed_query("snapshot query", settings=settings)

    assert result == {"vector": [0.1, 0.2, 0.3], "outcome": "success", "http_status": 200}
    assert _Client.request["url"] == "https://snapshot.example/v1/embeddings"
    assert _Client.request["json"] == {
        "model": "snapshot-model", "input": "snapshot query", "dimensions": 3,
    }


def test_query_embedding_request_matches_bailian_multimodal_contract():
    settings = {
        "provider": "dashscope", "base_url": "https://dashscope.example/compatible-mode/v1",
        "pinned_ip": "8.8.4.4", "model": "embed-mm", "dimensions": 1024,
        "api_key": "synthetic-secret", "multimodal": True,
    }

    request = embedding._query_embedding_request(settings, "synthetic text")

    assert request == (
        "https://dashscope.example/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
        {"model": "embed-mm", "input": {"contents": [{"text": "synthetic text"}]},
         "parameters": {"output_type": "dense", "dimension": 1024, "enable_fusion": False}},
        "bailian",
    )


@pytest.mark.parametrize("payload", [
    {"data": [{"embedding": []}]},
    {"data": [{"embedding": [0.1, float("nan")]}]},
    {"data": [{"embedding": [True]}]},
    {"unexpected": []},
])
def test_query_embedding_rejects_invalid_provider_vectors(payload):
    assert embedding._extract_query_vector(payload, "openai") is None


async def _run_ts_query_embedding(settings: dict, text: str, timeout_ms: int) -> dict:
    source = (
        'import { embedQuery } from "./ts/workers/rag/src/query-embedding.ts";'
        'let input=""; for await (const chunk of process.stdin) input += chunk;'
        'const request=JSON.parse(input);'
        'const result=await embedQuery(request.settings, request.text, request.timeout_ms);'
        'process.stdout.write(JSON.stringify(result));'
    )
    process = await asyncio.create_subprocess_exec(
        "node", "--experimental-strip-types", "--input-type=module", "-e", source,
        cwd=Path(__file__).parents[3],
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate(json.dumps({
        "settings": settings, "text": text, "timeout_ms": timeout_ms,
    }).encode())
    assert process.returncode == 0, stderr.decode("utf-8", errors="replace")
    return json.loads(stdout)


@pytest.mark.asyncio
@pytest.mark.parametrize((
    "response_status", "response_body", "delay", "invalid_key", "connection_failure", "compressed", "expected",
), [
    (200, b'{"data":[{"embedding":[0.25,-0.75]}]}', 0, False, False, False,
     {"vector": [0.25, -0.75], "outcome": "success", "http_status": 200}),
    (429, b'{"error":"private upstream detail"}', 0, False, False, False,
     {"vector": [], "outcome": "http_error", "http_status": 429}),
    (302, b'{"data":[{"embedding":[1,0]}]}', 0, False, False, False,
     {"vector": [], "outcome": "http_error", "http_status": 302}),
    (200, b"not-json", 0, False, False, False,
     {"vector": [], "outcome": "invalid_response", "http_status": 200}),
    (200, b'{"data":[{"embedding":[true]}]}', 0, False, False, False,
     {"vector": [], "outcome": "invalid_response", "http_status": 200}),
    (200, json.dumps({"data": [{"embedding": [1, 0]}], "padding": "x" * (2 * 1024 * 1024)}).encode(),
     0, False, False, False, {"vector": [], "outcome": "response_too_large", "http_status": 200}),
    (200, b'{"data":[{"embedding":[1,0]}]}', 0.1, False, False, False,
     {"vector": [], "outcome": "timeout"}),
    (200, b'{"data":[{"embedding":[1,0]}]}', 0, False, True, False,
     {"vector": [], "outcome": "network_error"}),
    (200, b'{"data":[{"embedding":[1,0]}]}', 0, "newline", False, False,
     {"vector": [], "outcome": "invalid_config"}),
    (200, b'{"data":[{"embedding":[1,0]}]}', 0, "unicode", False, False,
     {"vector": [], "outcome": "invalid_config"}),
    (200, b'{"data":[{"embedding":[1,0]}]}', 0, False, False, True,
     {"vector": [], "outcome": "invalid_response", "http_status": 200}),
], ids=["success", "http-error", "redirect", "invalid-json", "invalid-vector", "response-too-large",
       "timeout", "network-error", "newline-api-key", "non-ascii-api-key", "compressed-response"])
async def test_query_embedding_error_matrix_matches_ts_runtime(
    monkeypatch, response_status, response_body, delay, invalid_key, connection_failure, compressed, expected,
):
    """同一本机 HTTP 行为下，Python 与 TS 的 query embedding 结果必须逐字段一致。"""
    async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request_line = await reader.readline()
            headers = {}
            while line := await reader.readline():
                if line == b"\r\n":
                    break
                key, _, value = line.decode("latin-1").partition(":")
                headers[key.lower()] = value.strip()
            body_size = int(headers.get("content-length", "0"))
            if body_size:
                await reader.readexactly(body_size)
            if delay:
                await asyncio.sleep(delay)
            reason = "Found" if response_status == 302 else "OK"
            wire_body = gzip.compress(response_body) if compressed else response_body
            response = (
                f"HTTP/1.1 {response_status} {reason}\r\n"
                f"Content-Type: application/json\r\nContent-Length: {len(wire_body)}\r\n"
                "Connection: close\r\n"
                + ("Content-Encoding: gzip\r\n" if compressed else "")
                + ("Location: /redirected\r\n" if response_status == 302 else "")
                + "\r\n"
            ).encode("ascii") + wire_body
            writer.write(response)
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    settings = {
        "provider": "local", "base_url": f"http://embedding.test:{port}/v1",
        "pinned_ip": "127.0.0.1", "model": "differential-test", "dimensions": 2,
        "api_key": ("synthetic-secret\ninvalid" if invalid_key == "newline" else
                    "synthetic-sécret" if invalid_key == "unicode" else "synthetic-secret"),
        "multimodal": False,
    }
    if connection_failure:
        server.close()
        await server.wait_closed()
    try:
        ts_result = await _run_ts_query_embedding(settings, "differential query", 15 if delay else 1000)
        monkeypatch.setattr(embedding, "QUERY_EMBEDDING_TIMEOUT_SECONDS", 0.015 if delay else 4.0)
        python_result = await embedding.embed_query("differential query", settings=settings)
        assert ts_result == expected
        assert python_result == expected
        assert ts_result == python_result
    finally:
        server.close()
        await server.wait_closed()
        if delay:
            await asyncio.sleep(delay)


@pytest.mark.asyncio
@pytest.mark.parametrize(("change", "text"), [
    ("blank_model", "synthetic query"),
    ("unsupported_scheme", "synthetic query"),
    ("url_credentials", "synthetic query"),
    ("url_query", "synthetic query"),
    ("invalid_pin", "synthetic query"),
    ("empty_query", "  \n"),
], ids=["blank-model", "unsupported-scheme", "url-credentials", "url-query", "invalid-pin", "empty-query"])
async def test_query_embedding_rejects_invalid_wire_config_like_ts(change, text):
    """无效 query/settings 在 TS 与 Python facade 中都应在发网前安全拒绝。"""
    settings = {
        "provider": "local", "base_url": "http://embedding.test:1/v1",
        "pinned_ip": "127.0.0.1", "model": "differential-test", "dimensions": 2,
        "api_key": "synthetic-secret", "multimodal": False,
    }
    if change == "blank_model":
        settings["model"] = " \t "
    elif change == "unsupported_scheme":
        settings["base_url"] = "ftp://embedding.test/v1"
    elif change == "url_credentials":
        settings["base_url"] = "http://user:pass@embedding.test/v1"
    elif change == "url_query":
        settings["base_url"] = "http://embedding.test/v1?unsafe=1"
    elif change == "invalid_pin":
        settings["pinned_ip"] = "not-an-ip"

    expected = {"vector": [], "outcome": "invalid_config"}
    ts_result = await _run_ts_query_embedding(settings, text, 1000)
    python_result = await embedding.embed_query(text, settings=settings)
    assert ts_result == expected
    assert python_result == expected
    assert ts_result == python_result
