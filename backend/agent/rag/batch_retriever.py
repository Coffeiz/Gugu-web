"""Phase 5 统一查询主链：一次索引准备 + 一次 ``unified_query`` IPC。

旧的 batch/unified_shadow 影子模式与 legacy 交付链已删除（2026-09-09 清理，
见 devlog）；本模块只保留 TS worker 统一查询的 Python 侧编排。
"""
import asyncio
import time
from dataclasses import dataclass

from agent.rag.adapters.indexed_sources import IndexedSourceRetriever
from agent.rag.context import get_conversation_before_message_id, get_snapshot_context, get_snapshot_revision
from agent.rag.index_cache import get_index_cache
from agent.rag.models import Scope
from agent.rag.observation import await_probe, probe_complete, probe_finish, probe_update, progress
from agent.rag.retriever import RetrievalBatch, UnifiedRetriever
from agent.rag.scope import normalize_memory_scopes
from agent.rag.ts_sidecar import TsSidecarUnavailable


@dataclass(frozen=True)
class _TransientCorpus:
    """worker 内 Memory 装载参数；不把语料正文或向量搬回 Python。"""

    owner: str
    scopes: list[Scope]
    source_filter: str
    snapshot_revision: str
    snapshot_text: str
    revision: str
    vector_version: str


class UnifiedQueryRetriever(UnifiedRetriever):
    """Phase 5 统一查询主链：一次索引准备 + 一次 ``unified_query`` IPC。

    召回、来源聚合、conversation 水位、Memory 融合与 confidence 排序全部在
    TS worker 内完成；Python 只保留 scope 授权、查询 embedding provider 调用、命中
    权限复核和最终注入组装。Memory 正文与缓存向量在 worker 内读取和驻留。
    """

    SOURCE_ORDER = (
        "memory", "knowledge", "project", "file", "canvas", "note",
        "calendar", "scheduled_task", "conversation",
    )

    def __init__(self, retrievers=None, *, session_factory=None, session=None):
        super().__init__(retrievers)
        # Memory-only 查询没有持久化来源可借用会话；此时用显式 db 或该工厂
        # 开 IPC 宿主会话（与来源检索共享同一个连接事实源）。
        self._session_factory = session_factory
        self._session = session

    async def retrieve(self, query, *, source="all", scope="auto", strategy="auto", candidate_limit=20,
                       rank_options: dict | None = None):
        from agent.memory import embedding

        rank_options = rank_options or {}
        embedding_enabled = embedding.is_enabled() and strategy in {"auto", "embedding"}
        if strategy not in {"auto", "bm25", "embedding"}:
            raise ValueError("策略只能是 auto、bm25 或 embedding")
        selected = [item for item in self._retrievers.values()
                    if source == "all" or item.source_type == source]
        if not selected:
            # 未知 source 值与旧交付路径同口径：返回空结果，不报错。
            return []
        memory = next((item for item in selected if item.source_type == "memory"), None)
        persistent = [item for item in selected if item.source_type != "memory"]
        started = time.monotonic()
        memory_scopes: list[Scope] | None = None
        memory_index_source = ""
        if memory is not None:
            progress("memory", "index_prepare")
            memory_scopes = normalize_memory_scopes(memory.user_id, scope)
        scopes = memory_scopes or (list(scope) if isinstance(scope, (list, tuple)) else [scope])
        specs, _allowed = self._persistent_specs(persistent, scopes, limit=candidate_limit)
        if memory is not None:
            specs.append({"source_types": {"memory"}, "scope": None,
                          "limit": candidate_limit, "corpus": "transient"})
        if not specs:
            for item in selected:
                progress(item.source_type, "completed", reason="scope_rejected")
            probe_update(search={"spec_count": 0, "selected_source_count": len(selected)})
            probe_complete("completed", reason="scope_rejected")
            return [RetrievalBatch(item.source_type, fallback_reason="scope_rejected") for item in selected]
        probe_update(search={"spec_count": len(specs), "selected_source_count": len(selected)})

        if persistent:
            session_owner, owner = self._session_owner(persistent)
        else:
            # Memory-only 显式查询：持久化索引仅作为 worker 会话宿主与跨查询缓存，
            # 不产生任何持久化检索 spec。
            session_owner = self._memory_session_owner(memory)
            owner = memory.user_id
        metadata: dict = {}
        ts_index = None
        try:
            async with session_owner.session_scope() as db:
                index = await await_probe(
                    "index_cache_get",
                    get_index_cache().get(
                        db, owner, "all", scope, diagnostics=metadata,
                        baseline_revision=get_snapshot_revision() or None,
                    ),
                )
                probe_update(index_cache={
                    key: metadata[key]
                    for key in (
                        "cache_hit", "cache_hit_layer", "snapshot_reused", "cache_miss_reason",
                        "index_sync", "index_build_ms", "document_count", "sidecar_reused",
                        "disk_index_reused", "index_restore_error", "upsert_count", "delete_count",
                    )
                    if key in metadata
                })
                prepare_ms = int((time.monotonic() - started) * 1000)
                for item in persistent:
                    progress(item.source_type, "sidecar_search", index_prepare_ms=prepare_ms)
                # 指纹耦合 embedding 模型版本戳：换模型必然重传语料与向量。参数留到
                # 重试时复用；语料和向量只在 worker 内读取与驻留。
                transient: _TransientCorpus | None = None
                if memory is not None and memory_scopes is not None:
                    vector_version = embedding.model_tag() if embedding_enabled else ""
                    transient = _TransientCorpus(
                        owner=str(owner), scopes=memory_scopes,
                        source_filter=str(memory.source_filter or "all"),
                        snapshot_revision=get_snapshot_revision(),
                        snapshot_text=get_snapshot_context(),
                        revision="", vector_version=vector_version,
                    )
                    prepared = await await_probe(
                        "memory_load",
                        index.client.prepare_memory(
                            transient.owner, transient.scopes,
                            source_filter=transient.source_filter,
                            snapshot_revision=transient.snapshot_revision,
                            snapshot_text=transient.snapshot_text,
                            vector_version=transient.vector_version,
                        ),
                        terminal_on_error=True,
                    )
                    transient = _TransientCorpus(
                        **{**transient.__dict__, "revision": str(prepared.get("transient_revision") or "")},
                    )
                    memory_index_source = str(prepared.get("memory_source") or "")
                    memory_probe = prepared.get("probe")
                    probe_update(memory={
                        "document_count": int(prepared.get("document_count") or 0),
                        "vector_count": int(prepared.get("vector_count") or 0),
                        "vector_version_present": bool(transient.vector_version),
                        "index_source": memory_index_source,
                        "prepare": memory_probe if isinstance(memory_probe, dict) else {},
                    })
                ts_index = index
                query_vector = list(await await_probe(
                    "query_embedding", embedding.embed(query),
                ) or []) if embedding_enabled else []
                probe_update(search={"query_vector_dimensions": len(query_vector)})
                query_kwargs = {
                    "searches": specs,
                    "query_vector": query_vector,
                    "source_order": [name for name in self.SOURCE_ORDER
                                     if name in {item.source_type for item in selected}],
                    "candidate_limit": candidate_limit,
                    "rank_options": {
                        "limit": int(rank_options.get("limit") or 5),
                        "max_chars": int(rank_options.get("max_chars") or 3000),
                        "max_per_source": int(rank_options.get("max_per_source") or 3),
                        "max_per_parent": int(rank_options.get("max_per_parent") or 3),
                        "selection_mode": rank_options.get("selection_mode") or "confidence",
                        "exclude_content_hashes": rank_options.get("exclude_content_hashes") or (),
                    },
                    "before_message_id": get_conversation_before_message_id(),
                    # 持久向量表（knowledge 等）按此版本戳校验：worker 驻留表不同版
                    # （换模型窗口）时非 memory 组自动降级纯词法。
                    "vector_version": embedding.model_tag() if embedding_enabled else None,
                }
                try:
                    response = await await_probe(
                        "sidecar_unified_query", index.unified_query(query, **query_kwargs),
                    )
                except TsSidecarUnavailable as exc:
                    index, response = await await_probe(
                        "revision_resync_retry",
                        self._resync_and_retry(
                            exc, query=query, query_kwargs=query_kwargs, db=db, owner=owner,
                            scope=scope, transient=transient, metadata=metadata,
                        ),
                    )
                ts_index = index
                sidecar_timing = response.pop("_sidecar_timing", {})
                worker_probe = response.pop("probe", None)
                if not isinstance(worker_probe, dict):
                    worker_probe = response.pop("_probe", {})
                else:
                    response.pop("_probe", None)
                probe_update(sidecar=sidecar_timing, worker=worker_probe)
        except BaseException as exc:
            probe_complete(
                "cancelled" if isinstance(exc, asyncio.CancelledError) else "error",
                error_type=type(exc).__name__,
            )
            for item in selected:
                progress(item.source_type, "cancelled" if isinstance(exc, asyncio.CancelledError) else "error",
                         error_type=type(exc).__name__)
            raise
        elapsed_ms = int((time.monotonic() - started) * 1000)
        fusion = response.get("fusion") or {}
        # fallback 标签按 Python 侧事实判定：embedding 关闭/未配置 → embedding_disabled；
        # 开启但无可用向量 → worker 回报 embedding_cache_unavailable；融合成功 → None。
        fallback = None if embedding_enabled else "embedding_disabled"
        if embedding_enabled:
            fallback = fusion.get("fallback")
        details = {
            **metadata,
            "document_count": sum((response.get("document_counts") or {}).values()),
            "retrieve_ms": elapsed_ms,
            "engine": "typescript", "cache_hit": "True",
            "batch_search": "True", "unified_query": "True",
            "fusion": str(fusion.get("fusion") or "bm25"),
        }
        progress("unified", "completed", **details)
        stats = dict(response.get("stats") or {})
        rank_resolution_started = time.monotonic()
        rank_rows = self._resolve_rank_rows(
            ts_index, response, memory_scopes or [], owner_user_id=str(owner),
        )
        probe_finish("rank_row_resolution", rank_resolution_started)
        probe_complete("completed", candidate_count=sum(
            int(group.get("hit_count") or 0)
            for group in (response.get("source_groups") or {}).values()
        ), selected_count=len(rank_rows))
        return [RetrievalBatch(
            source_type="unified", results=(), index_source=memory_index_source or "persistent-ts",
            fallback_reason=fallback,
            candidate_count=sum(int(group.get("hit_count") or 0)
                                for group in (response.get("source_groups") or {}).values()),
            metadata={key: str(value) for key, value in details.items()},
            rank_rows=rank_rows,
            rank_stats=stats,
        )]

    async def _resync_and_retry(
        self, exc: TsSidecarUnavailable, *, query: str, query_kwargs: dict, db,
        owner, scope, transient: "_TransientCorpus | None", metadata: dict,
    ):
        """revision 不一致时作废缓存、全量重同步并按同参数重试一次。

        worker 的 ``state.revision`` 是 per-owner 单槽，被另一个 revision 命名空间
        （会话快照版 / DB 投影版）推着走过之后，缓存里冻结了旧 revision 的索引对象会
        被 worker 拒绝（``revision_mismatch``）。重同步能把 worker 拉回本轮 revision，
        这属于可自愈的缓存一致性问题，不该变成模型与用户看到的故障。

        只重试一次：第二次仍失败按原错误抛出，不把真实故障吞成重试风暴。
        """
        trigger_code = "revision_mismatch" if exc.code == "revision_mismatch" else (
            "other" if exc.code else "missing"
        )
        probe_update(revision_resync={"trigger_error_code": trigger_code})
        if getattr(exc, "code", None) != "revision_mismatch":
            probe_update(revision_resync={"outcome": "skipped_non_revision_error"})
            raise exc
        metadata["revision_resync"] = "True"
        index = await await_probe(
            "revision_resync_index_get",
            get_index_cache().resync(
                db, owner, "all", scope, diagnostics=metadata,
                baseline_revision=get_snapshot_revision() or None,
            ),
        )
        if transient is not None:
            prepared = await await_probe(
                "revision_resync_memory_prepare",
                index.client.prepare_memory(
                    transient.owner, transient.scopes,
                    source_filter=transient.source_filter,
                    snapshot_revision=transient.snapshot_revision,
                    snapshot_text=transient.snapshot_text,
                    vector_version=transient.vector_version,
                ),
            )
            transient = _TransientCorpus(
                **{**transient.__dict__, "revision": str(prepared.get("transient_revision") or "")},
            )
        try:
            response = await await_probe(
                "revision_resync_query", index.unified_query(query, **query_kwargs),
            )
        except TsSidecarUnavailable as retry_error:
            probe_update(revision_resync={
                "outcome": "retry_error",
                "retry_error_code": (
                    "revision_mismatch" if retry_error.code == "revision_mismatch"
                    else "other" if retry_error.code else "missing"
                ),
            })
            raise
        probe_update(revision_resync={"outcome": "completed"})
        return index, response

    def _memory_session_owner(self, memory):
        """Memory-only 查询的 IPC 宿主：只借用会话与索引缓存，不注册持久化来源。"""
        return IndexedSourceRetriever(memory.user_id, db=self._session,
                                      db_factory=self._session_factory,
                                      source_type="knowledge")

    def _persistent_specs(self, persistent, scopes, *, limit):
        """构造逐来源逐 scope 的批量查询规格，返回 (specs, allowed_by_source)。"""
        from agent.rag.scope import normalize_memory_scopes

        specs: list[dict] = []
        allowed: dict[str, list] = {}
        if not persistent:
            return specs, allowed
        first = persistent[0]
        owner = first.adapter.user_id if first.source_type == "project" else first.user_id
        for item in persistent:
            name = item.source_type
            valid = [value for value in scopes if isinstance(value, Scope)]
            if name == "project":
                valid = [value for value in normalize_memory_scopes(owner, scopes) if value.scope_type == "owner"][:1]
            elif name in {"file", "canvas", "note"}:
                types = {"file": {"owner", "project", "folder"}, "canvas": {"owner", "project"}, "note": {"owner"}}[name]
                valid = [value for value in valid if value.scope_type in types]
            elif name in {"calendar", "scheduled_task"}:
                valid = [value for value in valid if value.scope_type == "owner"]
            allowed[name] = valid
            progress(name, "index_prepare")
            specs.extend({"source_types": {name}, "scope": value, "limit": limit} for value in valid)
        return specs, allowed

    def _session_owner(self, persistent):
        """返回持有 DB 会话的来源与 owner；project 来源用 adapter 的会话工厂。"""
        first = persistent[0]
        owner = first.adapter.user_id if first.source_type == "project" else first.user_id
        if first.source_type == "project":
            adapter = first.adapter
            return IndexedSourceRetriever(owner, db=adapter._db,
                                          db_factory=adapter._db_factory, source_type="file"), owner
        return first, owner

    def _resolve_rank_rows(self, ts_index, response, memory_scopes, *, owner_user_id: str | None = None):
        """把 worker 选中行回连 Python 文档，输出 (candidate, text, row) 三元组。"""
        from agent.rag.models import IndexDocument, RecallCandidate, RecallResult, Scope
        from agent.rag.scope import matches_scope

        owner = str(owner_user_id or getattr(ts_index.client, "owner_user_id", ""))
        if not owner:
            raise ValueError("RAG 查询缺少已校验的 owner 身份")
        documents_by_key = dict(ts_index.documents_by_id)
        triples = []
        for row in response.get("selected") or []:
            document = documents_by_key.get(str(row.get("document_key") or ""))
            if document is None and isinstance(row.get("document"), dict):
                from agent.rag.ts_sidecar import _from_wire_document

                document = _from_wire_document(
                    row["document"], owner,
                )
            if document is None:
                # 冷恢复时 Python 侧可能没有持久化文档副本，但 TS 仍会返回
                # citation/text。不要因此静默丢掉 knowledge/file/project 等结果。
                citation = row.get("citation") if isinstance(row.get("citation"), dict) else {}
                source_type = str(citation.get("source_type") or row.get("source_type") or "")
                source_id = str(citation.get("source_id") or "")
                chunk_id = str(citation.get("chunk_id") or row.get("document_key") or "")
                text = str(row.get("text") or "").strip()
                if source_type and (source_id or chunk_id) and text:
                    document = IndexDocument(
                        document_id=chunk_id or source_id,
                        source_type=source_type,
                        source_id=source_id or chunk_id,
                        scope=Scope(owner_user_id=owner),
                        title=str(citation.get("title") or ""),
                        summary="",
                        content=text,
                        version=str(citation.get("version") or "restored"),
                        parent_document_id=source_id or None,
                        updated_at=str(citation.get("updated_at") or "") or None,
                    )
            if document is None:
                continue
            if str(document.scope.owner_user_id) != owner:
                continue
            if document.source_type == "memory" and not any(
                matches_scope(document, scope) for scope in memory_scopes
            ):
                continue
            candidate = RecallCandidate.from_result(
                RecallResult(document, float(row.get("raw_score") or 0.0)),
                rank=len(triples) + 1,
            )
            triples.append((candidate, str(row.get("text") or ""), row))
        return tuple(triples)
