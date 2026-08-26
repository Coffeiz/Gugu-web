"""历史会话来源 adapter。

会话工具仍保持自己的返回格式和完整读取能力；这里只把消息搜索转换成统一
``RetrievalBatch``，复用 RAG 的 scope、confidence、去重和预算流水线。
"""
from __future__ import annotations

from sqlalchemy import desc, select

from app.models import ConversationMessage, ConversationSession
from app.search.query import keyword_condition, keyword_score, normalize_queries
from agent.rag.models import IndexDocument, Scope
from agent.rag.retriever import RetrievalBatch
from agent.rag.index_cache import search_documents_with_cache
from agent.rag.ts_sidecar import TsSidecarUnavailable


class ConversationAdapter:
    source_type = "conversation"

    def __init__(self, user_id: object, *, db, queries=None, mode: str = "OR"):
        self.user_id = user_id
        self.db = db
        self.queries = list(queries or ())
        self.mode = mode

    async def retrieve(
        self, query: str, *, scope, strategy: str, candidate_limit: int,
    ) -> RetrievalBatch:
        if strategy not in {"auto", "bm25", "embedding"}:
            raise ValueError("策略只能是 auto、bm25 或 embedding")
        query_scope = scope if isinstance(scope, Scope) else Scope(str(self.user_id))
        if query_scope.owner_user_id != str(self.user_id) or query_scope.scope_type != "owner":
            return RetrievalBatch(
                source_type=self.source_type, index_source="conversation-db",
                fallback_reason="scope_rejected",
            )
        queries = self.queries or normalize_queries(query)
        if not queries:
            return RetrievalBatch(
                source_type=self.source_type, index_source="conversation-db",
                fallback_reason="empty_query",
            )
        columns = [
            ConversationMessage.content,
            ConversationSession.title,
            ConversationSession.summary,
        ]
        rows = (await self.db.execute(
            select(ConversationMessage, ConversationSession)
            .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
            .where(
                ConversationSession.user_id == self.user_id,
                ConversationMessage.content_json.is_(None),
                keyword_condition(columns, queries, self.mode),
            )
            .order_by(
                keyword_score(columns, queries).desc(),
                desc(ConversationMessage.created_at),
            )
            .limit(max(1, min(int(candidate_limit), 20)))
        )).all()
        documents = []
        for message, session in rows:
            content = (message.content or "").strip()
            if not content:
                continue
            documents.append(IndexDocument(
                document_id=f"conversation:{session.id}:{message.id}",
                source_type=self.source_type,
                source_id=str(session.id),
                scope=query_scope,
                title=session.title or "未命名对话",
                summary=session.summary or "",
                content=content[:1200],
                version=str(message.id),
                updated_at=message.created_at.isoformat() if message.created_at else None,
                metadata={
                    "message_id": message.id,
                    "role": message.role,
                    "session_source": session.source,
                    "session_updated_at": session.updated_at.isoformat() if session.updated_at else None,
                },
            ))
        search_metadata: dict[str, object] = {}
        try:
            results = await search_documents_with_cache(
                self.user_id, documents, query, limit=candidate_limit,
                source_types={"conversation"}, scope=query_scope,
                diagnostics=search_metadata,
            )
        except TsSidecarUnavailable:
            results = []
            search_metadata["fallback"] = "lexical_worker_unavailable"
        return RetrievalBatch(
            source_type=self.source_type,
            results=tuple(results),
            index_source="conversation-db",
            fallback_reason="embedding_not_indexed",
            candidate_count=len(documents),
            metadata={
                "engine": str(search_metadata.get("engine") or "conversation-db"),
                **{key: str(value) for key, value in search_metadata.items()},
            },
        )
