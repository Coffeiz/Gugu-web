"""历史会话来源 adapter。

会话工具仍保持自己的返回格式和完整读取能力；这里只把消息搜索转换成统一
``RetrievalBatch``，复用 RAG 的 scope、confidence、去重和预算流水线。
"""
from __future__ import annotations

from sqlalchemy import select

from app.models import ConversationMessage, ConversationSession
from app.search.query import normalize_queries
from agent.rag.models import IndexDocument, Scope
from agent.rag.retriever import RetrievalBatch
from agent.rag.index_cache import search_documents_with_cache
from agent.rag.persistent_store import search_persistent_index
from agent.rag.ts_sidecar import TsSidecarUnavailable


class ConversationAdapter:
    source_type = "conversation"

    def __init__(self, user_id: object, *, db, queries=None, mode: str = "OR"):
        self.user_id = user_id
        self.db = db
        self.queries = list(queries or ())
        self.mode = mode

    async def _build_documents(self, scope: Scope) -> list[IndexDocument]:
        """索引尚未建立时只做来源投影，关键词检索仍统一交给 TS。"""
        rows = (await self.db.execute(
            select(ConversationMessage, ConversationSession)
            .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
            .where(
                ConversationSession.user_id == self.user_id,
                ConversationMessage.content_json.is_(None),
            )
            .order_by(ConversationMessage.id.asc())
        )).all()
        documents: list[IndexDocument] = []
        for message, session in rows:
            content = (message.content or "").strip()
            if not content:
                continue
            documents.append(IndexDocument(
                document_id=f"conversation:{session.id}:{message.id}",
                source_type=self.source_type,
                source_id=str(session.id),
                scope=scope,
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
        return documents

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
        search_metadata: dict[str, object] = {}
        try:
            # Agent 的历史对话检索与其他 RAG 来源统一走 TS 索引；SQL 只负责
            # 由持久化索引入口读取已授权的 conversation chunk，不在 Python 侧
            # 再维护一套关键词筛选和排序。
            results = await search_persistent_index(
                self.db, self.user_id, " ".join(queries),
                source_types={self.source_type}, scope=query_scope,
                limit=candidate_limit, diagnostics=search_metadata,
            )
            if not results and not int(search_metadata.get("document_count", 0) or 0):
                documents = await self._build_documents(query_scope)
                results = await search_documents_with_cache(
                    self.user_id, documents, " ".join(queries),
                    limit=candidate_limit, source_types={self.source_type},
                    scope=query_scope, diagnostics=search_metadata,
                )
                search_metadata["document_count"] = len(documents)
        except TsSidecarUnavailable:
            results = []
            search_metadata["fallback"] = "lexical_worker_unavailable"
        return RetrievalBatch(
            source_type=self.source_type,
            results=tuple(results),
            index_source="conversation-db",
            fallback_reason="embedding_disabled",
            candidate_count=int(search_metadata.get("document_count", 0) or 0),
            metadata={
                "engine": str(search_metadata.get("engine") or "conversation-db"),
                **{key: str(value) for key, value in search_metadata.items()},
            },
        )
