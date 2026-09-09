"""统一查询主链的检索器层单元契约：scope 收口矩阵与 Memory-only 瞬态规格。

旧的 batch/unified_shadow 影子模式测试已随 legacy 查询链删除（2026-09-09）。
"""
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from agent.rag.adapters.indexed_sources import IndexedSourceRetriever
from agent.rag.batch_retriever import UnifiedQueryRetriever
from agent.rag.models import Scope


class _StubRetriever:
    """满足统一链检索调度所需的最小来源桩。"""

    def __init__(self, user_id, source_type):
        self.user_id = user_id
        self.source_type = source_type
        self.source_filter = None

    @asynccontextmanager
    async def session_scope(self):
        yield object()


def test_persistent_specs_scope_matrix():
    """file/canvas/note/project 各自允许的 scope 类型被正确收口。"""
    owner = Scope("synthetic-owner")
    project = Scope("synthetic-owner", scope_type="project", scope_id="p1")
    folder = Scope("synthetic-owner", scope_type="folder", scope_id="f1")
    group = Scope("synthetic-owner", scope_type="group", scope_id="g1")
    stubs = [_StubRetriever("synthetic-owner", name)
             for name in ("file", "canvas", "note", "calendar", "scheduled_task", "conversation")]
    specs, allowed = UnifiedQueryRetriever([])._persistent_specs(
        stubs, [owner, project, folder, group], limit=5)
    by_source = {}
    for spec in specs:
        by_source.setdefault(next(iter(spec["source_types"])), []).append(spec["scope"].scope_type)
    assert sorted(by_source["file"]) == ["folder", "owner", "project"]
    assert sorted(by_source["canvas"]) == ["owner", "project"]
    assert by_source["note"] == ["owner"]
    assert by_source["calendar"] == ["owner"]
    assert by_source["scheduled_task"] == ["owner"]
    assert sorted(by_source["conversation"]) == ["folder", "group", "owner", "project"]
    assert allowed["note"] == [owner]
    assert allowed["calendar"] == [owner]
    assert allowed["scheduled_task"] == [owner]
    assert all(spec["limit"] == 5 for spec in specs)


def test_source_order_includes_calendar_sources():
    """日历和定时任务必须进入统一查询的稳定来源顺序。"""
    assert UnifiedQueryRetriever.SOURCE_ORDER == (
        "memory", "knowledge", "project", "file", "canvas", "note",
        "calendar", "scheduled_task", "conversation",
    )


@pytest.mark.asyncio
async def test_memory_only_query_runs_transient_spec_without_persistent_sources(monkeypatch):
    """只有 Memory 的显式查询：持久化索引仅作 IPC 宿主，searches 只含瞬态规格。"""
    from agent.rag import batch_retriever as br
    from agent.rag.models import IndexDocument

    calls = {}
    scope = Scope("synthetic-owner")
    memory_doc = IndexDocument("memory:daily-1", "memory", "daily", scope, "记忆", "", "缓存记忆", "v1")

    async def fake_load_memory(self, memory, inner_scope):
        return [memory_doc], "daily", {"document_load_ms": 1}

    async def replace_transient(documents, revision, *, vectors=None, vector_version=""):
        calls["transient"] = list(documents)

    async def unified_query(query, *, searches, query_vector, source_order,
                            candidate_limit, rank_options, before_message_id=None):
        calls["searches"] = searches
        calls["source_order"] = source_order
        return {
            "selected": [], "stats": {}, "fusion": {"fusion": "bm25"},
            "document_counts": {"memory": 1},
            "source_groups": {"memory": {"candidate_count": 1, "hit_count": 1}},
        }

    index = SimpleNamespace(
        client=SimpleNamespace(replace_transient=replace_transient),
        unified_query=unified_query, documents_by_id={},
    )

    @asynccontextmanager
    async def session_scope(self):
        yield object()

    async def get(*args, **kwargs):
        calls["prepare"] = True
        return index

    monkeypatch.setattr(UnifiedQueryRetriever, "_load_memory", fake_load_memory)
    monkeypatch.setattr(IndexedSourceRetriever, "session_scope", session_scope)
    monkeypatch.setattr(br, "get_index_cache", lambda: SimpleNamespace(get=get))

    retriever = UnifiedQueryRetriever([_StubRetriever("synthetic-owner", "memory")])
    batches = await retriever.retrieve("缓存", scope=scope, strategy="bm25")
    assert calls["prepare"]
    assert [spec.get("corpus") for spec in calls["searches"]] == ["transient"]
    assert calls["source_order"] == ["memory"]
    assert len(batches) == 1 and batches[0].source_type == "unified"
    assert batches[0].metadata["engine"] == "typescript"


@pytest.mark.asyncio
async def test_unknown_source_returns_empty_batches():
    """未知 source 值与旧交付路径同口径：返回空结果，不报错。"""
    retriever = UnifiedQueryRetriever([_StubRetriever("synthetic-owner", "memory")])
    assert await retriever.retrieve("缓存", source="daily") == []
