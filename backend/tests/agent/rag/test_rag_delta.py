"""PRD-RAG-9 Phase 0：通用 chunk diff 契约与确定性回归。

覆盖：内容/标题/摘要/scope 变化触发 upsert；纯版本变化不触发；chunk 数
减少产生 deletes；无变化为 no-op；同一输入重复计算结果确定；契约版本前缀
进入 revision。
"""
from __future__ import annotations

import pytest

from agent.rag.delta import (
    ChunkDelta,
    chunk_slot_key,
    compute_chunk_delta,
    document_digest,
    parent_document_key,
    projection_revision_stamp,
)
from agent.rag.models import IndexDocument, Scope
from agent.rag.protocol import RAG_PROJECTION_VERSION, TOKENIZER_VERSION


def _doc(source_id: str = "1", *, content: str = "正文", title: str = "标题",
         version: str = "1", chunk_index: int = 0, chunk_count: int = 1,
         scope_type: str = "owner", parent_id: str | None = None,
         summary: str = "") -> IndexDocument:
    return IndexDocument(
        document_id=parent_id or source_id,
        source_type="knowledge",
        source_id=source_id,
        scope=Scope(owner_user_id="owner", scope_type=scope_type),
        title=title,
        summary=summary,
        content=content,
        version=version,
        chunk_index=chunk_index,
        chunk_count=chunk_count,
        parent_document_id=parent_id,
    )


def test_chunk_slot_contract_is_stable():
    doc = _doc("42", chunk_index=2, chunk_count=3)
    assert parent_document_key(doc) == "knowledge:42"
    assert chunk_slot_key(doc) == "knowledge:42:2"
    # parent_document_id 优先于 document_id
    assert chunk_slot_key(_doc("42", parent_id="42")) == "knowledge:42:0"


def test_document_digest_ignores_version():
    assert document_digest(_doc(version="1")) == document_digest(_doc(version="2"))


def test_content_change_is_upsert_and_old_slot_survives():
    previous = [_doc(content="旧正文")]
    current = [_doc(content="新正文")]
    delta = compute_chunk_delta(previous, current)
    assert [doc.content for doc in delta.upserts] == ["新正文"]
    assert delta.deletes == ()
    assert delta.unchanged == ()


def test_chunk_shrink_moves_removed_slots_into_deletes():
    previous = [_doc(chunk_index=0, chunk_count=2), _doc("1", content="第二段", chunk_index=1, chunk_count=2)]
    current = [_doc(chunk_index=0, chunk_count=1)]
    delta = compute_chunk_delta(previous, current)
    assert [doc.chunk_index for doc in delta.upserts] == [0]  # chunk_count 变化 → 重新投影
    assert delta.deletes == ("knowledge:1:1",)


def test_no_change_is_noop_and_idempotent():
    docs = [_doc(), _doc("2", content="另一条")]
    delta = compute_chunk_delta(docs, docs)
    assert delta == ChunkDelta(upserts=(), deletes=(), unchanged=(
        "knowledge:1:0", "knowledge:2:0",
    ))
    # 重复事件（同一投影重放）必然 no-op
    assert compute_chunk_delta(current=docs, previous=docs).is_empty


def test_delete_removes_all_slots_of_the_document():
    previous = [_doc(chunk_index=0), _doc(chunk_index=1), _doc(chunk_index=2)]
    delta = compute_chunk_delta(previous, [])
    assert delta.upserts == ()
    assert delta.deletes == ("knowledge:1:0", "knowledge:1:1", "knowledge:1:2")


def test_scope_change_is_upsert():
    previous = [_doc(scope_type="owner")]
    current = [_doc(scope_type="group")]
    delta = compute_chunk_delta(previous, current)
    assert len(delta.upserts) == 1


def test_diff_is_deterministic_regardless_of_input_order():
    current = [_doc(str(i), content=f"正文{i}") for i in range(20)]
    previous = [_doc(str(i), content=f"旧{i}") for i in range(20)]
    first = compute_chunk_delta(previous, list(reversed(current)))
    second = compute_chunk_delta(list(reversed(previous)), current)
    assert first == second
    assert [chunk_slot_key(doc) for doc in first.upserts] == sorted(
        chunk_slot_key(doc) for doc in current
    )


def test_projection_version_stamp_matches_protocol():
    assert projection_revision_stamp() == f"{TOKENIZER_VERSION}:{RAG_PROJECTION_VERSION}"
