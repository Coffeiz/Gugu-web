"""持久化来源与 Memory 快照语料共享一次词法查询；权限与水位语义保持 Python 收口。"""
import asyncio
import time

from agent.rag.adapters.indexed_sources import _conversation_document_visible
from agent.rag.context import get_conversation_before_message_id, get_snapshot_revision
from agent.rag.index_cache import _documents_fingerprint, get_index_cache
from agent.rag.models import Scope
from agent.rag.observation import progress
from agent.rag.retriever import RetrievalBatch, UnifiedRetriever
from agent.rag.ts_sidecar import _worker_document_key


class BatchUnifiedRetriever(UnifiedRetriever):
    """批量化共享同一持久化索引的来源，保持来源顺序和候选额度。

    Memory 装入 worker 的瞬态语料槽（独立 BM25 统计边界），与持久化来源在同一次
    ``batch_search`` IPC 中返回；瞬态语料按快照指纹驻留，指纹未变时零额外 IPC。
    """

    async def retrieve(self, query, *, source="all", scope="auto", strategy="auto", candidate_limit=20):
        if strategy not in {"auto", "bm25", "embedding"}:
            raise ValueError("策略只能是 auto、bm25 或 embedding")
        selected = [item for item in self._retrievers.values()
                    if source == "all" or item.source_type == source]
        memory = next((item for item in selected if item.source_type == "memory"), None)
        persistent = [item for item in selected if item.source_type != "memory"]
        if memory is not None and not persistent:
            # 只有 Memory 的显式查询退回 legacy 瞬态索引路径；自动召回始终包含持久化来源。
            return list(await UnifiedRetriever([memory]).retrieve(
                query, source="all", scope=scope, strategy=strategy,
                candidate_limit=candidate_limit,
            ))
        started = time.monotonic()

        # ── 1) Memory 候选语料装载（加载、来源/scope 过滤、snapshot 去重）──
        memory_documents: list | None = None
        memory_index_source = ""
        memory_meta: dict = {}
        if memory is not None:
            progress("memory", "index_prepare")
            memory_documents, memory_index_source, memory_meta = await self._load_memory(memory, scope)

        # ── 2) 持久化来源逐 scope 查询规格 ──
        scopes = list(scope) if isinstance(scope, (list, tuple)) else [scope]
        specs, allowed = self._persistent_specs(persistent, scopes, limit=candidate_limit)
        if memory_documents is not None:
            specs.append({"source_types": {"memory"}, "scope": None,
                          "limit": candidate_limit, "corpus": "transient"})
        if not specs:
            for item in selected:
                progress(item.source_type, "completed", reason="scope_rejected")
            return [RetrievalBatch(item.source_type, fallback_reason="scope_rejected") for item in selected]

        # ── 3) 一次索引准备 + 一次批量词法查询 ──
        session_owner, owner = self._session_owner(persistent)
        metadata: dict = {}
        ts_client = None
        try:
            async with session_owner.session_scope() as db:
                index = await get_index_cache().get(
                    db, owner, "all", scope, diagnostics=metadata,
                    baseline_revision=get_snapshot_revision() or None,
                )
                ts_client = index.client
                prepare_ms = int((time.monotonic() - started) * 1000)
                for item in persistent:
                    progress(item.source_type, "sidecar_search", index_prepare_ms=prepare_ms)
                if memory_documents is not None:
                    # 瞬态槽按快照指纹驻留同一 worker；指纹未变时这条 IPC 为零。
                    await index.client.replace_transient(
                        memory_documents, _documents_fingerprint(memory_documents))
                batches, counts, timing = await index.batch_search(
                    query, specs,
                    extra_documents={
                        _worker_document_key(document): document
                        for document in (memory_documents or ())
                    },
                )
        except BaseException as exc:
            for item in selected:
                progress(item.source_type, "cancelled" if isinstance(exc, asyncio.CancelledError) else "error",
                         error_type=type(exc).__name__)
            raise
        hits_by_source: dict[str, list] = {}
        for spec, (hits, _diag) in zip(specs, batches):
            existing = hits_by_source.setdefault(next(iter(spec["source_types"])), [])
            existing.extend(hits)
        for name, hits in hits_by_source.items():
            # 同一来源跨多个 scope 命中时去重，并保持与旧路径一致的排序截断。
            dedup: dict = {}
            for hit in hits:
                dedup.setdefault(hit.document.chunk_id, hit)
            hits_by_source[name] = sorted(
                dedup.values(), key=lambda hit: (-hit.score, hit.document.chunk_id))[:candidate_limit]
        elapsed_ms = int((time.monotonic() - started) * 1000)

        # ── 4) 逐来源收尾：conversation 水位、Memory hybrid、诊断 ──
        output = []
        for item in selected:
            name = item.source_type
            if name == "memory":
                output.append(await self._memory_batch(
                    memory, memory_documents or [], memory_index_source, memory_meta,
                    hits_by_source.get("memory", []), counts, timing, elapsed_ms,
                    query=query, candidate_limit=candidate_limit, strategy=strategy,
                    ts_client=ts_client,
                ))
                continue
            hits = hits_by_source.get(name, [])
            if name == "conversation":
                hits = [hit for hit in hits if _conversation_document_visible(hit.document, get_conversation_before_message_id())]
            details = {**metadata, "document_count": counts.get(name, 0),
                       "index_prepare_ms": prepare_ms, "sidecar_queue_wait_ms": timing.queue_wait_ms,
                       "sidecar_query_ms": timing.query_ms,
                       "sidecar_search_ms": timing.queue_wait_ms + timing.query_ms,
                       "retrieve_ms": elapsed_ms, "batch_search": True}
            progress(name, "completed", **details)
            output.append(RetrievalBatch(
                source_type=name, results=tuple(hits), index_source=f"{name}-db",
                candidate_count=counts.get(name, 0) if allowed[name] else 0,
                fallback_reason=("scope_rejected" if not allowed[name] else
                                 "embedding_disabled" if name == "project" else "embedding_not_indexed"),
                metadata={key: str(value) for key, value in details.items()},
            ))
        return output

    async def _load_memory(self, memory, scope):
        """装载 Memory 候选语料，返回 (documents, index_source, metadata)。"""
        from agent.rag.service import _memory_recall_documents

        documents, index_source, document_load_ms = await _memory_recall_documents(
            memory.user_id, scope, memory.source_filter,
        )
        return documents, index_source, {"document_load_ms": document_load_ms}

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
            allowed[name] = valid
            progress(name, "index_prepare")
            specs.extend({"source_types": {name}, "scope": value, "limit": limit} for value in valid)
        return specs, allowed

    def _session_owner(self, persistent):
        """返回持有 DB 会话的来源与 owner；project 来源用 adapter 的会话工厂。"""
        from agent.rag.adapters.indexed_sources import IndexedSourceRetriever

        first = persistent[0]
        owner = first.adapter.user_id if first.source_type == "project" else first.user_id
        if first.source_type == "project":
            adapter = first.adapter
            return IndexedSourceRetriever(owner, db=adapter._db,
                                          db_factory=adapter._db_factory, source_type="file"), owner
        return first, owner

    def _ts_fuse(self, client, documents, candidate_limit, search_metadata):
        """Phase 3：batch 主链的 hybrid 融合交给 TS worker 执行。

        worker 在 batch_search 之后不可用属真实异常，回滚到 Python
        ``hybrid_results`` 保交付，但错误类别显式记入诊断，不做静默兜底。
        """
        from agent.rag.fusion import BM25_WEIGHT, RRF_K, VECTOR_WEIGHT
        from agent.rag.hybrid import hybrid_results

        async def fuse(lexical, query_vector, vector_map):
            from agent.memory import embedding
            from agent.rag.ts_sidecar import TsSidecarUnavailable

            try:
                final, fallback, diag = await client.hybrid_fuse(
                    lexical, query_vector=query_vector, vector_map=vector_map,
                    limit=candidate_limit,
                    lexical_weight=BM25_WEIGHT, vector_weight=VECTOR_WEIGHT,
                    rrf_k=RRF_K, vector_version=embedding.model_tag(),
                )
            except TsSidecarUnavailable as exc:
                search_metadata["ts_hybrid_error"] = type(exc).__name__
                return hybrid_results(
                    lexical, documents, query_vector, vector_map, limit=candidate_limit,
                )
            search_metadata.update({f"ts_fusion_{key}": value for key, value in diag.items()})
            return final, fallback

        return fuse

    async def _memory_batch(self, memory, documents, index_source, memory_meta, hits,
                            counts, timing, prepare_elapsed_ms, *, query, candidate_limit,
                            strategy="auto", ts_client=None):
        """把批量词法命中走完 Memory 的 embedding/hybrid 收尾并包装为来源批次。"""
        from agent.rag.service import _memory_finalize

        finalize_started = time.monotonic()
        search_metadata: dict = dict(memory_meta)
        final, fusion, fallback_reason = await _memory_finalize(
            memory.user_id, documents, hits, query,
            strategy=strategy, candidate_limit=candidate_limit,
            search_metadata=search_metadata,
            fuse=(self._ts_fuse(ts_client, documents, candidate_limit, search_metadata)
                  if ts_client is not None else None),
        )
        details = {**search_metadata,
                   "document_count": counts.get("memory", len(documents)),
                   "sidecar_queue_wait_ms": timing.queue_wait_ms,
                   "sidecar_query_ms": timing.query_ms,
                   "sidecar_search_ms": timing.queue_wait_ms + timing.query_ms,
                   "retrieve_ms": prepare_elapsed_ms + int((time.monotonic() - finalize_started) * 1000),
                   "engine": "typescript", "cache_hit": True,
                   "batch_search": True, "corpus": "transient", "fusion": fusion}
        progress("memory", "completed", **details)
        return RetrievalBatch(
            source_type="memory", results=tuple(final), index_source=index_source,
            fallback_reason=fallback_reason,
            candidate_count=counts.get("memory", len(documents)),
            metadata={key: str(value) for key, value in details.items()},
        )


class ShadowUnifiedRetriever(UnifiedRetriever):
    """``batch_shadow`` 灰度模式：交付 legacy 结果，额外运行 batch 并记录候选差异。

    影子结果永不交付给用户；对比统计只进诊断（batch.metadata → source_diagnostics），
    额外耗时单独记录 shadow_total_ms，不计入 legacy 的 retrieve_ms。
    """

    def __init__(self, retrievers):
        super().__init__(retrievers)
        self._batch = BatchUnifiedRetriever(retrievers)

    async def retrieve(self, query, *, source="all", scope="auto", strategy="auto", candidate_limit=20):
        batches = await UnifiedRetriever.retrieve(
            self, query, source=source, scope=scope, strategy=strategy,
            candidate_limit=candidate_limit,
        )
        started = time.monotonic()
        try:
            shadow = await self._batch.retrieve(
                query, source=source, scope=scope, strategy=strategy,
                candidate_limit=candidate_limit,
            )
        except Exception as exc:
            # 影子路径失败不能影响交付，只记录错误类别；原始异常走受限诊断出口。
            from app.core.redaction import diag_log

            diag_log("agent.rag.shadow_recall", exc)
            for batch in batches:
                batch.metadata.setdefault("shadow_error", type(exc).__name__)
            return batches
        shadow_ms = int((time.monotonic() - started) * 1000)
        by_source = {batch.source_type: batch for batch in shadow}
        rank_meta = await self._rank_shadow(query, batches, shadow, candidate_limit)
        for batch in batches:
            legacy_signature = self._signature(batch.results)
            shadow_results = by_source.get(batch.source_type)
            shadow_signature = self._signature(shadow_results.results) if shadow_results else []
            diff = next(
                (index for index, (left, right) in enumerate(zip(legacy_signature, shadow_signature))
                 if left != right),
                None,
            )
            if diff is None and len(legacy_signature) != len(shadow_signature):
                diff = min(len(legacy_signature), len(shadow_signature))
            equal = shadow_signature == legacy_signature
            batch.metadata.update({
                "shadow_mode": "batch",
                "shadow_total_ms": str(shadow_ms),
                "shadow_equal": str(equal),
                "shadow_batch_count": str(len(shadow_signature)),
                "shadow_first_diff_index": "" if diff is None else str(diff),
                **rank_meta,
            })
            progress(batch.source_type, "shadow_diff", equal=equal, first_diff=diff,
                     shadow_ms=shadow_ms, **rank_meta)
        return batches

    async def _rank_shadow(self, query, batches, shadow, candidate_limit) -> dict:
        """Phase 2 排序影子：对 legacy 与批量候选各跑一次 TS 排序并对比最终输出。

        两侧使用同一套冻结参数（confidence 模式、无注入排除集），与正式交付的
        排序请求分别计数；差异只进诊断。任一侧排序失败不影响交付。
        """
        from agent.rag.ts_sidecar import RANK_SCORING_VERSION, rank_candidates_with_cache

        def _candidates(batch_list):
            values = []
            for batch in batch_list:
                values.extend(batch.candidates())
            return values

        def _signature(selected) -> list:
            return [
                (candidate.document.chunk_id, round(float(item.get("confidence") or 0), 6))
                for candidate, _text, item in selected
            ]

        try:
            left_selection, _left_stats = await rank_candidates_with_cache(
                "", query, _candidates(batches),
                limit=candidate_limit, max_chars=3000, max_per_source=3, max_per_parent=3,
                selection_mode="confidence",
            )
            right_selection, _right_stats = await rank_candidates_with_cache(
                "", query, _candidates(shadow),
                limit=candidate_limit, max_chars=3000, max_per_source=3, max_per_parent=3,
                selection_mode="confidence",
            )
        except Exception as exc:
            from app.core.redaction import diag_log

            diag_log("agent.rag.shadow_rank", exc)
            return {"rank_shadow_error": type(exc).__name__}
        left_signature = _signature(left_selection)
        right_signature = _signature(right_selection)
        diff = next(
            (index for index, (one, two) in enumerate(zip(left_signature, right_signature)) if one != two),
            None,
        )
        if diff is None and len(left_signature) != len(right_signature):
            diff = min(len(left_signature), len(right_signature))
        return {
            "rank_scoring_version": RANK_SCORING_VERSION,
            "rank_equal": str(left_signature == right_signature),
            "rank_count": str(len(left_signature)),
            "rank_shadow_count": str(len(right_signature)),
            "rank_first_diff_index": "" if diff is None else str(diff),
        }

    @staticmethod
    def _signature(results) -> list[tuple[str, float]]:
        return [(item.document.chunk_id, round(item.score, 6)) for item in results]
