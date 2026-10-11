import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from agent.rag import context as rag_context
from agent.run import preparation


@pytest.mark.asyncio
async def test_mcp_discovery_and_rag_recall_overlap_and_keep_message_watermark(monkeypatch):
    """MCP 冷发现不得挡住独立 RAG 召回，且召回仍排除本轮用户消息。"""
    mcp_started = asyncio.Event()
    rag_started = asyncio.Event()
    prior = SimpleNamespace(id=4, content_json=[])
    current = SimpleNamespace(
        id=5,
        sent_at=datetime(2026, 10, 9, tzinfo=timezone.utc),
        content_json=[],
    )

    async def fake_mcp(*_args):
        mcp_started.set()
        await asyncio.wait_for(rag_started.wait(), timeout=1)
        return ["mcp-tool"]

    async def fake_rag(_req, _query, *, history, snapshot_text):
        assert mcp_started.is_set()
        assert history == [prior]
        assert snapshot_text == "snapshot"
        assert rag_context.get_conversation_before_message_id() == current.id
        rag_started.set()
        await asyncio.wait_for(mcp_started.wait(), timeout=1)
        return {"tail": [], "blocks": [], "injected": False}

    monkeypatch.setattr(preparation, "_load_mcp_tools", fake_mcp)
    monkeypatch.setattr("agent.rag.injection.build_automatic_rag_context", fake_rag)

    tools, recalled = await asyncio.wait_for(
        preparation.load_mcp_tools_and_rag_context(
            "synthetic-owner", SimpleNamespace(), None,
            SimpleNamespace(message="合成测试查询"),
            history=[prior, current], snapshot_context="snapshot",
            user_message=current,
        ),
        timeout=2,
    )

    assert tools == ["mcp-tool"]
    assert recalled == {"tail": [], "blocks": [], "injected": False}
    assert rag_context.get_conversation_before_message_id() is None


@pytest.mark.asyncio
async def test_mcp_failure_cancels_rag_task_and_preserves_original_error(monkeypatch):
    """并发准备一侧失败时另一侧必须收尾，且错误类型不能被改写。"""
    rag_started = asyncio.Event()
    rag_cancelled = asyncio.Event()

    async def fail_mcp(*_args):
        await asyncio.wait_for(rag_started.wait(), timeout=1)
        raise RuntimeError("synthetic MCP failure")

    async def wait_for_cancel(*_args, **_kwargs):
        rag_started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            rag_cancelled.set()
            raise

    monkeypatch.setattr(preparation, "_load_mcp_tools", fail_mcp)
    monkeypatch.setattr(preparation.run_context,
                        "build_run_rag_context", wait_for_cancel)

    with pytest.raises(RuntimeError, match="synthetic MCP failure"):
        await preparation.load_mcp_tools_and_rag_context(
            "synthetic-owner", SimpleNamespace(), None,
            SimpleNamespace(message="合成测试查询"), history=[], snapshot_context="",
        )

    assert rag_cancelled.is_set()
