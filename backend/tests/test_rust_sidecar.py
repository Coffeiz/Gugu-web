import shlex
import sys
from pathlib import Path

import pytest

from agent.rag.models import IndexDocument, RecallResult, Scope
from agent.rag.rust_sidecar import (
    RustLexicalIndex,
    RustSidecarClient,
    RustSidecarUnavailable,
    _sidecar_command,
)


def _document() -> IndexDocument:
    return IndexDocument(
        document_id="note:1", source_type="note", source_id="1",
        scope=Scope("user-a", scope_type="group", scope_id="group-a"),
        title="测试", summary="", content="内容", version="v1",
    )


def test_sidecar_command_appends_index_dir_without_shell_interpolation():
    assert _sidecar_command("/opt/gugu/rag-sidecar --safe", "/tmp/rag index", "user-a") == [
        "/opt/gugu/rag-sidecar", "--safe", "/tmp/rag index/fc95297aa4f56781f0decb7d4bf59b14",
    ]


def test_empty_sidecar_command_uses_packaged_binary_when_available():
    command = _sidecar_command("", "")
    packaged = Path(__file__).resolve().parents[1] / "bin" / "gugu-rag-sidecar"
    if packaged.is_file():
        assert command == [str(packaged)]
    else:
        assert command == []


@pytest.mark.asyncio
async def test_rust_index_forwards_scope_and_source_filter():
    document = _document()
    calls = {}

    class FakeClient:
        async def search(self, query, *, documents, source_types, scope, limit):
            calls.update(query=query, documents=documents, source_types=set(source_types), scope=scope, limit=limit)
            return [RecallResult(document, 1.0)]

    index = RustLexicalIndex([document], FakeClient(), "r1")
    results = await index.search(
        "测试", source_types={"note"}, scope=document.scope, limit=7,
    )
    assert results[0].document.chunk_id == document.chunk_id
    assert calls["source_types"] == {"note"}
    assert calls["scope"] == document.scope
    assert calls["limit"] == 7


@pytest.mark.asyncio
async def test_protocol_error_is_converted_to_sidecar_unavailable():
    program = "import sys; print('{\\\"status\\\":\\\"error\\\",\\\"code\\\":\\\"broken\\\"}', flush=True)"
    client = RustSidecarClient(
        "user-a", command=f"{shlex.quote(sys.executable)} -c {shlex.quote(program)}",
    )
    with pytest.raises(RustSidecarUnavailable):
        await client._request({"op": "ping"})


@pytest.mark.asyncio
async def test_persistent_sidecar_reuses_matching_revision_without_rebuild():
    client = RustSidecarClient("user-a", command="/opt/gugu-rag-sidecar", index_dir="/var/lib/gugu/rag-index")
    client._revision = "r1"
    client._document_count = 3
    calls = {"ensure": 0}

    async def ensure_process():
        calls["ensure"] += 1

    client._ensure_process = ensure_process

    assert await client.reuse_if_current("r1") is True
    assert calls["ensure"] == 1
    assert await client.reuse_if_current("r2") is False


@pytest.mark.asyncio
async def test_empty_persistent_sidecar_can_reuse_only_empty_revision():
    client = RustSidecarClient("user-a", command="/opt/gugu-rag-sidecar", index_dir="/var/lib/gugu/rag-index")
    client._revision = ""
    client._document_count = 0
    client._ensure_process = lambda: _completed_coroutine()

    assert await client.reuse_if_current("") is True
    assert await client.reuse_if_current("r1") is False


async def _completed_coroutine():
    return None
