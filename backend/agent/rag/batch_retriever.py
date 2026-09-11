"""Phase 5 统一查询主链：一次索引准备 + 一次 ``unified_query`` IPC。

旧的 batch/unified_shadow 影子模式与 legacy 交付链已删除（2026-09-09 清理，
见 devlog）；本模块只保留 TS worker 统一查询的 Python 侧编排。
"""
import asyncio
import time
from dataclasses import dataclass

from agent.rag.adapters.indexed_sources import IndexedSourceRetriever
from agent.rag.context import get_conversation_before_message_id, get_snapshot_revision
from agent.rag.index_cache import _documents_fingerprint, get_index_cache
from agent.rag.models import Scope
from agent.rag.observation import progress
from agent.rag.retriever import RetrievalBatch, UnifiedRetriever
from agent.rag.ts_sidecar import TsSidecarUnavailable, _worker_document_key


@dataclass(frozen=True)
class _TransientCorpus:
    """Memory 快照语料与它的上传参数，重试时按同一指纹强制重传。"""

    documents: list
    revision: str
    vectors: dict[str, list[float]] | None
    vector_version: str


class UnifiedQueryRetriever(UnifiedRetriever):
    """Phase 5 统一查询主链：一次索引准备 + 一次 ``unified_query`` IPC。

    召回、来源聚合、conversation 水位、Memory 融合与 confidence 排序全部在
    TS worker 内完成；Python 保留业务数据装载、权限事实、向量生成和注入组装。
    向量随瞬态语料驻留 worker（指纹耦合 embedding 模型版本戳），不随查询重复传输。
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
        memory_documents: list | None = None
        memory_index_source = ""
        memory_meta: dict = {}
        if memory is not None:
            progress("memory", "index_prepare")
            memory_documents, memory_index_source, memory_meta = await self._load_memory(memory, scope)
        scopes = list(scope) if isinstance(scope, (list, tuple)) else [scope]
        specs, _allowed = self._persistent_specs(persistent, scopes, limit=candidate_limit)
        if memory_documents is not None:
            specs.append({"source_types": {"memory"}, "scope": None,
                          "limit": candidate_limit, "corpus": "transient"})
        if not specs:
            for item in selected:
                progress(item.source_type, "completed", reason="scope_rejected")
            return [RetrievalBatch(item.source_type, fallback_reason="scope_rejected") for item in selected]

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
                index = await get_index_cache().get(
                    db, owner, "all", scope, diagnostics=metadata,
                    baseline_revision=get_snapshot_revision() or None,
                )
                prepare_ms = int((time.monotonic() - started) * 1000)
                for item in persistent:
                    progress(item.source_type, "sidecar_search", index_prepare_ms=prepare_ms)
                # 指纹耦合 embedding 模型版本戳：换模型必然重传语料与向量。参数留到
                # 重试时复用，revision 不一致重试要按同一指纹强制重传。
                transient: _TransientCorpus | None = None
                if memory_documents is not None:
                    vectors: dict[str, list[float]] | None = None
                    vector_version = ""
                    if embedding_enabled and memory_documents:
                        vectors = await self._memory_vectors(owner, memory_documents)
                        vector_version = embedding.model_tag()
                    transient = _TransientCorpus(
                        documents=memory_documents,
                        revision=f"{_documents_fingerprint(memory_documents)}:{vector_version}",
                        vectors=vectors, vector_version=vector_version,
                    )
                    await index.client.replace_transient(
                        transient.documents, transient.revision,
                        vectors=transient.vectors, vector_version=transient.vector_version)
                ts_index = index
                query_vector = list(await embedding.embed(query) or []) if embedding_enabled else []
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
                    response = await index.unified_query(query, **query_kwargs)
                except TsSidecarUnavailable as exc:
                    index, response = await self._resync_and_retry(
                        exc, query=query, query_kwargs=query_kwargs, db=db, owner=owner,
                        scope=scope, transient=transient, metadata=metadata,
                    )
                    ts_index = index
        except BaseException as exc:
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
        return [RetrievalBatch(
            source_type="unified", results=(), index_source=memory_index_source or "persistent-ts",
            fallback_reason=fallback,
            candidate_count=sum(int(group.get("hit_count") or 0)
                                for group in (response.get("source_groups") or {}).values()),
            metadata={key: str(value) for key, value in details.items()},
            rank_rows=self._resolve_rank_rows(ts_index, response, memory_documents),
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
        if getattr(exc, "code", None) != "revision_mismatch":
            raise exc
        metadata["revision_resync"] = "True"
        index = await get_index_cache().resync(
            db, owner, "all", scope, diagnostics=metadata,
            baseline_revision=get_snapshot_revision() or None,
        )
        if transient is not None:
            # 强制重传：瞬时槽的短路判断依据的是进程内状态，此刻不能信。
            await index.client.replace_transient(
                transient.documents, transient.revision,
                vectors=transient.vectors, vector_version=transient.vector_version, force=True,
            )
        return index, await index.unified_query(query, **query_kwargs)

    def _memory_session_owner(self, memory):
        """Memory-only 查询的 IPC 宿主：只借用会话与索引缓存，不注册持久化来源。"""
        return IndexedSourceRetriever(memory.user_id, db=self._session,
                                      db_factory=self._session_factory,
                                      source_type="knowledge")

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

    def _resolve_rank_rows(self, ts_index, response, memory_documents):
        """把 worker 选中行回连 Python 文档，输出 (candidate, text, row) 三元组。"""
        from agent.rag.index_cache import _worker_document_key
        from agent.rag.models import IndexDocument, RecallCandidate, RecallResult, Scope

        documents_by_key = dict(ts_index.documents_by_id)
        for document in memory_documents or ():
            documents_by_key[_worker_document_key(document)] = document
        triples = []
        for row in response.get("selected") or []:
            document = documents_by_key.get(str(row.get("document_key") or ""))
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
                        scope=Scope(owner_user_id=str(ts_index.client.owner_user_id)),
                        title=str(citation.get("title") or ""),
                        summary="",
                        content=text,
                        version=str(citation.get("version") or "restored"),
                        parent_document_id=source_id or None,
                        updated_at=str(citation.get("updated_at") or "") or None,
                    )
            if document is None:
                continue
            candidate = RecallCandidate.from_result(
                RecallResult(document, float(row.get("raw_score") or 0.0)),
                rank=len(triples) + 1,
            )
            triples.append((candidate, str(row.get("text") or ""), row))
        return tuple(triples)

    async def _memory_vectors(self, owner, memory_documents) -> dict[str, list[float]]:
        """从 Python 向量缓存读取 Memory 语料向量，按 worker 文档键交付。"""
        from agent.rag.index_cache import _worker_document_key
        from agent.rag.service import _load_cached_vectors

        vector_map = await _load_cached_vectors(owner, memory_documents)
        by_key = {_worker_document_key(document): document for document in memory_documents}
        return {
            key: vector_map[document.chunk_id]
            for key, document in by_key.items()
            if document.chunk_id in vector_map
        }
