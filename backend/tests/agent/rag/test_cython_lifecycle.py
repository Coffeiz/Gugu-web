"""Cython RAG 数据库快照与增量生命周期行为回归。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from dataclasses import replace
import json
import asyncio
from collections import Counter, OrderedDict
from types import SimpleNamespace

import pytest

from agent.rag.cython_lifecycle import CythonRagLifecycle
from agent.rag.persistent_store import (
    RagIndexCursor,
    load_rag_index_delta,
    load_rag_index_revision,
    load_rag_index_snapshot,
    replace_source_documents,
)
from agent.rag.models import IndexDocument, Scope


def _doc(source_id: str, content: str, owner_user_id: object) -> IndexDocument:
    return IndexDocument(
        document_id=f"{source_id}:v1:0", source_type="knowledge", source_id=source_id,
        scope=Scope(owner_user_id=str(owner_user_id), scope_type="owner"),
        title="合成标题", summary="", content=content, version="v1",
        chunk_index=0, chunk_count=1, parent_document_id=source_id,
    )


def test_snapshot_memory_filter_reuses_normalized_context_without_changing_match_rules():
    """批量覆盖判断复用预处理结果，同时保留 UTF-16 与空白归一语义。"""
    from agent.rag.cython_lifecycle import (
        _normalized_snapshot_context,
        _snapshot_covers,
        _snapshot_covers_context,
    )

    content = ("记忆😀内容\t" * 30).strip()
    snapshot = f"历史前缀\n{content}\u3000历史后缀"
    normalized = _normalized_snapshot_context(snapshot)

    assert _snapshot_covers(content, snapshot)
    assert _snapshot_covers_context(content, normalized)
    assert not _snapshot_covers_context("另一段完全不同的记忆" * 20, normalized)
    assert not _snapshot_covers_context(content, _normalized_snapshot_context("  \n\t"))


@pytest.mark.asyncio
async def test_lightweight_rag_revision_matches_full_snapshot_even_with_tombstones(db, user_a):
    """快照有效性探测须与完整读取使用相同 owner/source revision 契约。"""
    await replace_source_documents(db, user_a.id, "knowledge", [_doc("k1", "live", user_a.id)])
    assert await load_rag_index_revision(db, user_a.id) == (
        await load_rag_index_snapshot(db, user_a.id)
    ).revision

    await replace_source_documents(db, user_a.id, "knowledge", [])
    snapshot = await load_rag_index_snapshot(db, user_a.id)
    assert snapshot.documents == ()
    assert snapshot.revision is not None
    assert await load_rag_index_revision(db, user_a.id) == snapshot.revision


@pytest.mark.asyncio
async def test_cython_snapshot_row_transform_matches_python_contract(db, user_a):
    """编译行转换须与 Python 快照保持文档、revision 和 watermark 完全一致。"""
    await replace_source_documents(db, user_a.id, "knowledge", [
        _doc("live-a", "首条正文", user_a.id),
        _doc("live-b", "次条正文", user_a.id),
    ])
    await replace_source_documents(db, user_a.id, "knowledge", [_doc("live-a", "更新正文", user_a.id)])

    python_snapshot = await load_rag_index_snapshot(db, user_a.id)
    cython_snapshot = await load_rag_index_snapshot(
        db, user_a.id, cython_transform=True,
    )

    assert cython_snapshot == python_snapshot


@pytest.mark.asyncio
async def test_snapshot_keeps_tombstone_only_source_and_owner_isolation(db, user_a, user_b):
    """仅墓碑来源仍推进 revision/watermark，其他用户文档不可进入快照。"""
    await replace_source_documents(db, user_a.id, "knowledge", [_doc("gone", "旧正文", user_a.id)])
    await replace_source_documents(db, user_a.id, "knowledge", [])
    await replace_source_documents(db, user_a.id, "project", [replace(_doc("live", "保留正文", user_a.id), source_type="project")])
    await replace_source_documents(db, user_b.id, "knowledge", [_doc("other", "其他用户", user_b.id)])

    python_snapshot = await load_rag_index_snapshot(db, user_a.id)
    cython_snapshot = await load_rag_index_snapshot(db, user_a.id, cython_transform=True)
    assert cython_snapshot == python_snapshot
    assert python_snapshot.revision == await load_rag_index_revision(db, user_a.id)
    assert "knowledge:" in python_snapshot.revision
    assert python_snapshot.watermark is not None
    assert [document.source_id for document in python_snapshot.documents] == ["live"]


@pytest.mark.parametrize("database_projection", [False, True])
def test_snapshot_restores_its_projection_mode(tmp_path, database_projection):
    """快照携带建索引规则，恢复后增量不能切换摘要投影语义。"""
    owner = "synthetic-owner"
    document = replace(_doc("item", "摘要 正文", owner), summary="摘要")
    lifecycle = CythonRagLifecycle()
    lifecycle.engine.replace([document], "r1", database_projection=database_projection)
    lifecycle.persist_snapshot(tmp_path, owner)
    restored = CythonRagLifecycle()
    assert restored.restore_snapshot(tmp_path, owner)["status"] == "restored"
    assert restored.engine._persistent.database_projection is database_projection
    assert restored.engine._persistent.bm25 == lifecycle.engine._persistent.bm25


@pytest.mark.asyncio
async def test_cython_delta_row_transform_matches_python_contract(db, user_a):
    """编译增量行转换须保留 upsert、墓碑 key 与游标语义。"""
    await replace_source_documents(db, user_a.id, "knowledge", [
        _doc("delta-a", "初始正文 A", user_a.id),
        _doc("delta-b", "待删除正文 B", user_a.id),
    ])
    initial = await load_rag_index_snapshot(db, user_a.id)
    await replace_source_documents(db, user_a.id, "knowledge", [_doc("delta-a", "更新正文 A", user_a.id)])

    python_delta = await load_rag_index_delta(db, user_a.id, initial.watermark)
    cython_delta = await load_rag_index_delta(
        db, user_a.id, initial.watermark, cython_transform=True,
    )

    assert cython_delta == python_delta


@pytest.mark.asyncio
async def test_cython_lifecycle_load_then_incremental_upsert_and_tombstone(db, user_a, monkeypatch):
    """冷加载和后续 delta 应保留 live 文档、删除槽位及 revision。"""
    monkeypatch.setattr(
        CythonRagLifecycle, "_read_vectors", staticmethod(_empty_vectors),
    )
    await replace_source_documents(db, user_a.id, "knowledge", [
        _doc("k1", "旧正文", user_a.id), _doc("k2", "待删除正文", user_a.id),
    ])
    lifecycle = CythonRagLifecycle()
    initial = await load_rag_index_snapshot(db, user_a.id)
    loaded = await lifecycle.load_index_from_database(
        db, user_a.id, revision=initial.revision or "",
    )
    assert loaded["document_count"] == 2

    await replace_source_documents(db, user_a.id, "knowledge", [_doc("k1", "新正文", user_a.id)])
    current = await load_rag_index_snapshot(db, user_a.id)
    synced = await lifecycle.sync_index_from_database(
        db, user_a.id, current.revision or "",
    )
    assert synced["fallback_full"] == 0
    assert synced["applied_upserts"] == 1
    assert synced["applied_deletes"] == 1
    assert lifecycle.engine.revision == current.revision
    assert [(doc.source_id, doc.content) for doc in lifecycle.engine._persistent.documents] == [
        ("k1", "新正文"),
    ]


@pytest.mark.asyncio
async def test_snapshot_persistence_debounces_incremental_revisions_and_flushes_latest(
    db, user_a, tmp_path, monkeypatch,
):
    """连续增量先更新内存，合并成一次延迟快照写入且最终快照追上最新水位。"""
    import agent.rag.cython_lifecycle as lifecycle_module

    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(_empty_vectors))
    monkeypatch.setattr(lifecycle_module, "SNAPSHOT_PERSIST_DEBOUNCE_SECONDS", 60)
    await replace_source_documents(db, user_a.id, "knowledge", [_doc("k1", "初始正文", user_a.id)])
    lifecycle = CythonRagLifecycle()
    initial = await lifecycle.load_index_from_snapshot_or_database(db, user_a.id, tmp_path)
    assert initial["snapshot_saved"] is True
    persisted_revision = lifecycle.engine.revision

    writes: list[str] = []
    original_write = lifecycle_module._write_snapshot_state

    def count_snapshot_write(index_dir, state):
        writes.append(state.revision)
        return original_write(index_dir, state)

    monkeypatch.setattr(lifecycle_module, "_write_snapshot_state", count_snapshot_write)
    await replace_source_documents(db, user_a.id, "knowledge", [_doc("k1", "第一次增量", user_a.id)])
    first = await lifecycle.load_index_from_snapshot_or_database(db, user_a.id, tmp_path)
    first_revision = lifecycle.engine.revision
    assert first["snapshot_status"] == "incremental_refresh"
    assert first["snapshot_save_scheduled"] is True

    await replace_source_documents(db, user_a.id, "knowledge", [_doc("k1", "第二次增量", user_a.id)])
    second = await lifecycle.load_index_from_snapshot_or_database(db, user_a.id, tmp_path)
    latest_revision = lifecycle.engine.revision
    assert second["snapshot_status"] == "incremental_refresh"
    assert latest_revision != first_revision
    assert writes == []
    assert json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))["revision"] == persisted_revision

    await lifecycle.flush_snapshot_persistence()
    assert writes == [latest_revision]
    recovered = CythonRagLifecycle()
    restored = recovered.restore_snapshot(tmp_path, user_a.id, expected_revision=latest_revision)
    assert restored["status"] == "restored"
    assert recovered.engine._persistent.documents[0].content == "第二次增量"


@pytest.mark.asyncio
async def test_snapshot_debounce_keeps_latest_generation_after_mutation_lock_wait(
    db, user_a, tmp_path, monkeypatch,
):
    """等待 mutation lock 时若又有增量，必须落盘锁释放后的最新 revision。"""
    import agent.rag.cython_lifecycle as lifecycle_module

    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(_empty_vectors))
    monkeypatch.setattr(lifecycle_module, "SNAPSHOT_PERSIST_DEBOUNCE_SECONDS", 0.01)
    await replace_source_documents(db, user_a.id, "knowledge", [_doc("k1", "旧正文", user_a.id)])
    lifecycle = CythonRagLifecycle()
    await lifecycle.load_index_from_snapshot_or_database(db, user_a.id, tmp_path)

    await replace_source_documents(db, user_a.id, "knowledge", [_doc("k1", "最新正文", user_a.id)])
    latest = await load_rag_index_snapshot(db, user_a.id)
    await lifecycle._mutation_lock.acquire()
    try:
        lifecycle.engine.replace(latest.documents, latest.revision or "")
        lifecycle.watermark = latest.watermark
        lifecycle._schedule_snapshot_persist(tmp_path, user_a.id)
        await asyncio.sleep(0.03)  # 让 debounce 到期，后台任务进入 mutation lock 等待。
        # 模拟锁竞争期间新完成的增量；旧 generation 不应使这份最新快照被丢弃。
        lifecycle._schedule_snapshot_persist(tmp_path, user_a.id)
    finally:
        lifecycle._mutation_lock.release()

    await lifecycle.flush_snapshot_persistence()
    persisted = json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    assert persisted["revision"] == latest.revision
    assert persisted["documents"][0]["content"] == "最新正文"


@pytest.mark.asyncio
async def test_cython_lifecycle_expired_watermark_falls_back_to_full_snapshot(db, user_a, monkeypatch):
    """超过 TS 31 天墓碑视界的游标必须全量恢复，不能漏掉删除。"""
    monkeypatch.setattr(
        CythonRagLifecycle, "_read_vectors", staticmethod(_empty_vectors),
    )
    await replace_source_documents(db, user_a.id, "knowledge", [_doc("k1", "当前正文", user_a.id)])
    lifecycle = CythonRagLifecycle()
    lifecycle.watermark = RagIndexCursor(
        datetime.now(timezone.utc) - timedelta(days=32), 0,
    )
    snapshot = await load_rag_index_snapshot(db, user_a.id)
    result = await lifecycle.sync_index_from_database(db, user_a.id, snapshot.revision or "")
    assert result["fallback_full"] == 1
    assert [doc.source_id for doc in lifecycle.engine._persistent.documents] == ["k1"]


@pytest.mark.asyncio
async def test_cython_snapshot_cold_path_uses_revision_match_without_full_document_read(
    db, user_a, tmp_path, monkeypatch,
):
    """revision 未变时从 owner 快照恢复，避免重复扫描并分词全部文档。"""
    import agent.rag.cython_lifecycle as lifecycle_module

    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(_empty_vectors))
    await replace_source_documents(db, user_a.id, "knowledge", [_doc("k1", "快照命中", user_a.id)])
    initial = CythonRagLifecycle()
    await initial.load_index_from_database(db, user_a.id)
    initial.persist_snapshot(tmp_path, user_a.id)
    import agent.rag.cython_backend as cython_backend
    query_terms = cython_backend.tokenize_raw("快照 命中")
    expected, _ = initial.engine._persistent.search_terms(query_terms, limit=5)

    def tokenizer_must_not_run(_text):
        raise AssertionError("valid snapshot restore should reuse canonical tokens")

    monkeypatch.setattr(cython_backend, "tokenize_raw", tokenizer_must_not_run)

    async def unexpected_full_read(_db, _owner):
        raise AssertionError("same revision should restore the snapshot without loading all documents")

    monkeypatch.setattr(lifecycle_module, "load_rag_index_snapshot", unexpected_full_read)
    recovered = CythonRagLifecycle()
    result = await recovered.load_index_from_snapshot_or_database(db, user_a.id, tmp_path)

    assert result["snapshot_hit"] is True
    assert result["snapshot_status"] == "restored"
    assert recovered.engine.revision == initial.engine.revision
    assert recovered.engine._persistent.documents == initial.engine._persistent.documents
    actual, _ = recovered.engine._persistent.search_terms(query_terms, limit=5)
    assert [(row.document.chunk_id, row.score) for row in actual] == [
        (row.document.chunk_id, row.score) for row in expected
    ]


@pytest.mark.asyncio
async def test_cython_snapshot_revision_mismatch_applies_delta_without_full_scan(
    db, user_a, tmp_path, monkeypatch,
):
    """水位仍有效且 tokenizer/projection 未变时，快照失配应只追平增量。"""
    import agent.rag.cython_lifecycle as lifecycle_module

    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(_empty_vectors))
    await replace_source_documents(db, user_a.id, "knowledge", [_doc("k1", "旧版本", user_a.id)])
    stale = CythonRagLifecycle()
    await stale.load_index_from_database(db, user_a.id)
    stale.persist_snapshot(tmp_path, user_a.id)

    await replace_source_documents(db, user_a.id, "knowledge", [_doc("k1", "新版本", user_a.id)])

    async def unexpected_full_read(_db, _owner):
        raise AssertionError("fresh snapshot watermark should be advanced from deltas")

    monkeypatch.setattr(lifecycle_module, "load_rag_index_snapshot", unexpected_full_read)
    current = CythonRagLifecycle()
    result = await current.load_index_from_snapshot_or_database(db, user_a.id, tmp_path)

    assert result["snapshot_hit"] is True
    assert result["snapshot_status"] == "incremental_refresh"
    assert result["snapshot_save_scheduled"] is True
    await current.flush_snapshot_persistence()
    assert [document.content for document in current.engine._persistent.documents] == ["新版本"]


@pytest.mark.asyncio
async def test_snapshot_model_change_never_keeps_stale_vectors_when_refresh_fails(
    db, user_a, tmp_path, monkeypatch,
):
    """快照模型版本变化且缓存读取失败时，旧向量必须先被清空以安全降级。"""
    from agent.rag.delta import chunk_slot_key

    document = _doc("k1", "模型版本变化", user_a.id)
    await replace_source_documents(db, user_a.id, "knowledge", [document])

    async def old_vectors(_owner, documents, _version):
        return {documents[0].chunk_id: [1.0, 0.0]}

    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(old_vectors))
    source = CythonRagLifecycle()
    await source.load_index_from_database(db, user_a.id, vector_version="old-model")
    source.persist_snapshot(tmp_path, user_a.id)

    async def failed_refresh(_owner, _documents, _version):
        raise OSError("synthetic storage read failure")

    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(failed_refresh))
    restored = CythonRagLifecycle()
    with pytest.raises(OSError, match="synthetic storage read failure"):
        await restored.load_index_from_snapshot_or_database(
            db, user_a.id, tmp_path, vector_version="new-model",
        )

    assert restored.engine.vector_version == "new-model"
    assert restored.engine._vectors == {}
    assert chunk_slot_key(document) in source.engine._vectors


@pytest.mark.asyncio
async def test_concurrent_snapshot_loads_install_in_request_order(monkeypatch):
    """慢的旧快照不得在较新的并发加载完成后覆盖 engine revision。"""
    import agent.rag.cython_lifecycle as lifecycle_module

    owner = "synthetic-owner"
    documents = [_doc("k1", "snapshot", owner)]
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    calls = 0

    async def snapshot(_db, _owner, **_kwargs):
        nonlocal calls
        calls += 1
        call = calls
        if call == 1:
            first_started.set()
            await release_first.wait()
        return SimpleNamespace(
            documents=documents,
            revision=f"revision-{call}",
            watermark=RagIndexCursor(datetime.now(timezone.utc), call),
        )

    async def vectors(_owner, _documents, _version):
        return {}

    monkeypatch.setattr(lifecycle_module, "load_rag_index_snapshot", snapshot)
    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(vectors))
    lifecycle = CythonRagLifecycle()
    older = asyncio.create_task(lifecycle.load_index_from_database(None, owner))
    await first_started.wait()
    newer = asyncio.create_task(lifecycle.load_index_from_database(None, owner))
    await asyncio.sleep(0)
    assert calls == 1
    release_first.set()

    await asyncio.gather(older, newer)
    assert calls == 2
    assert lifecycle.engine.revision == "revision-2"
    assert lifecycle.watermark.row_id == 2


@pytest.mark.asyncio
async def test_cython_lifecycle_converts_cached_vector_keys_to_worker_chunk_slots(db, user_a, monkeypatch):
    """持久向量缓存 chunk_id 必须转换为索引 worker 使用的稳定 slot key。"""
    from agent.rag.delta import chunk_slot_key

    document = _doc("k1", "可检索正文", user_a.id)
    await replace_source_documents(db, user_a.id, "knowledge", [document])

    async def vectors(_owner_user_id, documents, _vector_version):
        return {documents[0].chunk_id: [0.6, 0.8]}

    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(vectors))
    lifecycle = CythonRagLifecycle()
    await lifecycle.load_index_from_database(db, user_a.id, vector_version="model:v1")

    expected_key = chunk_slot_key(document)
    assert lifecycle.engine._vectors == {expected_key: [0.6, 0.8]}
    fused, diagnostics = lifecycle.engine.fuse_group(
        [{"chunk_id": expected_key, "score": 0.7}], [0.6, 0.8],
        corpus="persistent", expected_vector_version="model:v1",
    )
    assert diagnostics["fusion"] == "hybrid-rrf"
    assert diagnostics["vector_doc_count"] == 1
    assert fused[0]["chunk_id"] == expected_key


@pytest.mark.asyncio
async def test_cython_lifecycle_refreshes_vectors_after_document_delta(db, user_a, monkeypatch):
    """内容版本变化或删除后不得复用旧 chunk-slot 向量。"""
    from agent.rag.delta import chunk_slot_key

    async def vectors(_owner_user_id, documents, _vector_version):
        return {
            document.chunk_id: [1.0, 0.0] if document.version == "v1" else [0.0, 1.0]
            for document in documents
        }

    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(vectors))
    lifecycle = CythonRagLifecycle()
    await replace_source_documents(db, user_a.id, "knowledge", [_doc("k1", "第一版", user_a.id)])
    initial = await load_rag_index_snapshot(db, user_a.id)
    await lifecycle.load_index_from_database(db, user_a.id, revision=initial.revision or "", vector_version="model:v1")
    old_key = chunk_slot_key(lifecycle.engine._persistent.documents[0])
    assert lifecycle.engine._vectors[old_key] == [1.0, 0.0]

    updated = IndexDocument(
        "knowledge:k1:v2:0", "knowledge", "k1",
        Scope(owner_user_id=str(user_a.id), scope_type="owner"),
        "合成标题", "", "第二版", "v2", parent_document_id="k1",
    )
    await replace_source_documents(db, user_a.id, "knowledge", [updated])
    current = await load_rag_index_snapshot(db, user_a.id)
    await lifecycle.sync_index_from_database(db, user_a.id, current.revision or "", vector_version="model:v1")
    new_key = chunk_slot_key(lifecycle.engine._persistent.documents[0])
    assert new_key == old_key
    assert lifecycle.engine._vectors == {new_key: [0.0, 1.0]}

    await replace_source_documents(db, user_a.id, "knowledge", [])
    deleted = await load_rag_index_snapshot(db, user_a.id)
    await lifecycle.sync_index_from_database(db, user_a.id, deleted.revision or "", vector_version="model:v1")
    assert lifecycle.engine._vectors == {}


@pytest.mark.asyncio
async def test_cython_prepare_memory_filters_sources_scopes_snapshot_and_vectors(monkeypatch):
    """Memory 准备按来源/scope/snapshot 收口，并只安装已有 owner 缓存向量。"""
    from agent.rag.adapters.memory import MemoryAdapter

    owner = "synthetic-owner"
    scope = Scope(owner_user_id=owner, scope_type="owner")
    covered_text = "覆盖内容" * 30
    docs = [
        IndexDocument("m:covered", "memory", "daily", scope, "日记", "", covered_text,
                      "v1", parent_document_id="m:covered"),
        IndexDocument("m:uncovered", "memory", "daily", scope, "日记", "", "未覆盖内容",
                      "v1", parent_document_id="m:uncovered"),
        IndexDocument("m:pattern", "memory", "pattern", scope, "模式", "", "模式内容",
                      "v1", parent_document_id="m:pattern"),
    ]

    async def owner_documents(_self, *, scope):
        return docs, "synthetic-owner-cache"

    vectors = {document.chunk_id: [0.25, 0.75] for document in docs}
    async def read_vectors(_owner, _documents, _version):
        return vectors

    monkeypatch.setattr(MemoryAdapter, "build_cached_owner_documents", owner_documents)
    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(read_vectors))
    lifecycle = CythonRagLifecycle()
    prepared = await lifecycle.prepare_memory(
        owner, [scope], source_filter="daily", snapshot_revision="snap-1",
        snapshot_text=covered_text[:100], vector_version="synthetic:v1",
    )

    assert prepared["document_count"] == 1
    assert prepared["vector_count"] == 1
    assert prepared["probe"]["counts"]["snapshot_excluded_documents"] == 1
    assert [document.source_id for document in lifecycle.engine._transient.documents] == ["daily"]
    assert lifecycle.engine._transient.documents[0].scope.scope_id == ""
    assert lifecycle.engine.transient_vector_count == 1
    from agent.rag.delta import chunk_slot_key
    assert set(lifecycle.engine._transient_vectors) == {chunk_slot_key(docs[1])}


@pytest.mark.asyncio
async def test_cython_prepare_memory_loads_independent_scopes_concurrently(monkeypatch):
    """owner 与群 Memory 的独立读取并发等待，且结果保持授权 scope 顺序。"""
    from agent.rag.adapters.memory import MemoryAdapter

    owner = "synthetic-owner"
    owner_scope = Scope(owner_user_id=owner, scope_type="owner")
    group_scope = Scope(
        owner_user_id=owner, scope_type="group", scope_id="group-a",
        group_id="group-a", platform="qq", bot_id="bot-a",
    )
    owner_document = IndexDocument(
        "memory:owner:1", "memory", "profile", owner_scope,
        "owner", "", "owner memory", "v1", parent_document_id="memory:owner",
    )
    group_document = IndexDocument(
        "memory:group:1", "memory", "profile", group_scope,
        "group", "", "group memory", "v1", parent_document_id="memory:group",
    )
    both_started = asyncio.Event()
    active = 0

    async def wait_for_peer(document):
        nonlocal active
        active += 1
        if active == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), timeout=5)
        return [document], "cached"

    async def owner_documents(_self, *, scope):
        return await wait_for_peer(owner_document)

    async def scope_documents(_self, *, scope):
        return await wait_for_peer(group_document)

    async def no_vectors(_owner, _documents, _version):
        return {}

    monkeypatch.setattr(MemoryAdapter, "build_cached_owner_documents", owner_documents)
    monkeypatch.setattr(MemoryAdapter, "build_cached_documents", scope_documents)
    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(no_vectors))

    lifecycle = CythonRagLifecycle()
    result = await lifecycle.prepare_memory(owner, [owner_scope, group_scope])

    assert result["document_count"] == 2
    assert [document.content for document in lifecycle.engine._transient.documents] == [
        "owner memory", "group memory",
    ]


@pytest.mark.asyncio
async def test_cython_memory_adapter_projects_without_ts_worker(monkeypatch):
    """Cython Memory 投影不启动 TS，仍保留分块、来源和 owner 授权。"""
    from agent.rag.adapters.memory import MemoryAdapter
    from agent.rag.cython_lifecycle import _CythonMemoryAdapter
    from agent.rag import ts_sidecar

    scope = Scope(owner_user_id="owner-a", scope_type="owner")
    adapter = _CythonMemoryAdapter("owner-a")
    record = adapter._make_source_record(scope, "daily", "长期记忆内容" * 300, "近期记忆", 0)
    assert record is not None

    async def records(_self, *, scope):
        return [record]

    async def forbidden(*args, **kwargs):
        raise AssertionError("Cython Memory 投影不应启动 TS worker")

    monkeypatch.setattr(MemoryAdapter, "build_source_records", records)
    monkeypatch.setattr(MemoryAdapter, "_build_daily_source_records", records)
    monkeypatch.setattr(ts_sidecar, "get_lexical_client", forbidden)
    documents = await adapter.build_documents(scope=scope)
    daily = await adapter.build_daily_documents(scope=scope)
    assert len(documents) > 1
    assert documents == daily
    assert all(document.scope.owner_user_id == "owner-a" and document.source_id == "daily" for document in daily)


@pytest.mark.asyncio
async def test_cython_prepare_memory_vectors_use_worker_document_ids(monkeypatch):
    """Memory transient 向量以 parent:version:chunk 索引，保证 Hybrid 可命中。"""
    from agent.rag.adapters.memory import MemoryAdapter

    owner = "synthetic-owner"
    scope = Scope(owner_user_id=owner, scope_type="owner")
    document = IndexDocument(
        "memory:daily:entry:0", "memory", "daily", scope,
        "日记", "", "今天完成了迁移", "v3", parent_document_id="memory:daily:entry",
    )

    async def owner_documents(_self, *, scope):
        return [document], "synthetic-owner-cache"

    async def read_vectors(_owner, _documents, _version):
        return {document.chunk_id: [1.0, 0.0]}

    monkeypatch.setattr(MemoryAdapter, "build_cached_owner_documents", owner_documents)
    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(read_vectors))
    lifecycle = CythonRagLifecycle()
    await lifecycle.prepare_memory(owner, [scope], vector_version="synthetic:v1")

    from agent.rag.delta import chunk_slot_key
    slot_key = chunk_slot_key(document)
    assert lifecycle.engine._transient_vectors == {slot_key: [1.0, 0.0]}
    fused, diagnostics = lifecycle.engine.fuse_group(
        [{"chunk_id": slot_key, "score": 0.5}], [1.0, 0.0],
        corpus="transient",
    )
    assert diagnostics["fusion"] == "hybrid-rrf"
    assert diagnostics["vector_doc_count"] == 1
    assert fused[0]["chunk_id"] == slot_key


@pytest.mark.asyncio
async def test_memory_revision_tracks_all_visible_document_state_without_ts_wire(monkeypatch):
    """瞬态 revision 覆盖文档/权限/元数据/向量版本，且不依赖 TS wire 投影。"""
    from agent.rag.adapters.memory import MemoryAdapter
    from agent.rag.cython_lifecycle import _CythonMemoryAdapter
    from agent.rag import cython_native, ts_sidecar

    scope = Scope("owner-a", scope_type="owner")
    document = IndexDocument(
        "memory:profile:1", "memory", "profile", scope, "标题", "摘要", "正文", "v1",
        metadata={"labels": ["a", "b"]},
    )
    adapter = _CythonMemoryAdapter("owner-a")

    async def owner_documents(_self, *, scope):
        return [document], "synthetic-owner-cache"

    async def read_vectors(_owner, _documents, _version):
        return {}

    async def forbidden(*args, **kwargs):
        raise AssertionError("本地 transient revision 不应构造 TS wire")

    monkeypatch.setattr(MemoryAdapter, "build_cached_owner_documents", owner_documents)
    monkeypatch.setattr(CythonRagLifecycle, "_read_vectors", staticmethod(read_vectors))
    monkeypatch.setattr(ts_sidecar, "_wire_document", forbidden)

    lifecycle = CythonRagLifecycle()
    first = await lifecycle.prepare_memory("owner-a", [scope], vector_version="model:v1")
    assert first["transient_revision"] == cython_native.memory_revision([document], "model:v1")
    document.metadata["labels"].append("c")
    second = await lifecycle.prepare_memory("owner-a", [scope], vector_version="model:v1")
    third = await lifecycle.prepare_memory("owner-a", [scope], vector_version="model:v2")
    assert second["transient_revision"] != first["transient_revision"]
    assert third["transient_revision"] != second["transient_revision"]


@pytest.mark.asyncio
async def test_cython_prepare_memory_rejects_cross_owner_and_duplicate_scopes():
    lifecycle = CythonRagLifecycle()
    with pytest.raises(ValueError, match="owner"):
        await lifecycle.prepare_memory(
            "owner-a", [Scope(owner_user_id="owner-b")],
        )
    owner_scope = Scope(owner_user_id="owner-a")
    with pytest.raises(ValueError, match="重复"):
        await lifecycle.prepare_memory("owner-a", [owner_scope, owner_scope])


@pytest.mark.parametrize("scope, message", [
    (Scope("owner-a", scope_type="group", scope_id="group-a", group_id="other",
           platform="qq", bot_id="bot"), "group scope"),
    (Scope("owner-a", scope_type="member", scope_id="other:member", group_id="group-a",
           platform="qq", bot_id="bot"), "member scope"),
    (Scope("owner-a", scope_type="group", scope_id="../escape", group_id="../escape",
           platform="qq", bot_id="bot"), "scopeId"),
])
def test_cython_memory_scope_validation_matches_worker_rejection_boundaries(scope, message):
    """非法群/成员身份与路径分隔符必须在 Cython facade 边界拒绝。"""
    from agent.rag.cython_lifecycle import _validate_memory_scopes

    with pytest.raises(ValueError, match=message):
        _validate_memory_scopes("owner-a", [scope])


def test_cython_vector_cache_projection_rejects_non_numeric_and_non_finite_values():
    """向量缓存映射必须遵守 TS StorageReader 的有限数字验证契约。"""
    from agent.rag.cython_lifecycle import _worker_vector_map
    from agent.rag.delta import chunk_slot_key

    owner = "synthetic-owner"
    documents = [
        _doc("valid", "合法", owner),
        _doc("nan", "非有限", owner),
        _doc("boolean", "布尔值", owner),
        _doc("text", "字符串", owner),
    ]
    valid_vector = [0.1, 0.2]
    vectors = {
        documents[0].chunk_id: valid_vector,
        documents[1].chunk_id: [float("nan")],
        documents[2].chunk_id: [True],
        documents[3].chunk_id: ["0.3"],
    }

    result = _worker_vector_map(documents, vectors)
    assert result == {chunk_slot_key(documents[0]): [0.1, 0.2]}
    assert result[chunk_slot_key(documents[0])] is valid_vector


def test_validated_memory_vectors_skip_rechecking_each_dimension(monkeypatch):
    """Memory 文件已由 Cython validator 校验后，chunk 映射不再重复扫描向量维度。"""
    from agent.rag.cython_lifecycle import _worker_vector_map
    from agent.rag.delta import chunk_slot_key

    document = _doc("validated", "已验证向量", "synthetic-owner")
    vector = [0.25, -0.5]

    def unexpected_validation(*args, **kwargs):
        raise AssertionError("已验证向量不应在映射阶段再次校验")

    monkeypatch.setattr("agent.rag.cython_lifecycle.math.isfinite", unexpected_validation)
    result = _worker_vector_map(
        [document], {document.chunk_id: vector}, values_validated=True,
    )
    assert result == {chunk_slot_key(document): vector}
    assert result[chunk_slot_key(document)] is vector


def test_cython_lifecycle_snapshot_round_trip_and_rejects_stale_revision(tmp_path):
    """冷恢复仅安装 owner/version/revision 匹配的完整索引快照。"""
    from agent.rag.delta import chunk_slot_key

    owner = "synthetic-owner"
    document = _doc("k1", "快照正文", owner)
    source = CythonRagLifecycle()
    source.engine.replace(
        [document], "revision-v1",
        vectors={chunk_slot_key(document): [0.6, 0.8]}, vector_version="model:v1",
    )
    source.watermark = RagIndexCursor(datetime(2026, 10, 30, tzinfo=timezone.utc), 42)
    saved = source.persist_snapshot(tmp_path, owner)
    assert saved["status"] == "saved"

    restored = CythonRagLifecycle()
    result = restored.restore_snapshot(tmp_path, owner, expected_revision="revision-v1")
    assert result["status"] == "restored"
    assert restored.engine.revision == "revision-v1"
    assert restored.engine._persistent.documents == (document,)
    assert restored.engine._vectors == {chunk_slot_key(document): [0.6, 0.8]}
    assert restored.watermark == source.watermark

    result = restored.restore_snapshot(tmp_path, owner, expected_revision="newer-revision")
    assert result["status"] == "revision_mismatch"
    assert restored.engine.revision == "revision-v1"


def test_snapshot_persistence_reuses_index_terms_without_tokenizing_again(
    tmp_path, monkeypatch,
):
    """快照写入应从内存 CSR 复用 BM25 词频，避免重跑全量 tokenizer。"""
    import agent.rag.cython_backend as cython_backend

    owner = "synthetic-owner"
    document = _doc("k1", "快照词频 快照词频 可复用", owner)
    lifecycle = CythonRagLifecycle()
    lifecycle.engine.replace([document], "revision-v1")
    expected_terms = Counter(lifecycle.engine._persistent.tokens_by_document()[0])

    def unexpected_tokenize(_text):
        raise AssertionError("snapshot persistence must reuse the built CSR postings")

    monkeypatch.setattr(cython_backend, "tokenize_raw", unexpected_tokenize)
    result = lifecycle.persist_snapshot(tmp_path, owner)
    payload = json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))

    assert result["status"] == "saved"
    assert Counter(payload["tokens"][0]) == expected_terms


def test_cython_lifecycle_snapshot_owner_or_corrupt_file_does_not_mutate_engine(tmp_path):
    """跨 owner 快照与损坏 JSON 必须拒绝，不能污染当前索引状态。"""
    target = tmp_path / "index.json"
    from agent.rag.cython_lifecycle import CYTHON_SNAPSHOT_VERSION
    target.write_text(json.dumps({"version": CYTHON_SNAPSHOT_VERSION, "owner_id": "other"}), encoding="utf-8")
    lifecycle = CythonRagLifecycle()
    lifecycle.engine.replace([], "baseline")
    assert lifecycle.restore_snapshot(tmp_path, "synthetic-owner")["status"] == "owner_mismatch"
    assert lifecycle.engine.revision == "baseline"

    target.write_text("{broken", encoding="utf-8")
    assert lifecycle.restore_snapshot(tmp_path, "synthetic-owner")["status"] == "corrupt"
    assert lifecycle.engine.revision == "baseline"


@pytest.mark.asyncio
async def test_cython_vector_storage_reader_matches_worker_file_and_key_contract(monkeypatch):
    """三类向量文件按 TS StorageReader 的 owner/key/tag 规则解析并映射 chunk id。"""
    from app.services import storage as storage_module
    from agent.memory import embedding
    from agent.rag.vector_cache import cache_key

    owner = "synthetic-owner"
    scope = Scope(owner_user_id=owner)
    memory_doc = IndexDocument("m1", "memory", "daily", scope, "日记", "", "正文", "v1", parent_document_id="m1")
    knowledge_doc = IndexDocument("k1", "knowledge", "k1", scope, "知识", "", "资料", "v2", parent_document_id="k1")
    pattern_doc = IndexDocument(
        "p1", "memory", "pattern", scope, "模式", "", "偏好", "v3",
        parent_document_id="p1", metadata={"vector_key": "pattern-key"},
    )
    version = "model:v1"
    content = {
        f"{owner}/.agent/memory_vec.json": {cache_key(memory_doc): {"v": [0.1, 0.2], "t": version}},
        f"{owner}/.agent/knowledge/vectors.json": {cache_key(knowledge_doc): {"v": [0.3], "t": version}},
        f"{owner}/.agent/pattern_vec.json": {"pattern-key": {"v": [0.4, 0.5], "t": version}},
    }

    class FakeStorage:
        async def get(self, key):
            if key not in content:
                raise FileNotFoundError(key)
            return json.dumps(content[key], separators=(",", ":")).encode()

    monkeypatch.setattr(storage_module, "get_storage", lambda: FakeStorage())
    monkeypatch.setattr(embedding, "model_tag", lambda: version)
    vectors = await CythonRagLifecycle._read_vectors(
        owner, [memory_doc, knowledge_doc, pattern_doc], version,
    )

    assert vectors == {
        memory_doc.chunk_id: (0.1, 0.2),
        knowledge_doc.chunk_id: (0.3,),
        pattern_doc.chunk_id: (0.4, 0.5),
    }


@pytest.mark.asyncio
async def test_load_vectors_from_storage_replaces_stale_model_vectors(monkeypatch):
    """模型版本刷新只安装当前文档的新缓存，未命中的旧模型向量必须清除。"""
    from agent.rag.delta import chunk_slot_key

    owner = "synthetic-owner"
    documents = [_doc("k1", "新向量可用", owner), _doc("k2", "新向量缺失", owner)]
    lifecycle = CythonRagLifecycle()
    old_vectors = {
        chunk_slot_key(document): [1.0, 0.0] for document in documents
    }
    lifecycle.engine.replace(
        documents, "revision-v1", vectors=old_vectors, vector_version="model:old",
    )
    observed = {}

    async def read_current_vectors(actual_owner, current_documents, version):
        observed.update(
            owner=actual_owner,
            documents=tuple(current_documents),
            version=version,
        )
        return {documents[0].chunk_id: [0.0, 1.0]}

    monkeypatch.setattr(
        CythonRagLifecycle, "_read_vectors", staticmethod(read_current_vectors),
    )

    result = await lifecycle.load_vectors_from_storage(owner, "model:new")

    assert observed == {"owner": owner, "documents": tuple(documents), "version": "model:new"}
    assert result == {
        "status": "ok", "vector_count": 1, "vector_version": "model:new",
    }
    assert lifecycle.engine.vector_version == "model:new"
    assert lifecycle.engine._vectors == {
        chunk_slot_key(documents[0]): [0.0, 1.0],
    }


@pytest.mark.asyncio
async def test_cython_vector_storage_rejects_nan_and_oversized_files(monkeypatch):
    """向量 JSON 使用严格 JSON 数字，并在读入超限对象前拒绝。"""
    from app.services import storage as storage_module
    from agent.memory import embedding

    owner = "synthetic-owner"
    scope = Scope(owner_user_id=owner)
    document = IndexDocument("m1", "memory", "daily", scope, "日记", "", "正文", "v1", parent_document_id="m1")
    version = "model:v1"
    oversized_key = f"{owner}/.agent/knowledge/vectors.json"
    payloads = {
        f"{owner}/.agent/memory_vec.json": b'{"rag:m1:v1:0":{"v":[NaN],"t":"model:v1"}}',
        oversized_key: b"0123456789",
    }

    class FakeStorage:
        async def get(self, key):
            if key not in payloads:
                raise FileNotFoundError(key)
            return payloads[key]

    monkeypatch.setattr(storage_module, "get_storage", lambda: FakeStorage())
    monkeypatch.setattr(embedding, "model_tag", lambda: version)
    monkeypatch.setattr("agent.rag.cython_lifecycle.VECTOR_FILE_MAX_CHARS", 2)
    assert await CythonRagLifecycle._read_vectors(owner, [document], version) == {}
    from agent.rag.cython_lifecycle import _parse_vector_file
    assert _parse_vector_file(
        '{"valid":{"v":[1],"t":"model:v1"},"bad":{"v":[NaN],"t":"model:v1"}}',
        "synthetic:strict-json", version,
    ) == {}


async def _empty_vectors(_owner_user_id, _documents, _vector_version):
    return {}


def test_vector_cache_invalidates_and_isolates_mutable_results(monkeypatch):
    """内容、模型版本与淘汰变化不能复用旧向量，调用方修改不能污染缓存。"""
    from agent.rag import cython_lifecycle as lifecycle

    monkeypatch.setattr(lifecycle, "_vector_file_cache", OrderedDict())
    monkeypatch.setattr(lifecycle, "VECTOR_FILE_CACHE_SIZE", 2)
    first = '{"a":{"t":"v1","v":[1,2]},"b":{"t":"v2","v":[3]}}'
    changed = '{"a":{"t":"v1","v":[4]}}'
    result = lifecycle._parse_vector_file(first, "file", "v1")
    assert result == {"a": (1.0, 2.0)}
    with pytest.raises(AttributeError):
        result["a"].append(9)
    result["injected"] = [0]
    assert lifecycle._parse_vector_file(first, "file", "v1") == {"a": (1.0, 2.0)}
    assert lifecycle._parse_vector_file(first, "file", "v2") == {"b": (3.0,)}
    assert lifecycle._parse_vector_file(changed, "file", "v1") == {"a": (4.0,)}
    assert lifecycle._parse_vector_file('{"a":{"v":[NaN],"t":"v1"}}', "file", "v1") == {}
    lifecycle._parse_vector_file(first, "other", "v1")
    assert len(lifecycle._vector_file_cache) == 2
    assert ("file", "v2") not in lifecycle._vector_file_cache
    assert lifecycle._parse_vector_file(first, "file", "v2") == {"b": (3.0,)}
