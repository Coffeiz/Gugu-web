"""Cython RAG 查询引擎的 Python 输入适配层。"""
from __future__ import annotations

import hashlib
import asyncio
import json
import math
import time
from array import array
from bisect import bisect_left
from collections import Counter
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

from agent.rag.cython_collation import locale_sort_key
from agent.rag.cython_tokenizer import tokenize_raw
from agent.rag.models import IndexDocument, RecallResult, Scope


class CythonKernelUnavailable(RuntimeError):
    """Cython 扩展尚未构建或不可导入。"""


@dataclass(frozen=True, slots=True)
class CythonBM25Index:
    """用紧凑 CSR 倒排布局保存 BM25 所需的不可变索引视图。"""

    document_lengths: array
    term_offsets: array
    posting_document_ids: array
    posting_frequencies: array
    document_frequencies: array
    document_tie_ranks: array
    document_keys: tuple[str, ...]
    term_ids: dict[str, int]
    average_length: float

    @property
    def document_count(self) -> int:
        return len(self.document_lengths)


@dataclass(frozen=True, slots=True)
class CythonSearchDiagnostics:
    candidate_count: int
    eligible_count: int
    filtered_count: int
    source_filter_applied: bool
    scope_filter_applied: bool


@dataclass(frozen=True, slots=True)
class CythonLexicalIndex:
    """TS worker lexical search 的只读 Python facade。"""

    documents: tuple[IndexDocument, ...]
    document_keys: tuple[str, ...]
    bm25: CythonBM25Index
    revision: str
    _last_position_by_key: Mapping[str, int]
    _eligibility_cache: dict[tuple, tuple[tuple[int, ...], frozenset[int], array]]
    database_projection: bool = False

    @classmethod
    def build(
        cls,
        documents: Sequence[IndexDocument],
        revision: str,
        *,
        tokenized_documents: Sequence[Sequence[str]] | None = None,
        database_projection: bool = False,
    ) -> "CythonLexicalIndex":
        from agent.rag.delta import chunk_slot_key

        docs = tuple(documents)
        keys = tuple(chunk_slot_key(document) for document in docs)
        # TS replaceInMemory 保留重复 ID 的每一条 posting/df/总长度，但
        # documentsById 与 lengths Map 采用最后一条记录。用内部唯一键保存
        # 每个 posting，再把同 ID 的 BM25 文档长度投影为最后一条长度，查询时
        # 聚合分数并只返回最后一条文档，以复刻 TS 当前的可观察行为。
        occurrences: dict[str, int] = {}
        duplicate_keys = len(set(keys)) != len(keys)
        internal_keys = []
        if duplicate_keys:
            for key in keys:
                occurrences[key] = occurrences.get(key, 0) + 1
                internal_keys.append(f"{key}\x1f{occurrences[key]}")
        else:
            internal_keys = list(keys)
        last_lengths: dict[str, int] = {}

        def iter_tokenized_documents():
            if tokenized_documents is not None:
                if len(tokenized_documents) != len(docs) or any(
                    not isinstance(terms, (list, tuple))
                    or any(not isinstance(term, str) for term in terms)
                    for terms in tokenized_documents
                ):
                    raise ValueError("快照中的分词文档结构无效")
                yield from tokenized_documents
                return
            from agent.rag import cython_native

            batch_size = 128
            for start in range(0, len(docs), batch_size):
                end = min(start + batch_size, len(docs))
                texts = (cython_native.ranking_text_many(docs[start:end], True)
                         if database_projection else cython_native.ranking_text_many(docs[start:end]))
                tokenized_batch = cython_native.tokenize_many(texts)
                for offset, terms in enumerate(tokenized_batch):
                    if duplicate_keys:
                        last_lengths[keys[start + offset]] = len(terms)
                    yield terms

        bm25 = _build_index_from_token_stream(
            iter_tokenized_documents(), len(docs), internal_keys, tie_by_key=True,
        )
        if duplicate_keys:
            if tokenized_documents is None:
                for position, key in enumerate(keys):
                    bm25.document_lengths[position] = last_lengths[key]
            else:
                last_lengths = {
                    key: len(terms) for key, terms in zip(keys, tokenized_documents)
                }
                for position, key in enumerate(keys):
                    bm25.document_lengths[position] = last_lengths[key]
        return cls(
            docs, keys, bm25, str(revision or ""),
            {key: position for position, key in enumerate(keys)},
            {}, database_projection,
        )

    @classmethod
    def patch(
        cls,
        previous: "CythonLexicalIndex",
        documents: Sequence[IndexDocument],
        changed_keys: set[str],
        revision: str,
    ) -> "CythonLexicalIndex":
        """复用未变化文档的 CSR postings，只为变化文档分词并重建受影响索引。"""
        docs = tuple(documents)
        keys = tuple(previous.document_keys)
        from agent.rag.delta import chunk_slot_key

        next_keys = tuple(chunk_slot_key(document) for document in docs)
        if len(set(keys)) != len(keys) or len(set(next_keys)) != len(next_keys):
            # 重复 slot 的 full build 有专门的 TS 兼容语义；不在增量路径改写它。
            return cls.build(docs, revision, database_projection=previous.database_projection)

        next_position = {key: position for position, key in enumerate(next_keys)}
        reusable_positions = {
            old_position: next_position[key]
            for old_position, key in enumerate(keys)
            if key in next_position and key not in changed_keys
        }
        old_bm25 = previous.bm25
        from agent.rag import cython_native

        changed_entries = [
            (position, document)
            for position, (key, document) in enumerate(zip(next_keys, docs))
            if key in changed_keys
        ]
        changed_docs = [document for _, document in changed_entries]
        changed_texts = (cython_native.ranking_text_many(changed_docs, True)
                         if previous.database_projection else cython_native.ranking_text_many(changed_docs))
        changed_documents = [
            (entry[0], text) for entry, text in zip(changed_entries, changed_texts)
        ]
        (
            lengths, offsets, posting_document_ids, posting_frequencies,
            document_frequencies, tie_ranks, term_ids, average_length,
        ) = cython_native.patch_csr(
            old_bm25.document_lengths,
            old_bm25.term_offsets,
            old_bm25.posting_document_ids,
            old_bm25.posting_frequencies,
            old_bm25.term_ids,
            reusable_positions,
            next_keys,
            changed_documents,
        )
        bm25 = CythonBM25Index(
            document_lengths=lengths,
            term_offsets=offsets,
            posting_document_ids=posting_document_ids,
            posting_frequencies=posting_frequencies,
            document_frequencies=document_frequencies,
            document_tie_ranks=tie_ranks,
            document_keys=next_keys,
            term_ids=term_ids,
            average_length=average_length,
        )
        return cls(docs, next_keys, bm25, str(revision or ""), next_position, {}, previous.database_projection)

    def query_term_frequencies(self, document_key: str, query_terms: Sequence[str]) -> tuple[dict[str, int], int]:
        """从 BM25 倒排表读取 query-term TF 与文档长度，避免重排阶段重复分词。"""
        position = self._last_position_by_key.get(document_key)
        if position is None:
            return {}, 0
        frequencies: dict[str, int] = {}
        for term in set(query_terms):
            term_id = self.bm25.term_ids.get(term)
            if term_id is None:
                continue
            start = int(self.bm25.term_offsets[term_id])
            end = int(self.bm25.term_offsets[term_id + 1])
            posting = bisect_left(self.bm25.posting_document_ids, position, start, end)
            if posting < end and self.bm25.posting_document_ids[posting] == position:
                frequencies[term] = int(self.bm25.posting_frequencies[posting])
        return frequencies, int(self.bm25.document_lengths[position])

    def tokens_by_document(self) -> tuple[tuple[str, ...], ...]:
        """从已构建的倒排 CSR 还原 BM25 等价 token 多重集，供快照复用。"""
        from agent.rag import cython_native

        return cython_native.tokens_by_document(
            self.bm25.document_lengths,
            self.bm25.term_offsets,
            self.bm25.posting_document_ids,
            self.bm25.posting_frequencies,
            self.bm25.term_ids,
        )

    def search(
        self,
        query: str,
        *,
        limit: int = 10,
        source_types: Iterable[str] = (),
        scope: Scope | None = None,
    ) -> tuple[list[RecallResult], CythonSearchDiagnostics]:
        return self.search_terms(
            tokenize_raw(query), limit=limit, source_types=source_types, scope=scope,
        )

    def search_terms(
        self,
        terms: Sequence[str],
        *,
        limit: int = 10,
        source_types: Iterable[str] = (),
        scope: Scope | None = None,
        prepared_hits: Sequence[tuple[int, float]] | None = None,
    ) -> tuple[list[RecallResult], CythonSearchDiagnostics]:
        """搜索已分词 query，供 batch/unified 查询共享一次 canonical 分词。"""
        from agent.rag.delta import chunk_slot_key

        allowed_sources = frozenset(map(str, source_types))
        cache_key = (
            tuple(sorted(allowed_sources)),
            None if scope is None else (
                scope.owner_user_id, scope.platform, scope.bot_id, scope.group_id,
                scope.scope_type, scope.scope_id,
            ),
        )
        cached_eligibility = self._eligibility_cache.get(cache_key)
        if cached_eligibility is None:
            eligible_ids = tuple(
                position for position, document in enumerate(self.documents)
                if (not allowed_sources or document.source_type in allowed_sources)
                and _matches_worker_scope(document, scope)
            )
            eligible_set = frozenset(eligible_ids)
            eligible_mask = array(
                "i", (int(position in eligible_set) for position in range(len(self.documents))),
            )
            cached_eligibility = eligible_ids, eligible_set, eligible_mask
            self._eligibility_cache[cache_key] = cached_eligibility
        eligible_ids, eligible, eligible_mask = cached_eligibility
        diagnostics = CythonSearchDiagnostics(
            candidate_count=len(self.documents),
            eligible_count=len(eligible_ids),
            filtered_count=len(self.documents) - len(eligible_ids),
            source_filter_applied=bool(allowed_sources),
            scope_filter_applied=scope is not None,
        )
        if not terms or not eligible_ids:
            return [], diagnostics

        # 必须在全索引语料统计 IDF 后过滤。若仅把 eligible 文档建索引，scope
        # 查询的 BM25 分数会与 TS worker 不同；先取全部命中再应用过滤和 Top-K。
        has_duplicate_keys = len(set(self.document_keys)) != len(self.document_keys)
        if prepared_hits is not None:
            hits = prepared_hits
        elif len(eligible) == len(self.documents) and not has_duplicate_keys:
            hits = search(self.bm25, terms, max(1, min(int(limit), 50)))
        else:
            # TS 对全语料计算 IDF，但在取 Top-K 前先应用来源/scope 过滤。
            # 将 eligible ids 下推至 Cython Top-K，避免无关 scope 的高分文档占位。
            hits = search(
                self.bm25,
                terms,
                self.bm25.document_count if has_duplicate_keys else max(1, min(int(limit), 50)),
                eligible_mask=eligible_mask,
            )
        if has_duplicate_keys:
            last_position = {key: position for position, key in enumerate(self.document_keys)}
            aggregated: dict[str, float] = {}
            for document_id, score in hits:
                key = self.document_keys[document_id]
                aggregated[key] = aggregated.get(key, 0.0) + score
            results = [
                RecallResult(self.documents[position], score)
                for key, score in aggregated.items()
                if (position := last_position[key]) in eligible and score > 0
            ]
            results.sort(key=lambda item: (-item.score, locale_sort_key(chunk_slot_key(item.document))))
        else:
            results = [
                RecallResult(self.documents[document_id], score)
                for document_id, score in hits
                if document_id in eligible and score > 0
            ]
        results = results[:max(1, min(int(limit), 50))]
        return results, diagnostics


class CythonRagEngine:
    """持久索引与 transient Memory 分槽、带 revision 校验的查询 facade。

    来源投影、数据库 owner 授权、缓存 TTL 和 embedding 凭据仍由现有 Python
    adapter 管理；此对象只保存调用方已授权并投影完成的 immutable 文档快照。
    """

    def __init__(self) -> None:
        self._persistent = CythonLexicalIndex.build((), "")
        self._transient = CythonLexicalIndex.build((), "")
        self._merged_statistics_cache: dict[
            tuple[int, ...], tuple[tuple[CythonBM25Index, ...], dict[str, object]],
        ] = {}
        self._vectors: dict[str, list[float]] = {}
        self._vector_version = ""
        self._transient_vectors: dict[str, Sequence[float]] = {}
        self._transient_vector_version = ""
        self._transient_fingerprints: tuple[str, ...] = ()

    @property
    def revision(self) -> str:
        return self._persistent.revision

    @property
    def transient_revision(self) -> str:
        return self._transient.revision

    @property
    def vector_version(self) -> str:
        return self._vector_version

    @property
    def vector_count(self) -> int:
        return len(self._vectors)

    @property
    def transient_vector_version(self) -> str:
        return self._transient_vector_version

    @property
    def transient_vector_count(self) -> int:
        return len(self._transient_vectors)

    def replace(
        self,
        documents: Sequence[IndexDocument],
        revision: str,
        *,
        vectors: dict[str, list[float]] | None = None,
        vector_version: str = "",
        tokenized_documents: Sequence[Sequence[str]] | None = None,
        database_projection: bool = False,
    ) -> None:
        self._persistent = CythonLexicalIndex.build(
            documents, revision, tokenized_documents=tokenized_documents,
            database_projection=database_projection,
        )
        self._merged_statistics_cache.clear()
        if vectors is not None:
            self.set_vectors(vectors, vector_version)

    def set_vectors(self, vectors: dict[str, list[float]], vector_version: str) -> None:
        """替换持久索引的整份向量视图；仅接收已由 owner-bound adapter 授权的数据。"""
        self._vectors = {str(key): list(vector) for key, vector in vectors.items()}
        self._vector_version = str(vector_version or "")

    def patch(
        self,
        upserts: Sequence[IndexDocument],
        deletes: Iterable[str],
        *,
        revision: str,
        base_revision: str,
        vectors: dict[str, list[float]] | None = None,
        vector_version: str = "",
    ) -> None:
        if str(base_revision or "") != self.revision:
            raise CythonRevisionMismatch("持久 RAG 索引 revision 不一致")
        from agent.rag.delta import chunk_slot_key

        next_documents = {key: document for key, document in zip(
            self._persistent.document_keys, self._persistent.documents,
        )}
        removed_keys = {str(key) for key in deletes}
        changed_upserts: list[IndexDocument] = []
        changed_keys: set[str] = set()
        for document in upserts:
            key = chunk_slot_key(document)
            existing = next_documents.get(key)
            if (existing is not None and key not in removed_keys
                    and _lexical_fingerprint(existing, self._persistent.database_projection)
                    == _lexical_fingerprint(document, self._persistent.database_projection)):
                continue
            removed_keys.add(key)
            changed_keys.add(key)
            changed_upserts.append(document)
        for key in removed_keys:
            next_documents.pop(key, None)
        for document in changed_upserts:
            next_documents[chunk_slot_key(document)] = document
        self._persistent = CythonLexicalIndex.patch(
            self._persistent, list(next_documents.values()), changed_keys, revision,
        )
        self._merged_statistics_cache.clear()
        if vectors is not None:
            self.set_vectors(vectors, vector_version)

    def replace_transient(
        self,
        documents: Sequence[IndexDocument],
        revision: str,
        *,
        vectors: dict[str, list[float]] | None = None,
        vector_version: str = "",
        revision_is_content_addressed: bool = False,
    ) -> None:
        normalized_revision = str(revision or "")
        if revision_is_content_addressed:
            # prepare_memory 的 SHA revision 覆盖完整文档状态；像 TS worker 一样，
            # 它既可跳过相同 revision 的比较，也可替代逐文档词法指纹计算。
            if self._transient.revision != normalized_revision:
                snapshot = tuple(documents)
                self._transient = CythonLexicalIndex.build(snapshot, normalized_revision)
                self._transient_fingerprints = ()
                self._merged_statistics_cache.clear()
        else:
            snapshot = tuple(documents)
            fingerprints = tuple(_lexical_fingerprint(document) for document in snapshot)
            if (self._transient.revision != normalized_revision
                    or self._transient.documents != snapshot
                    or self._transient_fingerprints != fingerprints):
                self._transient = CythonLexicalIndex.build(snapshot, normalized_revision)
                self._transient_fingerprints = fingerprints
                self._merged_statistics_cache.clear()
        self._transient_vectors = {
            str(key): vector if isinstance(vector, tuple) else list(vector)
            for key, vector in (vectors or {}).items()
        }
        self._transient_vector_version = str(vector_version or "")

    def fuse_group(
        self,
        hits: Sequence[Mapping[str, object]],
        query_vector: Sequence[float],
        *,
        corpus: str = "persistent",
        expected_vector_version: str = "",
        lexical_weight: float = 0.45,
        vector_weight: float = 0.55,
        rrf_k: float = 60,
    ) -> tuple[list[dict[str, object]], dict[str, object]]:
        """按 unified_query 的来源分组契约融合；向量不可用时保留 BM25 分数。"""
        if corpus == "transient":
            vectors = self._transient_vectors
            vector_version = self._transient_vector_version
            version_matches = True
        elif corpus == "persistent":
            vectors = self._vectors
            vector_version = self._vector_version
            version_matches = bool(expected_vector_version) and vector_version == str(expected_vector_version)
        else:
            raise ValueError("RAG corpus 仅支持 persistent 或 transient")

        rows = [
            {"chunk_id": str(hit.get("chunk_id") or ""), "score": float(hit.get("score") or 0)}
            for hit in hits
        ]
        diagnostics: dict[str, object] = {
            "fusion": "bm25",
            "vector_doc_count": 0,
            "vector_version": vector_version,
            "fallback": "embedding_cache_unavailable",
        }
        if not query_vector or not vectors or not version_matches:
            return rows, diagnostics

        fused_scores, vector_count, semantic_scores = hybrid_fuse_scores(
            [str(row["chunk_id"]) for row in rows], query_vector, vectors,
            lexical_weight=lexical_weight, vector_weight=vector_weight, rrf_k=rrf_k,
        )
        if not fused_scores:
            return rows, diagnostics

        diagnostics.update(fusion="hybrid-rrf", vector_doc_count=vector_count, fallback=None)
        diagnostics["semantic_scores"] = semantic_scores
        return [
            {"chunk_id": str(row["chunk_id"]), "score": fused_scores[str(row["chunk_id"])]}
            for row in rows
        ], diagnostics

    def query(
        self,
        query: str,
        *,
        revision: str,
        transient_revision: str | None = None,
        corpus: str = "persistent",
        limit: int = 10,
        source_types: Iterable[str] = (),
        scope: Scope | None = None,
        before_message_id: int | None = None,
    ) -> tuple[list[RecallResult], CythonSearchDiagnostics]:
        if str(revision or "") != self.revision:
            raise CythonRevisionMismatch("持久 RAG 索引 revision 不一致")
        if corpus == "transient":
            if not transient_revision or str(transient_revision) != self.transient_revision:
                raise CythonRevisionMismatch("瞬态 RAG 索引 revision 不一致")
            index = self._transient
        elif corpus == "persistent":
            index = self._persistent
        else:
            raise ValueError("RAG corpus 仅支持 persistent 或 transient")
        results, diagnostics = index.search(
            query, limit=limit, source_types=source_types, scope=scope,
        )
        if before_message_id is not None:
            results = [
                result for result in results
                if not _is_after_conversation_watermark(result.document, before_message_id)
            ]
        return results, diagnostics

    def batch_search(
        self,
        query: str,
        *,
        revision: str,
        searches: Sequence[Mapping[str, object]],
        transient_revision: str | None = None,
    ) -> dict[str, object]:
        """对多组 scope/source 做一次查询快照的批量 BM25 搜索。"""
        if str(revision or "") != self.revision:
            raise CythonRevisionMismatch("持久 RAG 索引 revision 不一致")
        if any(item.get("corpus") == "transient" for item in searches) and (
            not transient_revision or str(transient_revision) != self.transient_revision
        ):
            raise CythonRevisionMismatch("瞬态 RAG 索引 revision 不一致")
        batch_ids = [str(item.get("id", position)) for position, item in enumerate(searches)]
        if len(set(batch_ids)) != len(batch_ids):
            raise ValueError("批量查询标识重复")
        query_terms = tokenize_raw(query)
        batches = []
        for position, spec in enumerate(searches):
            corpus_name = "transient" if spec.get("corpus") == "transient" else "persistent"
            index = self._transient if corpus_name == "transient" else self._persistent
            scope = spec.get("scope")
            if scope is not None and not isinstance(scope, Scope):
                raise TypeError("batch_search scope 必须是 Scope")
            keys_by_identity = {id(document): key for key, document in zip(
                index.document_keys, index.documents,
            )}
            results, diagnostics = index.search_terms(
                query_terms,
                limit=int(spec.get("limit", 10)),
                source_types=tuple(map(str, spec.get("source_types") or ())),
                scope=scope,
            )
            batches.append({
                "id": batch_ids[position],
                "results": [{
                    "id": keys_by_identity[id(row.document)],
                    "score": row.score, "source_type": row.document.source_type,
                    "document_version": row.document.version,
                    "document": _worker_document_wire(
                        row.document, keys_by_identity[id(row.document)], index.database_projection,
                    ),
                } for row in results],
                "diagnostics": {
                    "candidate_count": diagnostics.candidate_count,
                    "eligible_count": diagnostics.eligible_count,
                    "filtered_count": diagnostics.filtered_count,
                    "source_filter_applied": diagnostics.source_filter_applied,
                    "scope_filter_applied": diagnostics.scope_filter_applied,
                },
            })
        counts: Counter[str] = Counter()
        for index in (self._persistent, self._transient):
            counts.update(document.source_type for document in index.documents)
        return {"status": "ok", "revision": self.revision, "document_counts": dict(counts), "batches": batches}

    def unified_search(
        self,
        query: str,
        *,
        revision: str,
        limit: int = 5,
        max_chars: int = 3000,
        source_types: Iterable[str] = (),
        scope: Scope | None = None,
    ) -> dict[str, object]:
        """兼容 legacy unified_search 协议；主业务调用应迁移到 unified_query。"""
        if str(revision or "") != self.revision:
            raise CythonRevisionMismatch("持久 RAG 索引 revision 不一致")
        found, _diagnostics = self._persistent.search(
            query, limit=50, source_types=source_types, scope=scope,
        )
        candidates = []
        documents_by_key = {}
        keys_by_identity = {id(document): key for key, document in zip(
            self._persistent.document_keys, self._persistent.documents,
        )}
        for result in found:
            key = keys_by_identity[id(result.document)]
            document = result.document
            wire = _rank_wire_document(document, key, document.source_type, self._persistent.database_projection)
            candidates.append({
                "id": key, "source_type": document.source_type,
                "raw_score": result.score, "fusion": "bm25", "fused_score": None,
                "document": wire,
            })
            documents_by_key[key] = document
        from agent.rag.cython_rank import rank_candidates
        ranked, diagnostics = rank_candidates(
            query, candidates, limit=limit, max_chars=max_chars,
            selection_mode="top_k", corpus_statistics=self._merged_statistics([self._persistent.bm25]),
        )
        results = []
        for item in ranked:
            key = str(item["id"])
            document = _worker_document_wire(documents_by_key[key], key, self._persistent.database_projection)
            document["text"] = item["text"]
            results.append(document)
        return {
            "status": "ok", "revision": self.revision, "results": results,
            "has_more": len(candidates) > len(results), "diagnostics": diagnostics,
        }

    def unified_query(
        self,
        query: str,
        *,
        revision: str,
        searches: Sequence[Mapping[str, object]],
        source_order: Sequence[str],
        candidate_limit: int,
        rank_options: Mapping[str, object],
        transient_revision: str | None = None,
        before_message_id: int | None = None,
        query_vector: Sequence[float] = (),
        vector_version: str = "",
        lexical_weight: float = 0.45,
        vector_weight: float = 0.55,
        rrf_k: float = 60,
    ) -> dict[str, object]:
        """在 Cython facade 中执行统一 RAG 的纯内存查询编排。

        输入文档必须已由调用方完成授权和投影；该方法不访问数据库、不发起 embedding
        请求；数据库装载、恢复和后端选择由 Python 生命周期/缓存层负责。
        """
        if str(revision or "") != self.revision:
            raise CythonRevisionMismatch("持久 RAG 索引 revision 不一致")
        has_transient = any(item.get("corpus") == "transient" for item in searches)
        if has_transient and (
            not transient_revision or str(transient_revision) != self.transient_revision
        ):
            raise CythonRevisionMismatch("瞬态 RAG 索引 revision 不一致")
        candidate_limit = max(1, min(int(candidate_limit), 50))
        groups, group_order, diagnostics = _collect_unified_groups(
            self, query, tokenize_raw(query), searches, candidate_limit, before_message_id,
        )
        fusion, semantic_scores = _fuse_unified_groups(
            self, groups, query_vector, vector_version, lexical_weight, vector_weight, rrf_k,
        )
        selected, rank_stats, candidates = _rank_unified_groups(
            query, groups, group_order, source_order, semantic_scores, rank_options,
            self._merged_statistics([self._persistent.bm25, *(
                [self._transient.bm25] if has_transient else []
            )]),
        )
        # Match TS worker response assembly: state.documentsById is consulted before
        # transient.documentsById. Legacy persistent memory slots may collide with a
        # transient memory slot; keep the same persistent-first projection for parity.
        documents_by_key = {
            key: document
            for key, document in zip(
                self._persistent.document_keys, self._persistent.documents,
            )
        }
        for key, document in zip(self._transient.document_keys, self._transient.documents):
            documents_by_key.setdefault(key, document)
        for item in selected:
            key = str(item.get("document_key") or "")
            document = documents_by_key[key]
            item["document"] = _worker_document_wire(
                document, key, self._persistent.database_projection and key in self._persistent._last_position_by_key,
            )
            item["raw_score"] = _candidate_raw_score(candidates, str(item.get("id") or ""))
        return _unified_response(self, selected, rank_stats, fusion, groups, diagnostics, searches, candidates, has_transient)

    def _merged_statistics(self, indices: Sequence[CythonBM25Index]) -> dict[str, object]:
        """按不可变 BM25 索引对象复用合并语料统计，保留完整 DF/IDF 输入。"""
        snapshot = tuple(indices)
        key = tuple(id(index) for index in snapshot)
        cached = self._merged_statistics_cache.get(key)
        if cached is not None and len(cached[0]) == len(snapshot) and all(
            previous is current for previous, current in zip(cached[0], snapshot)
        ):
            return cached[1]
        statistics = _merged_statistics(snapshot)
        self._merged_statistics_cache[key] = (snapshot, statistics)
        # 只保留最近的少数索引组合，避免长期服务中索引版本变更积累缓存。
        while len(self._merged_statistics_cache) > 2:
            self._merged_statistics_cache.pop(next(iter(self._merged_statistics_cache)))
        return statistics

    async def unified_query_with_embedding(self, query: str, **options) -> dict[str, object]:
        """以 Python 凭据边界生成查询向量，再执行与 TS embedding op 同契约的查询。

        query_embedding 是本轮已校验的短生命周期配置快照；它只传给 Python embedding
        helper，不进入索引状态或响应。未提供时才读取当前有效配置。embedding 失败按 TS
        行为退化到 lexical-only，并仅回传受控 outcome/HTTP 状态诊断。
        """
        from agent.memory.embedding import embed_query

        embedding_settings = options.pop("query_embedding", None)
        revision = str(options.get("revision") or "")
        if revision != self.revision:
            raise CythonRevisionMismatch("持久 RAG 索引 revision 不一致")
        searches = options.get("searches") or ()
        if any(item.get("corpus") == "transient" for item in searches):
            transient_revision = options.get("transient_revision")
            if not transient_revision or str(transient_revision) != self.transient_revision:
                raise CythonRevisionMismatch("瞬态 RAG 索引 revision 不一致")
        embedding_started = time.monotonic()
        embedded = await embed_query(query, settings=embedding_settings)
        response = await asyncio.to_thread(
            self.unified_query, query, query_vector=embedded["vector"], **options,
        )
        probe = response.get("probe")
        if isinstance(probe, dict):
            stage_ms = probe.setdefault("stage_ms", {})
            counts = probe.setdefault("counts", {})
            stage_ms["query_embedding"] = max(
                0, round((time.monotonic() - embedding_started) * 1000),
            )
            counts["query_vector_dimensions"] = len(embedded["vector"])
            probe["embedding"] = {
                "outcome": embedded["outcome"],
                **({"http_status": embedded["http_status"]}
                   if embedded.get("http_status") is not None else {}),
            }
        return response


class CythonRevisionMismatch(RuntimeError):
    """索引与请求 revision 不一致；调用方应按现行流程重新装载快照。"""


def _collect_unified_groups(engine, query, query_terms, searches, candidate_limit, before_message_id):
    groups: dict[str, list[dict[str, object]]] = {}
    group_order: list[str] = []
    diagnostics: dict[str, dict[str, object]] = {}
    seen_by_source: dict[str, set[str]] = {}
    document_keys = {
        "persistent": {id(document): key for key, document in zip(
            engine._persistent.document_keys, engine._persistent.documents,
        )},
        "transient": {id(document): key for key, document in zip(
            engine._transient.document_keys, engine._transient.documents,
        )},
    }
    for spec in searches:
        corpus_name = "transient" if spec.get("corpus") == "transient" else "persistent"
        index = engine._transient if corpus_name == "transient" else engine._persistent
        source_types = tuple(map(str, spec.get("source_types") or ()))
        scope = spec.get("scope")
        if scope is not None and not isinstance(scope, Scope):
            raise TypeError("unified_query scope 必须是 Scope")
        found, search_diagnostics = index.search_terms(
            query_terms, limit=candidate_limit, source_types=source_types, scope=scope,
        )
        diagnostics[str(len(diagnostics))] = {
            "candidate_count": search_diagnostics.candidate_count,
            "eligible_count": search_diagnostics.eligible_count,
            "filtered_count": search_diagnostics.filtered_count,
            "source_filter_applied": search_diagnostics.source_filter_applied,
            "scope_filter_applied": search_diagnostics.scope_filter_applied,
        }
        for result in found:
            source = result.document.source_type
            key = document_keys[corpus_name][id(result.document)]
            seen = seen_by_source.setdefault(source, set())
            if key in seen:
                continue
            if source not in groups:
                groups[source] = []
                group_order.append(source)
            term_frequencies, token_length = index.query_term_frequencies(key, query_terms)
            groups[source].append({
                "key": key, "score": float(result.score), "document": result.document,
                "database_projection": index.database_projection,
                "query_term_frequencies": term_frequencies,
                "ranking_token_length": token_length,
            })
            seen.add(key)
    for source, rows in groups.items():
        rows.sort(key=lambda row: (-float(row["score"]), locale_sort_key(str(row["key"]))))
        del rows[candidate_limit:]
        if source == "conversation" and before_message_id is not None:
            groups[source] = [row for row in rows if not _is_after_conversation_watermark(
                row["document"], before_message_id,
            )]
    return groups, group_order, diagnostics


def _fuse_unified_groups(engine, groups, query_vector, vector_version, lexical_weight, vector_weight, rrf_k):
    semantic_scores: dict[str, float] = {}
    fused_sources: list[tuple[str, dict[str, object]]] = []
    for source, rows in groups.items():
        if not rows or (source != "memory" and not vector_version):
            continue
        fused_rows, info = engine.fuse_group(
            [{"chunk_id": row["key"], "score": row["score"]} for row in rows],
            query_vector,
            corpus="transient" if source == "memory" else "persistent",
            expected_vector_version=vector_version,
            lexical_weight=lexical_weight, vector_weight=vector_weight, rrf_k=rrf_k,
        )
        if info["fusion"] != "hybrid-rrf":
            continue
        scores = {str(item["chunk_id"]): float(item["score"]) for item in fused_rows}
        semantic_scores.update({str(key): float(value) for key, value in
                                dict(info.get("semantic_scores") or {}).items()})
        for row in rows:
            row["score"] = scores.get(str(row["key"]), float(row["score"]))
        fused_sources.append((source, info))
    if not fused_sources:
        return {
            "fusion": "bm25", "vector_doc_count": 0,
            "vector_version": engine._transient_vector_version,
            "fallback": "embedding_cache_unavailable",
        }, semantic_scores
    memory_fused = any(source == "memory" for source, _ in fused_sources)
    version = engine._transient_vector_version
    for source, info in fused_sources:
        if source == "memory" or not memory_fused:
            version = str(info["vector_version"])
    return {
        "fusion": "hybrid-rrf",
        "vector_doc_count": sum(int(info["vector_doc_count"]) for _, info in fused_sources),
        "vector_version": version, "fallback": None,
    }, semantic_scores


def _rank_unified_groups(query, groups, group_order, source_order, semantic_scores, rank_options, statistics):
    ordered_sources = [
        *[str(source) for source in source_order if str(source) in groups],
        *[source for source in group_order if source not in source_order],
    ]
    candidates: list[dict[str, object]] = []
    document_keys: dict[str, str] = {}
    precomputed_term_frequencies: dict[str, Mapping[str, int]] = {}
    precomputed_document_lengths: dict[str, int] = {}
    for source in ordered_sources:
        for row in groups[source]:
            document = row["document"]
            key = str(row["key"])
            candidate_id = f"{source}:{key}:{len(candidates)}"
            document_keys[candidate_id] = key
            wire = _rank_wire_document(document, key, source, bool(row["database_projection"]))
            wire["id"] = candidate_id
            candidate: dict[str, object] = {
                "id": candidate_id, "source_type": source,
                "raw_score": float(row["score"]), "fusion": "bm25",
                "fused_score": None, "document": wire,
            }
            precomputed_term_frequencies[candidate_id] = row["query_term_frequencies"]
            precomputed_document_lengths[candidate_id] = int(row["ranking_token_length"])
            if key in semantic_scores:
                candidate["semantic_score"] = semantic_scores[key]
            candidates.append(candidate)
    from agent.rag.cython_rank import rank_candidates
    selected, stats = rank_candidates(
        query, candidates,
        limit=int(rank_options.get("limit", 5)),
        max_chars=int(rank_options.get("max_chars", 3000)),
        max_per_source=int(rank_options.get("max_per_source", 3)),
        max_per_parent=int(rank_options.get("max_per_parent", 3)),
        exclude_content_hashes=rank_options.get("exclude_content_hashes") or (),
        selection_mode=str(rank_options.get("selection_mode") or "confidence"),
        scoring_version=str(rank_options.get("scoring_version") or "confidence-v4"),
        corpus_statistics=statistics,
        precomputed_term_frequencies=precomputed_term_frequencies,
        precomputed_document_lengths=precomputed_document_lengths,
    )
    for item in selected:
        item["document_key"] = document_keys.get(str(item.get("id") or ""), "")
    return selected, stats, candidates


def _candidate_raw_score(candidates, candidate_id):
    return next((float(row["raw_score"]) for row in candidates if row["id"] == candidate_id), 0.0)


def _unified_response(engine, selected, stats, fusion, groups, diagnostics, searches, candidates, has_transient):
    document_counts: Counter[str] = Counter()
    for index in (engine._persistent, engine._transient):
        document_counts.update(document.source_type for document in index.documents)
    source_groups = {
        source: {"candidate_count": len(rows), "hit_count": len(rows)}
        for source, rows in groups.items()
    }
    return {
        "status": "ok", "revision": engine.revision,
        "selected": selected, "stats": stats, "fusion": fusion,
        "document_counts": dict(document_counts), "source_groups": source_groups,
        "search_diagnostics": diagnostics,
        "probe": {"counts": {
            "persistent_documents": len(engine._persistent.documents),
            "transient_documents": len(engine._transient.documents) if has_transient else 0,
            "search_specs": len(searches), "candidate_pool": len(candidates),
            "selected": len(selected), "source_groups": len(groups),
        }},
    }


def _ranking_text(document: IndexDocument, database_projection: bool = False) -> str:
    if database_projection:
        if document.source_type == "conversation":
            return document.content
        return "\n".join([document.title, *([document.summary] if document.summary else []), document.content])
    if document.source_type == "conversation":
        # TS conversationAdapter 给每个 chunk 挂同一条完整当前消息作为 ranking_text；
        # chunk 正文只负责存储/引用，不能缩短排序语料。
        return str(document.metadata.get("context_current") or document.content)
    content = document.content.strip()
    parts = [document.title]
    if document.summary and not content.startswith(document.summary):
        parts.append(document.summary)
    parts.append(document.content)
    return "\n".join(parts)


def _lexical_fingerprint(document: IndexDocument, database_projection: bool = False) -> str:
    """复刻 TS worker 的词法指纹；版本和更新时间变化不触发重新安装。"""
    context = (
        document.contextual_content()
        if document.source_type == "conversation" and document.metadata.get("kind") == "message"
        else ""
    )
    payload = "\x1f".join((
        document.source_type,
        document.parent_document_id or "",
        str(document.chunk_index),
        str(document.chunk_count),
        _ranking_text(document, database_projection),
        document.content,
        context,
        document.title,
        document.summary,
        document.scope.scope_type or "",
        document.scope.scope_id or "",
        document.scope.platform or "",
        document.scope.bot_id or "",
        document.scope.group_id or "",
        json.dumps(
            document.metadata if document.metadata is not None else None,
            ensure_ascii=False, separators=(",", ":"),
        ),
    ))
    node_utf8 = payload.encode("utf-16-le", errors="surrogatepass").decode(
        "utf-16-le", errors="replace",
    ).encode("utf-8")
    return hashlib.sha256(node_utf8).hexdigest()


def _matches_worker_scope(document: IndexDocument, scope: Scope | None) -> bool:
    if scope is None:
        return True
    actual = document.scope
    if scope.scope_type in {"project", "folder"}:
        if actual.scope_type != "owner":
            return False
        metadata_key = "project_id" if scope.scope_type == "project" else "folder_id"
        return str(document.metadata.get(metadata_key) or "") == str(scope.scope_id or "")
    if scope.scope_type == "member" and actual.scope_type == "group":
        return (
            actual.platform == scope.platform
            and actual.bot_id == scope.bot_id
            and actual.group_id == scope.group_id
        )
    return all(
        not getattr(scope, field) or getattr(actual, field) == getattr(scope, field)
        for field in ("platform", "bot_id", "group_id", "scope_type", "scope_id")
    )


def _is_after_conversation_watermark(document: IndexDocument, before_message_id: int) -> bool:
    metadata = document.metadata
    if document.source_type != "conversation" or str(metadata.get("kind") or "") != "message":
        return False
    try:
        message_id = float(metadata.get("message_id"))
    except (TypeError, ValueError):
        return True
    return not (math.isfinite(message_id) and message_id < before_message_id)


def _worker_document_wire(document: IndexDocument, key: str, database_projection: bool = False) -> dict[str, object]:
    """返回 TS worker selected.document 的文档字段形状。"""
    text_parts = [document.title]
    content = document.content.strip()
    if document.summary and (database_projection or not content.startswith(document.summary)):
        text_parts.append(document.summary)
    text_parts.append(document.content)
    wire: dict[str, object] = {
        "id": key, "text": "\n".join(text_parts),
        "source_id": document.source_id, "title": document.title,
        "summary": document.summary, "content": document.content,
        "source_type": document.source_type,
        "platform": document.scope.platform, "bot_id": document.scope.bot_id,
        "group_id": document.scope.group_id, "scope_type": document.scope.scope_type,
        "scope_id": document.scope.scope_id or "",
        "document_version": document.version or "",
        "parent_id": document.parent_document_id or "",
        "chunk_index": document.chunk_index, "chunk_count": document.chunk_count,
        "updated_at": document.updated_at, "metadata": document.metadata,
    }
    if database_projection:
        if document.updated_at:
            from datetime import datetime
            from agent.rag.persistent_store import _js_iso_datetime
            wire["updated_at"] = _js_iso_datetime(datetime.fromisoformat(document.updated_at.replace("Z", "+00:00")))
        else:
            wire.pop("updated_at", None)
    if document.source_type == "conversation":
        wire["ranking_text"] = document.content if database_projection else str(document.metadata.get("context_current") or document.content)
        if document.metadata.get("kind") == "message":
            context_text = document.contextual_content()
            if context_text:
                wire["context_text"] = context_text
    return wire


def _rank_wire_document(document: IndexDocument, key: str, source: str, database_projection: bool = False) -> dict[str, object]:
    wire = _worker_document_wire(document, key, database_projection)
    if source == "conversation":
        wire["ranking_text"] = document.content if database_projection else str(document.metadata.get("context_current") or document.content)
        if document.metadata.get("kind") == "message":
            context_text = document.contextual_content()
            if context_text:
                wire["context_text"] = context_text
    return wire


def _merged_statistics(indices: Sequence[CythonBM25Index]) -> dict[str, object]:
    document_count = sum(index.document_count for index in indices)
    total_length = sum(
        index.average_length * index.document_count for index in indices
    )
    frequencies: Counter[str] = Counter()
    for index in indices:
        for term, term_id in index.term_ids.items():
            frequencies[term] += int(index.document_frequencies[term_id])
    return {
        "document_count": document_count,
        "average_length": total_length / document_count if document_count else 0.0,
        "document_frequency": dict(frequencies),
        "source": "combined_ts_index" if len(indices) > 1 else "full_ts_index",
    }


def build_index(
    documents: Sequence[Sequence[str]],
    document_keys: Sequence[str] | None = None,
) -> CythonBM25Index:
    """从 canonical tokenizer 输出构建确定顺序的 CSR 索引。"""
    keys = tuple(str(key) for key in document_keys) if document_keys is not None else tuple(
        str(document_id) for document_id in range(len(documents))
    )
    return _build_index_from_token_stream(
        documents, len(documents), keys, tie_by_key=document_keys is not None,
    )


def _build_index_from_token_stream(
    documents: Iterable[Sequence[str]],
    document_count: int,
    document_keys: Sequence[str],
    *,
    tie_by_key: bool,
) -> CythonBM25Index:
    """委托编译后的 Cython 内核构建紧凑 BM25 CSR posting。"""
    if array("i").itemsize != 4:
        raise RuntimeError("当前平台的 C int 不是 32 位，不能构建 Cython BM25 索引")
    if document_count >= 2**31:
        raise ValueError("文档数超过 Cython BM25 内核支持的 32 位索引范围")
    keys = tuple(str(key) for key in document_keys)
    if len(keys) != document_count:
        raise ValueError("BM25 document_keys 数量必须与文档数量一致")
    if len(set(keys)) != len(keys):
        raise ValueError("BM25 document_keys 必须唯一")
    from agent.rag import cython_native

    (
        lengths, offsets, posting_document_ids, posting_frequencies,
        document_frequencies, tie_ranks, term_ids, average_length,
    ) = cython_native.build_csr(documents, document_count, keys, tie_by_key)
    return CythonBM25Index(
        document_lengths=lengths,
        term_offsets=offsets,
        posting_document_ids=posting_document_ids,
        posting_frequencies=posting_frequencies,
        document_frequencies=document_frequencies,
        document_tie_ranks=tie_ranks,
        document_keys=keys,
        term_ids=term_ids,
        average_length=average_length,
    )


def build_text_index(
    documents: Sequence[str],
    document_keys: Sequence[str] | None = None,
) -> CythonBM25Index:
    """使用指定 Jieba Cython tokenizer 构建文本索引。"""
    keys = tuple(str(key) for key in document_keys) if document_keys is not None else tuple(
        str(document_id) for document_id in range(len(documents))
    )
    return _build_index_from_token_stream(
        (tokenize_raw(text) for text in documents), len(documents), keys,
        tie_by_key=document_keys is not None,
    )


def _import_kernel():
    from .cython_kernel import search_bm25
    return search_bm25


def _load_kernel():
    try:
        return _import_kernel()
    except ImportError as error:
        raise CythonKernelUnavailable(
            "Cython RAG 扩展未构建；仅开发/基准环境可显式编译，不允许静默使用其他后端"
        ) from error


def _load_idf_kernel():
    try:
        from .cython_kernel import idf_rescore
        return idf_rescore
    except ImportError as error:
        raise CythonKernelUnavailable(
            "Cython RAG 扩展未构建；仅开发/基准环境可显式编译，不允许静默使用其他后端"
        ) from error


def search(
    index: CythonBM25Index,
    query_terms: Sequence[str],
    limit: int = 10,
    *,
    eligible_ids: set[int] | None = None,
    eligible_mask: array | None = None,
) -> list[tuple[int, float]]:
    """执行 Cython BM25 查询；未知词项与空语料均返回空命中。"""
    if limit <= 0 or not index.document_count:
        return []
    query_ids = array("i")
    seen: set[str] = set()
    for raw_term in query_terms:
        term = str(raw_term)
        if not term or term in seen:
            continue
        seen.add(term)
        query_ids.append(index.term_ids.get(term, -1))
    if not query_ids or all(term_id < 0 for term_id in query_ids):
        return []

    if eligible_mask is not None and eligible_ids is not None:
        raise ValueError("eligible_ids 与 eligible_mask 不能同时传入")
    if eligible_mask is None:
        eligible_mask = array("i", [1]) * index.document_count
        if eligible_ids is not None:
            eligible_mask = array(
                "i", (int(document_id in eligible_ids) for document_id in range(index.document_count)),
            )

    return _load_kernel()(
        index.document_lengths,
        index.term_offsets,
        index.posting_document_ids,
        index.posting_frequencies,
        index.document_frequencies,
        index.document_tie_ranks,
        query_ids,
        eligible_mask,
        index.average_length,
        limit,
    )


def search_text(index: CythonBM25Index, query: str, limit: int = 10) -> list[tuple[int, float]]:
    """用与建索引相同的 Jieba Cython tokenizer 对原始查询执行 BM25。"""
    return search(index, tokenize_raw(query), limit)


def _ts_string_sort_key(value: str) -> bytes:
    """模拟 TS 字符串 ``<`` 的 UTF-16 code-unit 字典序。"""
    return value.encode("utf-16-be", errors="surrogatepass")


def hybrid_fuse_scores(
    hits: Sequence[str],
    query_vector: Sequence[float],
    vectors: dict[str, Sequence[float]],
    *,
    lexical_weight: float = 0.45,
    vector_weight: float = 0.55,
    rrf_k: float = 60,
) -> tuple[dict[str, float], int, dict[str, float]]:
    """复刻 TS hybridFuseScores；向量不存在时交由调用方决定原样透传/回退。"""
    keys: list[str] = []
    flattened = array("d")
    offsets = array("i", [0])
    lengths = array("i")
    for raw_key in hits:
        key = str(raw_key)
        vector = vectors.get(key)
        if vector is None or len(vector) == 0:
            continue
        values = [float(value) for value in vector]
        keys.append(key)
        flattened.extend(values)
        lengths.append(len(values))
        offsets.append(len(flattened))

    if not keys:
        return {}, 0, {}
    from .cython_kernel import cosine_scores

    query = array("d", map(float, query_vector))
    raw_scores = cosine_scores(query, flattened, offsets, lengths)
    vector_scores = {keys[index]: score for index, score in raw_scores}
    vector_ranked = sorted(vector_scores, key=lambda key: (-vector_scores[key], _ts_string_sort_key(key)))
    vector_ranks = {key: rank for rank, key in enumerate(vector_ranked, start=1)}
    lexical_ranks = {str(key): rank for rank, key in enumerate(hits, start=1)}
    fused_scores: dict[str, float] = {}
    for raw_key in hits:
        key = str(raw_key)
        rank = max(1, lexical_ranks.get(key, 1))
        score = lexical_weight * (rrf_k + 1) / (rrf_k + rank)
        vector_rank = vector_ranks.get(key)
        if vector_rank is not None:
            score += vector_weight * (rrf_k + 1) / (rrf_k + max(1, vector_rank))
        fused_scores[key] = score
    return fused_scores, len(vector_scores), vector_scores


def fuse_hybrid_candidates(
    hits: Sequence[Mapping[str, object]],
    query_vector: Sequence[float],
    vectors: Mapping[str, Sequence[float]],
    *,
    limit: int = 20,
    lexical_weight: float = 0.45,
    vector_weight: float = 0.55,
    rrf_k: float = 60,
    vector_version: str = "",
) -> tuple[list[dict[str, object]], dict[str, object]]:
    """复刻 TS ``hybrid_fuse`` 操作：透传、混合融合及无候选时的词法回退。"""
    capped_limit = max(1, min(int(limit), 200))
    normalized_hits = [
        {"chunk_id": str(hit.get("chunk_id") or ""), "score": float(hit.get("score") or 0)}
        for hit in hits
    ]
    status: dict[str, object] = {
        "fusion": "bm25",
        "vector_doc_count": 0,
        "vector_version": str(vector_version or ""),
        "fallback": "embedding_cache_unavailable",
    }
    if not query_vector or not vectors:
        return normalized_hits[:capped_limit], status

    chunk_ids = [str(hit["chunk_id"]) for hit in normalized_hits]
    fused_scores, vector_count, _ = hybrid_fuse_scores(
        chunk_ids, query_vector, dict(vectors),
        lexical_weight=lexical_weight, vector_weight=vector_weight, rrf_k=rrf_k,
    )
    if fused_scores:
        status.update(fusion="hybrid-rrf", vector_doc_count=vector_count, fallback=None)
        fused = [
            {"chunk_id": chunk_id, "score": fused_scores[chunk_id]}
            for chunk_id in chunk_ids
        ]
    else:
        fused = [
            {
                "chunk_id": chunk_id,
                "score": lexical_weight * (rrf_k + 1) / (rrf_k + max(1, rank)),
            }
            for rank, chunk_id in enumerate(chunk_ids, start=1)
        ]
    fused.sort(key=lambda item: (-float(item["score"]), _ts_string_sort_key(str(item["chunk_id"]))))
    return fused[:capped_limit], status


def idf_rescore_document(
    query: str,
    document: IndexDocument,
    *,
    document_count: int,
    average_length: float,
    document_frequency: dict[str, int],
    query_tokens: Sequence[str] | None = None,
    document_tokens: Sequence[str] | None = None,
    document_term_frequencies: Mapping[str, int] | None = None,
    document_token_length: int | None = None,
) -> dict | None:
    """按 TS idf-rescore 契约生成 rank score 与逐词诊断项。"""
    if document_count <= 0:
        return None
    query_terms = list(dict.fromkeys(
        query_tokens if query_tokens is not None else tokenize_raw(query)
    ))
    if document_term_frequencies is not None:
        frequencies = Counter(document_term_frequencies)
        token_length = int(document_token_length or 0)
    else:
        frequencies = Counter(
            document_tokens if document_tokens is not None else tokenize_raw(_ranking_text(document))
        )
        token_length = sum(frequencies.values())
    return idf_rescore_query_terms(
        query_terms, frequencies, token_length,
        document_count=document_count,
        average_length=average_length,
        document_frequency=document_frequency,
    )


def idf_rescore_query_terms(
    query_terms: Sequence[str],
    term_frequencies: Mapping[str, int],
    document_length: int,
    *,
    document_count: int,
    average_length: float,
    document_frequency: Mapping[str, int],
) -> dict | None:
    """按已分词 query 与倒排表 TF 计算重排结果，不构造临时文档模型。"""
    if document_count <= 0:
        return None
    query_terms = list(dict.fromkeys(query_terms))
    frequencies = term_frequencies
    terms = [term for term in query_terms if term in document_frequency]
    if not terms:
        return None
    df_values = array("i", [int(document_frequency.get(term, -1)) for term in query_terms])
    tf_values = array("i", [int(frequencies.get(term, 0)) for term in query_terms])
    baseline, indexed, contributions = _load_idf_kernel()(
        df_values,
        tf_values,
        int(document_count),
        float(average_length),
        document_length,
    )
    if not indexed or baseline <= 0.0:
        return None
    idf_by_index = {index: value for index, value in indexed}
    contribution_rows = [
        {
            "term": query_terms[index],
            "idf": term_idf,
            "query_weight": query_weight,
            "term_frequency": term_frequency,
            "weighted": weighted,
            "nonlinear": nonlinear,
        }

        for index, term_idf, query_weight, term_frequency, weighted, nonlinear in contributions
    ]
    contribution_rows.sort(key=lambda item: (-item["nonlinear"], locale_sort_key(item["term"])))
    return {
        "rank_score": sum(item["nonlinear"] for item in contribution_rows),
        "matched_terms": [item["term"] for item in contribution_rows],
        "contributions": contribution_rows,
        "query_idf_baseline": baseline,
        "query_idf_terms": [
            {"term": query_terms[index], "idf": idf_by_index[index]}
            for index in range(len(query_terms)) if index in idf_by_index
        ],
    }
