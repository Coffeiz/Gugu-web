"""Knowledge 主数据来源适配器。"""

from __future__ import annotations

from agent.knowledge.store import KnowledgeStore
from agent.rag.models import IndexDocument, Scope
from agent.rag.scope import normalize_memory_scopes
from agent.rag.retriever import RetrievalBatch


class KnowledgeAdapter:
    source_type = "knowledge"

    def __init__(self, user_id: object):
        self.user_id = user_id

    async def build_documents(self, *, scope: Scope) -> list[IndexDocument]:
        entries = await KnowledgeStore(self.user_id).list(scope=self._scope(scope))
        return [
            IndexDocument(
                document_id=entry.id,
                source_type=self.source_type,
                source_id=entry.id,
                scope=scope,
                title=entry.title,
                summary=entry.topic or entry.source.label or entry.source.type,
                content=entry.content,
                version=str(entry.version),
                updated_at=str(entry.updated_at),
                metadata={
                    "topic": entry.topic,
                    "confidence": entry.confidence,
                    "source_type": entry.source.type,
                    "source_ref": entry.source.ref,
                    "source_label": entry.source.label,
                    "parent_id": entry.parent_id or "",
                },
            )
            for entry in entries
        ]

    async def retrieve(
        self, query: str, *, scope, strategy: str, candidate_limit: int,
    ) -> RetrievalBatch:
        if strategy not in {"auto", "bm25", "embedding"}:
            raise ValueError("策略只能是 auto、bm25 或 embedding")
        from agent.rag.index_cache import get_index_cache, search_documents_with_cache
        query_scopes = normalize_memory_scopes(self.user_id, scope)
        import asyncio
        load_started = asyncio.get_running_loop().time()
        document_sets = await asyncio.gather(*[
            get_index_cache().get_snapshot_documents(
                self.user_id,
                f"knowledge:{query_scope.key()}",
                lambda query_scope=query_scope: self.build_documents(scope=query_scope),
            )
            for query_scope in query_scopes
        ])
        documents = [document for documents_for_scope in document_sets for document in documents_for_scope]
        document_load_ms = int((asyncio.get_running_loop().time() - load_started) * 1000)
        if not documents:
            return RetrievalBatch(
                source_type=self.source_type, results=(),
                index_source="knowledge-store", fallback_reason="empty",
                candidate_count=0,
            )
        diagnostics: dict[str, object] = {}
        results = await search_documents_with_cache(
            self.user_id, documents, query, limit=candidate_limit,
            source_types={"knowledge"},
            diagnostics=diagnostics,
        )
        fusion = "bm25"
        fallback_reason = "embedding_disabled"
        if strategy in {"auto", "embedding"}:
            from agent.memory import embedding
            from agent.rag.hybrid import hybrid_results
            from agent.rag.service import _load_cached_vectors

            if embedding.is_enabled():
                query_vector = await embedding.embed(query)
                vector_map = await _load_cached_vectors(self.user_id, documents)
                results, fallback_reason = hybrid_results(
                    results, documents, query_vector, vector_map, limit=candidate_limit,
                )
                if fallback_reason is None:
                    fusion = "hybrid-rrf"
            elif strategy == "embedding":
                fallback_reason = "embedding_disabled"
        return RetrievalBatch(
            source_type=self.source_type, results=tuple(results),
            index_source="knowledge-store", fallback_reason=fallback_reason,
            candidate_count=len(documents),
            metadata={
                **{key: str(value) for key, value in diagnostics.items()},
                "document_load_ms": str(document_load_ms),
                "fusion": fusion,
            },
        )

    @staticmethod
    def _scope(scope: Scope):
        from agent.knowledge.models import KnowledgeScope
        return KnowledgeScope(
            type=scope.scope_type, owner_user_id=scope.owner_user_id,
            platform=scope.platform, bot_id=scope.bot_id,
            group_id=scope.group_id, scope_id=scope.scope_id,
            project_id=getattr(scope, "project_id", ""),
        )
