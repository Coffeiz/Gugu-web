"""保护 Cython RAG 地基的 CSR 输入契约和确定性布局。"""
from __future__ import annotations

import json
import subprocess
import tempfile
from collections import Counter
from dataclasses import replace
from pathlib import Path

import pytest

from agent.rag import cython_backend
from agent.rag.cython_backend import (
    CythonKernelUnavailable,
    CythonRagEngine,
    CythonRevisionMismatch,
    build_index,
    search,
)
from agent.rag.models import IndexDocument, Scope


def test_transient_index_reuse_refreshes_vectors_and_invalidates_changed_documents():
    """相同快照复用索引但更新向量，正文和可变 metadata 变化必须重建。"""
    document = IndexDocument("m", "memory", "daily", Scope("owner-a"), "标题", "", "旧内容", "v1", metadata={"x": "old"})
    engine = CythonRagEngine()
    engine.replace_transient([document], "r1", vectors={"k": [1.0]}, vector_version="v1")
    first = engine._transient
    engine.replace_transient([document], "r1", vectors={"k": [2.0]}, vector_version="v1")
    assert engine._transient is first
    assert engine._transient_vectors == {"k": [2.0]}
    changed = replace(document, content="新内容")
    engine.replace_transient([changed], "r1", vectors={}, vector_version="v1")
    assert engine._transient is not first
    second = engine._transient
    changed.metadata["x"] = "new"
    engine.replace_transient([changed], "r1", vectors={}, vector_version="v1")
    assert engine._transient is not second


def test_content_addressed_transient_revision_skips_redundant_document_fingerprints(monkeypatch):
    """Memory SHA revision 相同时复用索引；变化 revision 仍重建 transient postings。"""
    document = IndexDocument("m", "memory", "daily", Scope("owner-a"), "标题", "", "正文", "v1")
    engine = CythonRagEngine()

    def unexpected_fingerprint(*args, **kwargs):
        raise AssertionError("内容寻址 revision 已覆盖文档状态，不应再逐篇计算词法指纹")

    monkeypatch.setattr(cython_backend, "_lexical_fingerprint", unexpected_fingerprint)
    engine.replace_transient([document], "memory-sha-1", revision_is_content_addressed=True)
    first = engine._transient
    engine.replace_transient(
        [document], "memory-sha-1", vectors={"slot": [0.5]},
        vector_version="model:v1", revision_is_content_addressed=True,
    )
    assert engine._transient is first
    assert engine._transient_vectors == {"slot": [0.5]}

    changed = replace(document, content="更新正文")
    engine.replace_transient([changed], "memory-sha-2", revision_is_content_addressed=True)
    assert engine._transient is not first
    assert engine._transient.documents[0].content == "更新正文"


def test_transient_vector_install_reuses_immutable_cached_tuples_and_copies_mutable_lists():
    """Memory 向量缓存的 tuple 可安全共享；通用可变输入仍与调用方隔离。"""
    document = IndexDocument("m", "memory", "daily", Scope("owner-a"), "标题", "", "正文", "v1")
    engine = CythonRagEngine()
    immutable = (0.25, 0.75)
    mutable = [0.5, 0.5]

    engine.replace_transient(
        [document], "r1", vectors={"immutable": immutable, "mutable": mutable},
        revision_is_content_addressed=True,
    )

    assert engine._transient_vectors["immutable"] is immutable
    assert engine._transient_vectors["mutable"] == mutable
    assert engine._transient_vectors["mutable"] is not mutable
    mutable[0] = 9.0
    assert engine._transient_vectors["mutable"] == [0.5, 0.5]


def test_database_projection_and_incremental_patch_preserve_ts_text_rules():
    """数据库行重复摘要与会话 chunk 规则不能泄漏到 transient Memory。"""
    scope = Scope("owner-a")
    note = IndexDocument("n", "note", "n", scope, "标题", "摘要", "摘要 正文", "v1")
    conversation = IndexDocument("c", "conversation", "c", scope, "会话", "", "当前片段", "v1", metadata={"context_current": "完整消息"})
    engine = CythonRagEngine()
    engine.replace([note, conversation], "r1", database_projection=True)
    expected = ["标题\n摘要\n摘要 正文", "当前片段"]
    assert engine._persistent.bm25.document_lengths.tolist() == [len(cython_backend.tokenize_raw(text)) for text in expected]
    transient = cython_backend.CythonLexicalIndex.build([note], "t1")
    assert transient.bm25.document_lengths.tolist() == [len(cython_backend.tokenize_raw("标题\n摘要 正文"))]
    changed = replace(note, content="摘要 新正文")
    engine.patch([changed], [], revision="r2", base_revision="r1")
    rebuilt = cython_backend.CythonLexicalIndex.build(engine._persistent.documents, "r2", database_projection=True)
    assert engine._persistent.bm25 == rebuilt.bm25


def test_database_wire_uses_ts_text_and_timestamp_without_changing_transient_wire():
    scope = Scope("owner-a")
    note = IndexDocument("n", "note", "n", scope, "标题", "摘要", "摘要 正文", "v1", updated_at="2026-01-02T03:04:05+00:00")
    database = cython_backend._worker_document_wire(note, "note:n:0", True)
    transient = cython_backend._worker_document_wire(note, "note:n:0")
    assert database["text"] == "标题\n摘要\n摘要 正文"
    assert database["updated_at"] == "2026-01-02T03:04:05.000Z"
    assert transient["text"] == "标题\n摘要 正文"
    conversation = replace(note, source_type="conversation", content="片段", metadata={"context_current": "完整消息"})
    assert cython_backend._worker_document_wire(conversation, "c", True)["ranking_text"] == "片段"
    assert cython_backend._worker_document_wire(conversation, "c")["ranking_text"] == "完整消息"


def test_daily_later_chunk_keeps_summary_like_ts_projection():
    """daily 后续 chunk 仍注入原记录摘要，保持 TS 对长记录分块的词法文本。"""
    from agent.rag import cython_native
    document = IndexDocument("daily", "memory", "daily", Scope("owner-a"), "近期记忆", "开头摘要", "后续片段", "v1", chunk_index=1, chunk_count=2)
    expected = "近期记忆\n开头摘要\n后续片段"
    assert cython_backend._ranking_text(document) == expected
    assert cython_native.ranking_text_many([document]) == [expected]
    assert cython_backend._worker_document_wire(document, "memory:daily:1")["text"] == expected


def test_cython_index_preserves_document_and_term_posting_order() -> None:
    """相同 token 序列必须生成稳定 CSR，避免迁移后索引位置漂移。"""
    index = build_index([["alpha", "beta", "alpha"], ["beta", "gamma"]])

    assert index.document_lengths.tolist() == [3, 2]
    assert index.term_ids == {"alpha": 0, "beta": 1, "gamma": 2}
    assert index.term_offsets.tolist() == [0, 1, 3, 4]
    assert index.posting_document_ids.tolist() == [0, 0, 1, 1]
    assert index.posting_frequencies.tolist() == [2, 1, 1, 1]
    assert index.document_frequencies.tolist() == [1, 2, 1]
    assert index.document_tie_ranks.tolist() == [0, 1]
    assert index.average_length == 2.5


def test_cython_bm25_ties_follow_document_keys_instead_of_input_order() -> None:
    """BM25 同分时必须由稳定文档键决定顺序，不能依赖 DB 返回顺序。"""
    index = build_index([["same"], ["same"]], document_keys=["z:1", "a:1"])

    assert index.document_tie_ranks.tolist() == [1, 0]


def test_cython_bm25_ties_match_en_us_locale_order_for_mixed_case_ids() -> None:
    """同分 ID 必须复刻 TS en-US localeCompare，而非 Python 码点排序。"""
    index = build_index([['same'], ['same']], document_keys=['project:Z', 'project:a'])

    assert index.document_tie_ranks.tolist() == [1, 0]


def test_conversation_index_uses_full_current_message_for_chunk_ranking() -> None:
    """长群消息分块后，BM25 仍须使用 TS adapter 保存的完整当前消息文本。"""
    document = IndexDocument(
        document_id="message-chunk", source_type="conversation", source_id="message",
        scope=Scope("owner-a"), title="会话标题", summary="", content="当前消息片段",
        version="v1", metadata={"kind": "message", "context_current": "user：完整消息锚点"},
    )

    index = cython_backend.CythonLexicalIndex.build([document], "r1")
    expected_length = len(cython_backend.tokenize_raw("user：完整消息锚点"))

    assert index.bm25.document_lengths.tolist() == [expected_length]
    assert "完整" in index.bm25.term_ids
    assert "片段" not in index.bm25.term_ids
    frequencies, token_length = index.query_term_frequencies(
        index.document_keys[0], ["完整", "消息", "不存在"],
    )
    assert frequencies == {"完整": 1, "消息": 1}
    assert token_length == expected_length


def test_incremental_patch_reuses_unchanged_postings_and_matches_full_rebuild(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """单条 delta 只分词变化文档，删除和最终 CSR 必须与完整重建一致。"""
    def document(key: str, content: str) -> IndexDocument:
        return IndexDocument(
            document_id=f"{key}:v1:0", source_type="knowledge", source_id=key,
            scope=Scope("owner-a"), title="合成标题", summary="", content=content,
            version="v1", parent_document_id=key,
        )

    first = document("first", "共享词 alpha")
    second = document("second", "共享词 beta")
    removed = document("removed", "删除内容 gamma")
    changed = document("second", "新增词 beta delta")
    engine = CythonRagEngine()
    engine.replace([first, second, removed], "revision-1")

    from agent.rag import cython_native

    ranked_documents: list[tuple[IndexDocument, ...]] = []
    original_ranking_texts = cython_native.ranking_text_many

    def record_ranking_texts(documents):
        ranked_documents.append(tuple(documents))
        return original_ranking_texts(documents)

    monkeypatch.setattr(cython_native, "ranking_text_many", record_ranking_texts)
    engine.patch(
        [first, changed], ["knowledge:removed:0"], revision="revision-2",
        base_revision="revision-1",
    )
    assert ranked_documents == [(changed,)]

    expected_documents = [first, changed]
    oracle = CythonRagEngine()
    oracle.replace(expected_documents, "revision-2")
    actual = engine._persistent.bm25
    expected = oracle._persistent.bm25
    assert engine._persistent.documents == oracle._persistent.documents
    assert actual.document_lengths == expected.document_lengths
    assert set(actual.term_ids) == set(expected.term_ids)

    def postings_by_term(index: cython_backend.CythonBM25Index) -> dict[str, tuple[tuple[str, int], ...]]:
        result = {}
        for term, term_id in index.term_ids.items():
            start = index.term_offsets[term_id]
            end = index.term_offsets[term_id + 1]
            result[term] = tuple(
                (index.document_keys[index.posting_document_ids[offset]], index.posting_frequencies[offset])
                for offset in range(start, end)
            )
        return result

    # 增量索引允许 term ID 顺序不同；BM25 契约是每个 term 的 document/frequency postings 等价。
    assert postings_by_term(actual) == postings_by_term(expected)
    assert actual.document_tie_ranks == expected.document_tie_ranks
    assert actual.average_length == expected.average_length


def test_snapshot_tokens_reconstructed_from_csr_preserve_bm25_term_frequencies() -> None:
    """快照可从既有 postings 生成等价 token 多重集，无需再次运行 tokenizer。"""
    documents = [
        IndexDocument("one", "knowledge", "one", Scope("owner-a"), "标题", "", "alpha alpha beta", "v1"),
        IndexDocument("two", "knowledge", "two", Scope("owner-a"), "标题", "", "beta gamma", "v1"),
    ]
    index = cython_backend.CythonLexicalIndex.build(documents, "revision")
    reconstructed = index.tokens_by_document()

    assert [Counter(terms) for terms in reconstructed] == [
        Counter(cython_backend.tokenize_raw(cython_backend._ranking_text(document)))
        for document in documents
    ]
    assert [len(terms) for terms in reconstructed] == index.bm25.document_lengths.tolist()


def test_cython_index_rejects_ambiguous_document_keys() -> None:
    """重复键会让同分结果映射到非唯一文档，必须在建索引时失败。"""
    with pytest.raises(ValueError, match="必须唯一"):
        build_index([["one"], ["two"]], document_keys=["duplicate", "duplicate"])


def test_lexical_facade_matches_ts_duplicate_slot_scoring_and_last_document(monkeypatch: pytest.MonkeyPatch) -> None:
    """重复稳定槽位保留 TS 的重复统计、同 ID 分数累加和最后文档映射语义。"""
    first = IndexDocument(
        document_id="first", source_type="knowledge", source_id="same", scope=Scope("owner-a"),
        title="首条", summary="", content="alpha alpha", version="v1",
        parent_document_id="shared", chunk_index=0,
    )
    last = IndexDocument(
        document_id="last", source_type="knowledge", source_id="same", scope=Scope("owner-a"),
        title="末条", summary="", content="alpha beta beta", version="v2",
        parent_document_id="shared", chunk_index=0,
    )
    index = cython_backend.CythonLexicalIndex.build([first, last], "r1")
    first_length = len(cython_backend.tokenize_raw(cython_backend._ranking_text(first)))
    last_length = len(cython_backend.tokenize_raw(cython_backend._ranking_text(last)))
    assert index.bm25.document_count == 2
    assert index.bm25.document_lengths.tolist() == [last_length, last_length]
    assert index.bm25.average_length == (first_length + last_length) / 2
    assert index.bm25.document_frequencies[index.bm25.term_ids["alpha"]] == 2

    monkeypatch.setattr(
        cython_backend, "search",
        lambda _index, _terms, _limit, **_kwargs: [(0, 2.0), (1, 3.0)],
    )
    results, diagnostics = index.search("alpha", limit=5)

    assert [(item.document.document_id, item.score) for item in results] == [("last", 5.0)]
    assert diagnostics.candidate_count == 2


def test_cython_search_handles_empty_and_unknown_queries_without_loading_extension() -> None:
    """空语料或无命中词项应返回空结果，不要求编译扩展。"""
    empty = build_index([])
    populated = build_index([["known"]])

    assert search(empty, ["known"]) == []
    assert search(populated, ["unknown"]) == []


def test_cython_search_does_not_silently_fallback_when_extension_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """扩展缺失必须显式暴露，不能把 Python 或 TS 回退伪装成 Cython。"""
    index = build_index([["known"]])
    monkeypatch.setattr(cython_backend, "_import_kernel", lambda: (_ for _ in ()).throw(ImportError("missing")))

    with pytest.raises(CythonKernelUnavailable):
        search(index, ["known"])


def _document(
    document_id: str,
    source: str,
    content: str,
    *,
    scope: Scope | None = None,
    metadata: dict | None = None,
    title: str = "标题",
    summary: str = "摘要",
) -> IndexDocument:
    return IndexDocument(
        document_id=document_id,
        source_type=source,
        source_id=document_id,
        scope=scope or Scope("owner-a"),
        title=title,
        summary=summary,
        content=content,
        version="v1",
        metadata=metadata or {},
    )


def test_lexical_facade_filters_source_and_scope_after_full_corpus_scoring(monkeypatch: pytest.MonkeyPatch) -> None:
    """scope/source 只能筛选已由全语料统计打分的候选，不得重算局部 IDF。"""
    documents = [
        _document("a", "project", "query", metadata={"project_id": "other"}),
        _document("b", "knowledge", "query", metadata={"project_id": "wanted"}),
        _document("c", "knowledge", "query", metadata={"project_id": "wanted"}),
    ]
    index = cython_backend.CythonLexicalIndex.build(documents, "r1")
    scored_document_count: list[int] = []

    def fake_search(bm25, terms, limit, *, eligible_ids=None, eligible_mask=None):
        scored_document_count.append(bm25.document_count)
        assert eligible_ids is None
        assert list(eligible_mask) == [0, 1, 1]
        return [(2, 3.0), (1, 1.0)]

    monkeypatch.setattr(cython_backend, "search", fake_search)
    results, diagnostics = index.search(
        "query", source_types={"knowledge"}, scope=Scope("owner-a", scope_type="project", scope_id="wanted"),
        limit=1,
    )

    assert [item.document.document_id for item in results] == ["c"]
    assert scored_document_count == [3]
    assert diagnostics.candidate_count == 3
    assert diagnostics.eligible_count == 2
    assert diagnostics.filtered_count == 1
    assert diagnostics.source_filter_applied and diagnostics.scope_filter_applied


def test_lexical_facade_matches_member_scope_group_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    """成员 scope 可命中同群 group 文档，需复刻 TS 的专门分支。"""
    group = Scope("owner-a", "qq", "bot-a", "group-a", "group", "group-a")
    member_query = Scope("owner-a", "qq", "bot-a", "group-a", "member", "group-a:user-a")
    index = cython_backend.CythonLexicalIndex.build(
        [_document("group-memory", "memory", "群内资料", scope=group)], "r1",
    )
    monkeypatch.setattr(cython_backend, "search", lambda _index, _terms, _limit, **_kwargs: [(0, 1.0)])

    results, _ = index.search("资料", scope=member_query)

    assert [item.document.document_id for item in results] == ["group-memory"]


def test_scope_matrix_matches_ts_worker_for_owner_project_folder_and_group() -> None:
    """owner 隔离后的 project/folder/group scope 可见性与 TS worker 一致。"""
    from agent.rag.cython_backend import _worker_document_wire
    from agent.rag.delta import chunk_slot_key

    owner = "owner-a"
    documents = [
        _document("owner", "knowledge", "scope query", scope=Scope(owner)),
        _document("project", "project", "scope query", scope=Scope(owner), metadata={"project_id": "p1"}),
        _document("folder", "knowledge", "scope query", scope=Scope(owner), metadata={"folder_id": "f1"}),
        _document(
            "group", "memory", "scope query",
            scope=Scope(owner, "qq", "bot-a", "g1", "group", "g1"),
        ),
        _document(
            "member", "memory", "scope query",
            scope=Scope(owner, "qq", "bot-a", "g1", "member", "g1:u1"),
        ),
        _document(
            "other-platform", "memory", "scope query",
            scope=Scope(owner, "wechat", "bot-a", "g1", "group", "g1"),
        ),
    ]
    index = cython_backend.CythonLexicalIndex.build(documents, "r1")
    scope_cases = [
        None,
        Scope(owner),
        Scope(owner, scope_type="project", scope_id="p1"),
        Scope(owner, scope_type="folder", scope_id="f1"),
        Scope(owner, "qq", "bot-a", "g1", "group", "g1"),
        Scope(owner, "qq", "bot-a", "g1", "member", "g1:u1"),
    ]
    wire_documents = [
        _worker_document_wire(document, chunk_slot_key(document)) for document in documents
    ]
    requests = [{"op": "replace", "revision": "r1", "documents": wire_documents}]
    for scope in scope_cases:
        requests.append({
            "op": "search", "revision": "r1", "query": "scope query", "limit": 20,
            **({"scope": {
                "platform": scope.platform, "bot_id": scope.bot_id,
                "group_id": scope.group_id, "scope_type": scope.scope_type,
                "scope_id": scope.scope_id,
            }} if scope is not None else {}),
        })

    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input="".join(json.dumps(item, ensure_ascii=False) + "\n" for item in requests),
            text=True, capture_output=True, check=True, cwd=Path(__file__).parents[4], timeout=30,
        )
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]

    for scope, response in zip(scope_cases, responses[1:]):
        assert response["status"] == "ok"
        actual, diagnostics = index.search("scope query", limit=20, scope=scope)
        assert [(chunk_slot_key(row.document), row.score) for row in actual] == [
            (row["id"], row["score"]) for row in response["results"]
        ]
        expected_diagnostics = response["diagnostics"]
        assert diagnostics.candidate_count == expected_diagnostics["candidate_count"]
        assert diagnostics.eligible_count == expected_diagnostics["eligible_count"]
        assert diagnostics.filtered_count == expected_diagnostics["filtered_count"]
        assert diagnostics.scope_filter_applied == expected_diagnostics["scope_filter_applied"]


def test_engine_revision_patch_transient_and_conversation_watermark_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    """revision mismatch 不改状态；水位只排除无效或不早于水位的 conversation message。"""
    engine = CythonRagEngine()
    documents = [
        _document("old", "conversation", "旧消息", metadata={"kind": "message", "message_id": "10"}),
        _document("new", "conversation", "新消息", metadata={"kind": "message", "message_id": "20"}),
        _document("bad", "conversation", "坏 id", metadata={"kind": "message", "message_id": "unknown"}),
        _document("summary", "conversation", "会话摘要", metadata={"kind": "summary"}),
    ]
    engine.replace(documents, "r1")
    engine.replace_transient([_document("temp", "memory", "瞬态记忆")], "t1")
    monkeypatch.setattr(cython_backend, "search", lambda index, _terms, _limit, **_kwargs: [
        (position, 4.0 - position) for position in range(index.document_count)
    ])

    results, _ = engine.query("消息", revision="r1", before_message_id=20)
    assert [item.document.document_id for item in results] == ["old", "summary"]
    transient, _ = engine.query("记忆", revision="r1", transient_revision="t1", corpus="transient")
    assert [item.document.document_id for item in transient] == ["temp"]
    with pytest.raises(CythonRevisionMismatch):
        engine.query("消息", revision="stale")
    with pytest.raises(CythonRevisionMismatch):
        engine.query("记忆", revision="r1", transient_revision="stale", corpus="transient")
    with pytest.raises(CythonRevisionMismatch):
        engine.patch([], [], revision="r2", base_revision="stale")
    assert engine.revision == "r1"


def test_unified_query_merges_sources_applies_watermark_and_returns_worker_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    """统一查询按来源聚合并应用 conversation 水位，且 selected 保留 worker 文档形状。"""
    engine = CythonRagEngine()
    project = _document("project-1", "project", "alpha 项目计划", metadata={"project_id": "p1"})
    old_message = _document(
        "message-10", "conversation", "alpha 旧消息",
        metadata={"kind": "message", "message_id": "10", "context_current": "alpha 旧消息"},
    )
    new_message = _document(
        "message-20", "conversation", "alpha 新消息",
        metadata={"kind": "message", "message_id": "20", "context_current": "alpha 新消息"},
    )
    engine.replace([project, old_message, new_message], "rev-1")

    monkeypatch.setattr(cython_backend, "search", lambda index, _terms, _limit, **_kwargs: [
        (position, 3.0 - position) for position in range(index.document_count)
    ])
    result = engine.unified_query(
        "alpha 项目",
        revision="rev-1",
        searches=[{"source_types": {"project"}}, {"source_types": {"conversation"}}],
        source_order=["conversation", "project"],
        candidate_limit=10,
        before_message_id=20,
        rank_options={"limit": 10, "selection_mode": "top_k"},
    )

    assert result["status"] == "ok"
    assert result["document_counts"] == {"project": 1, "conversation": 2}
    assert result["source_groups"] == {
        "project": {"candidate_count": 1, "hit_count": 1},
        "conversation": {"candidate_count": 1, "hit_count": 1},
    }
    selected = result["selected"]
    assert isinstance(selected, list)
    selected_documents = [item["document"] for item in selected]
    assert {item["content"] for item in selected_documents} == {"alpha 项目计划", "alpha 旧消息"}
    conversation = next(item for item in selected_documents if item["source_type"] == "conversation")
    assert conversation["content"] == "alpha 旧消息"


def test_unified_query_requires_transient_revision_only_when_requested() -> None:
    """只有搜索声明 transient corpus 时才必须携带对应 revision。"""
    engine = CythonRagEngine()
    engine.replace([_document("p", "project", "alpha")], "rev-1")
    engine.replace_transient([_document("m", "memory", "alpha")], "transient-1")
    common = {
        "revision": "rev-1", "source_order": [], "candidate_limit": 3,
        "rank_options": {"selection_mode": "top_k"},
    }

    result = engine.unified_query(
        "alpha", searches=[{"source_types": {"project"}}], **common,
    )
    assert result["status"] == "ok"
    with pytest.raises(CythonRevisionMismatch, match="瞬态"):
        engine.unified_query(
            "alpha", searches=[{"source_types": {"memory"}, "corpus": "transient"}], **common,
        )


def test_merged_idf_statistics_reuse_until_either_index_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    """查询复用不可变语料 DF/平均长度统计；任一 corpus 更新后必须重算 IDF。"""
    engine = CythonRagEngine()
    engine.replace([_document("p", "project", "alpha beta")], "rev-1")
    engine.replace_transient([_document("m", "memory", "alpha gamma")], "transient-1")
    common = {
        "revision": "rev-1", "transient_revision": "transient-1",
        "searches": [{"source_types": {"project"}}, {
            "source_types": {"memory"}, "corpus": "transient",
        }],
        "source_order": ["project", "memory"], "candidate_limit": 5,
        "rank_options": {"limit": 5, "selection_mode": "top_k"},
    }
    original = cython_backend._merged_statistics
    builds = 0

    def counted(indices):
        nonlocal builds
        builds += 1
        return original(indices)

    monkeypatch.setattr(cython_backend, "_merged_statistics", counted)
    first = engine.unified_query("alpha", **common)
    second = engine.unified_query("alpha", **common)
    assert first["selected"] == second["selected"]
    assert builds == 1

    engine.replace_transient([_document("m", "memory", "alpha gamma delta")], "transient-2")
    changed = engine.unified_query(
        "alpha", **{**common, "transient_revision": "transient-2"},
    )
    assert changed["status"] == "ok"
    assert builds == 2

    engine.replace([_document("p", "project", "alpha beta epsilon")], "rev-2")
    changed_persistent = engine.unified_query(
        "alpha", **{**common, "revision": "rev-2", "transient_revision": "transient-2"},
    )
    assert changed_persistent["status"] == "ok"
    assert builds == 3


def test_batch_search_and_legacy_unified_search_preserve_document_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    """迁移期保留 TS batch_search 与 unified_search 的独立协议语义。"""
    engine = CythonRagEngine()
    documents = [
        _document("p1", "project", "alpha 项目实施计划"),
        _document("k1", "knowledge", "alpha 缓存知识"),
    ]
    engine.replace(documents, "rev-1")
    monkeypatch.setattr(cython_backend, "search", lambda index, _terms, _limit, **_kwargs: [
        (position, 2.0 - position) for position in range(index.document_count)
    ])

    batches = engine.batch_search(
        "alpha", revision="rev-1", searches=[
            {"id": "projects", "source_types": {"project"}},
            {"id": "knowledge", "source_types": {"knowledge"}},
        ],
    )
    assert [batch["id"] for batch in batches["batches"]] == ["projects", "knowledge"]
    assert [batch["results"][0]["document"]["content"] for batch in batches["batches"]] == [
        "alpha 项目实施计划", "alpha 缓存知识",
    ]

    unified = engine.unified_search("alpha", revision="rev-1", limit=2)
    assert unified["status"] == "ok"
    assert {row["content"] for row in unified["results"]} == {
        "alpha 项目实施计划", "alpha 缓存知识",
    }


def test_engine_tracks_persistent_and_transient_vector_versions_independently() -> None:
    """持久向量整表替换与 transient Memory 生命周期互不串槽、互不继承。"""
    engine = CythonRagEngine()
    vector_map = {"knowledge:one:0": [0.25, 0.75]}
    engine.set_vectors(vector_map, "provider:model-a:2")
    vector_map["knowledge:one:0"][0] = 9.0

    assert engine.vector_count == 1
    assert engine.vector_version == "provider:model-a:2"
    assert engine._vectors["knowledge:one:0"] == [0.25, 0.75]

    engine.replace_transient(
        [_document("memory", "memory", "临时记忆")], "t1",
        vectors={"memory:memory:0": [1.0, 0.0]},
        vector_version="provider:model-b:2",
    )
    assert engine.transient_vector_count == 1
    assert engine.transient_vector_version == "provider:model-b:2"
    assert engine.vector_version == "provider:model-a:2"

    engine.replace_transient([], "t2")
    assert engine.transient_vector_count == 0
    assert engine.transient_vector_version == ""
    assert engine.vector_count == 1


def test_engine_group_fusion_requires_persistent_vector_version_match(monkeypatch: pytest.MonkeyPatch) -> None:
    """unified_query 遇到过期持久向量时保留 BM25 原分，不得静默混模。"""
    engine = CythonRagEngine()
    engine.set_vectors({"a": [1.0, 0.0]}, "provider:model-v2")
    hits = [{"chunk_id": "a", "score": 3.25}, {"chunk_id": "b", "score": 1.5}]

    stale_rows, stale = engine.fuse_group(
        hits, [1.0, 0.0], expected_vector_version="provider:model-v1",
    )
    assert stale_rows == hits
    assert stale["fusion"] == "bm25"
    assert stale["fallback"] == "embedding_cache_unavailable"

    def fake_fuse(ids, _query, _vectors, **_kwargs):
        return ({"a": 1.0, "b": 0.5}, 1, {"a": 1.0})

    monkeypatch.setattr(cython_backend, "hybrid_fuse_scores", fake_fuse)
    fused_rows, fused = engine.fuse_group(
        hits, [1.0, 0.0], expected_vector_version="provider:model-v2",
    )
    assert fused_rows == [{"chunk_id": "a", "score": 1.0}, {"chunk_id": "b", "score": 0.5}]
    assert fused["fusion"] == "hybrid-rrf"
    assert fused["vector_doc_count"] == 1
    assert fused["vector_version"] == "provider:model-v2"
    assert fused["semantic_scores"] == {"a": 1.0}


def test_engine_transient_group_fusion_uses_its_own_vector_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    """瞬态 Memory 融合读取 transient 向量版本，不受持久模型版本门控。"""
    engine = CythonRagEngine()
    engine.set_vectors({"persistent": [1.0, 0.0]}, "provider:persistent-v1")
    engine.replace_transient(
        [_document("memory", "memory", "瞬态记忆")], "t1",
        vectors={"memory": [0.0, 1.0]}, vector_version="provider:memory-v3",
    )
    observed: list[dict[str, list[float]]] = []

    def fake_fuse(ids, _query, vectors, **_kwargs):
        observed.append(dict(vectors))
        return ({"memory": 0.75}, 1, {"memory": 0.25})

    monkeypatch.setattr(cython_backend, "hybrid_fuse_scores", fake_fuse)
    rows, diagnostics = engine.fuse_group(
        [{"chunk_id": "memory", "score": 2.0}], [1.0, 0.0],
        corpus="transient", expected_vector_version="unrelated",
    )

    assert observed == [{"memory": [0.0, 1.0]}]
    assert rows == [{"chunk_id": "memory", "score": 0.75}]
    assert diagnostics["fusion"] == "hybrid-rrf"
    assert diagnostics["vector_version"] == "provider:memory-v3"


def test_engine_patch_applies_stable_slot_upserts_and_deletes() -> None:
    """patch 通过稳定 chunk slot 替换与删除条目，并在 revision 原子推进。"""
    engine = CythonRagEngine()
    old = _document("parent", "knowledge", "旧正文")
    old = IndexDocument(**{**old.__dict__, "parent_document_id": "parent"})
    engine.replace([old], "r1")
    updated = IndexDocument(**{**old.__dict__, "content": "新正文", "version": "v2"})
    added = _document("added", "note", "新增正文")

    engine.patch([updated, added], [], revision="r2", base_revision="r1")

    assert engine.revision == "r2"
    assert set(engine._persistent.document_keys) == {"knowledge:parent:0", "note:added:0"}
    assert engine._persistent.documents[0].content == "新正文"


def test_engine_patch_preserves_unchanged_order_and_appends_upserts_in_request_order() -> None:
    """增量更新保留未变文档顺序，并按 TS worker 的 upsert 顺序追加变更项。"""
    engine = CythonRagEngine()
    first = _document("first", "knowledge", "旧首项")
    second = _document("second", "knowledge", "保留项")
    third = _document("third", "knowledge", "旧末项")
    engine.replace([first, second, third], "r1")

    updated_first = IndexDocument(**{**first.__dict__, "content": "新首项"})
    added = _document("added", "note", "新增项")
    engine.patch([updated_first, added], [], revision="r2", base_revision="r1")

    assert [document.document_id for document in engine._persistent.documents] == [
        "second", "third", "first", "added",
    ]


def test_engine_patch_skips_lexically_unchanged_upsert_without_reordering() -> None:
    """仅 revision/更新时间变化不重装文档，也不改变同分检索的稳定顺序。"""
    engine = CythonRagEngine()
    first = _document("first", "knowledge", "首项")
    second = _document("second", "knowledge", "次项")
    engine.replace([first, second], "r1")
    metadata_only_update = IndexDocument(**{
        **first.__dict__, "version": "v2", "updated_at": "later",
    })

    engine.patch([metadata_only_update], [], revision="r2", base_revision="r1")

    assert [document.document_id for document in engine._persistent.documents] == ["first", "second"]
    assert engine._persistent.documents[0].version == first.version


def test_lexical_fingerprint_uses_node_utf8_replacement_for_unpaired_surrogate() -> None:
    """TS crypto 对孤立代理项按 U+FFFD 编码，Python 指纹必须保持一致。"""
    from agent.rag.cython_backend import _lexical_fingerprint

    document = _document("surrogate", "knowledge", "正文\ud83d")
    expected = IndexDocument(**{**document.__dict__, "content": "正文\ufffd"})

    assert _lexical_fingerprint(document) == _lexical_fingerprint(expected)


def test_hybrid_fusion_preserves_mismatched_vectors_and_lexical_only_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """向量维度不匹配仍以零分参与向量名次；无向量候选仍保留 lexical RRF。"""
    from types import SimpleNamespace
    import sys

    def cosine_scores(query, flattened, offsets, lengths):
        values = flattened.tolist()
        result = []
        for index, length in enumerate(lengths):
            if not length:
                continue
            vector = values[offsets[index]:offsets[index + 1]]
            if len(vector) != len(query):
                result.append((index, 0.0))
            else:
                result.append((index, sum(a * b for a, b in zip(query, vector))))
        return result

    monkeypatch.setitem(
        sys.modules,
        "agent.rag.cython_kernel",
        SimpleNamespace(cosine_scores=cosine_scores),
    )

    fused, vector_count, semantic = cython_backend.hybrid_fuse_scores(
        ["a", "b", "c", "d"],
        [1.0, 0.0],
        {"a": [1.0, 0.0], "b": [0.0, 1.0], "c": [99.0]},
    )

    assert vector_count == 3
    assert semantic == {"a": 1.0, "b": 0.0, "c": 0.0}
    assert fused["a"] == pytest.approx(0.45 * 61 / 61 + 0.55 * 61 / 61)
    assert fused["b"] == pytest.approx(0.45 * 61 / 62 + 0.55 * 61 / 62)
    assert fused["c"] == pytest.approx(0.45 * 61 / 63 + 0.55 * 61 / 63)
    assert fused["d"] == pytest.approx(0.45 * 61 / 64)


def test_hybrid_fusion_with_no_vector_candidates_requests_existing_fallback() -> None:
    fused, vector_count, semantic = cython_backend.hybrid_fuse_scores(
        ["a"], [1.0], {},
    )

    assert fused == {}
    assert vector_count == 0
    assert semantic == {}


def test_hybrid_fusion_ignores_empty_candidate_vectors_like_ts() -> None:
    fused, vector_count, semantic = cython_backend.hybrid_fuse_scores(
        ["empty", "missing"], [1.0, 0.0], {"empty": []},
    )

    assert fused == {}
    assert vector_count == 0
    assert semantic == {}


def test_hybrid_operation_passthrough_preserves_lexical_order_and_scores() -> None:
    hits = [
        {"chunk_id": "z", "score": 0.8},
        {"chunk_id": "a", "score": 0.4},
    ]

    results, diagnostics = cython_backend.fuse_hybrid_candidates(
        hits, [], {"z": [1.0]}, limit=1, vector_version="model-v1",
    )

    assert results == [{"chunk_id": "z", "score": 0.8}]
    assert diagnostics == {
        "fusion": "bm25", "vector_doc_count": 0,
        "vector_version": "model-v1", "fallback": "embedding_cache_unavailable",
    }


def test_hybrid_operation_without_candidate_vectors_uses_sorted_lexical_rrf() -> None:
    hits = [
        {"chunk_id": "b", "score": 0.8},
        {"chunk_id": "a", "score": 0.4},
    ]

    results, diagnostics = cython_backend.fuse_hybrid_candidates(
        hits, [1.0], {"unrelated": [1.0]},
    )

    assert [item["chunk_id"] for item in results] == ["b", "a"]
    assert [item["score"] for item in results] == pytest.approx([
        0.45 * 61 / 61, 0.45 * 61 / 62,
    ])
    assert diagnostics["fusion"] == "bm25"
    assert diagnostics["fallback"] == "embedding_cache_unavailable"


def test_idf_rescore_facade_builds_query_and_document_frequencies(monkeypatch: pytest.MonkeyPatch) -> None:
    """rank_text 与去重 query token 必须生成 TS IDF-rescore 输入布局。"""
    document = _document(
        "idf", "knowledge", "summary prefix alpha alpha",
        title="alpha", summary="summary prefix",
    )
    observed: dict[str, list[int]] = {}

    def fake_idf_kernel(df_values, tf_values, document_count, average_length, document_length):
        observed.update({
            "df": df_values.tolist(),
            "tf": tf_values.tolist(),
            "document_count": document_count,
            "document_length": document_length,
        })
        return 1.25, [(0, 1.0), (1, 1.5)], [(0, 1.0, 1.0, 3, 2.0, 2.8284271247461903)]

    monkeypatch.setattr(cython_backend, "_load_idf_kernel", lambda: fake_idf_kernel)

    result = cython_backend.idf_rescore_document(
        "alpha missing alpha", document,
        document_count=5,
        average_length=8.0,
        document_frequency={"alpha": 2, "missing": 1},
    )

    assert observed == {"df": [2, 1], "tf": [3, 0], "document_count": 5, "document_length": 5}
    assert result is not None
    assert result["rank_score"] == pytest.approx(2.8284271247461903)
    assert result["matched_terms"] == ["alpha"]
    assert result["query_idf_terms"] == [
        {"term": "alpha", "idf": 1.0}, {"term": "missing", "idf": 1.5},
    ]
    optimized = cython_backend.idf_rescore_query_terms(
        ["alpha", "missing", "alpha"], {"alpha": 3}, 5,
        document_count=5, average_length=8.0,
        document_frequency={"alpha": 2, "missing": 1},
    )
    assert optimized == result
