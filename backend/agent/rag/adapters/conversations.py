"""历史会话来源 adapter。

会话工具仍保持自己的返回格式和完整读取能力；这里只把消息搜索转换成统一
``RetrievalBatch``，复用 RAG 的 scope、confidence、去重和预算流水线。
"""
from __future__ import annotations

from sqlalchemy import and_, case, func, or_, select

from app.models import ConversationMessage, ConversationSession
from app.search.query import normalize_queries
from agent.rag.models import IndexDocument, RecallResult, Scope
from agent.rag.retriever import RetrievalBatch


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

        # 历史消息搜索必须覆盖数据库中仍保留的消息。RAG 索引为了上下文压缩
        # 会跳过 baseline 水位之前的内容，因此这里直接按会话归属查数据库。
        terms = normalize_queries(queries=queries)
        if not terms:
            return RetrievalBatch(
                source_type=self.source_type, index_source="conversation-db",
                fallback_reason="empty_query",
            )
        conditions = [
            ConversationMessage.content.ilike(
                f"%{_escape_like_term(term)}%", escape="\\",
            )
            for term in terms
        ]
        match_condition = and_(*conditions) if self.mode == "AND" else or_(*conditions)
        match_count = sum(
            [case((condition, 1), else_=0) for condition in conditions]
        ).label("match_count")
        session_rank = func.row_number().over(
            partition_by=ConversationSession.id,
            order_by=(
                match_count.desc(),
                ConversationMessage.conversation_seq.desc(),
            ),
        ).label("session_rank")
        candidate_rows = (
            select(
                ConversationMessage.id.label("message_id"),
                ConversationMessage.session_id,
                ConversationMessage.role,
                ConversationMessage.content,
                ConversationMessage.conversation_seq,
                ConversationSession.title,
                ConversationSession.summary,
                ConversationSession.source.label("session_source"),
                ConversationSession.updated_at.label("session_updated_at"),
                match_count,
                session_rank,
            )
            .join(ConversationSession, ConversationSession.id == ConversationMessage.session_id)
            .where(
                ConversationSession.user_id == self.user_id,
                ConversationSession.chat_type.is_distinct_from("group"),
                ConversationMessage.role.in_(("user", "assistant")),
                ConversationMessage.content.is_not(None),
                ConversationMessage.content != "",
                match_condition,
            )
            .subquery()
        )
        limit = max(1, min(int(candidate_limit), 50))
        rows = (await self.db.execute(
            select(candidate_rows)
            .where(candidate_rows.c.session_rank == 1)
            .order_by(
                candidate_rows.c.match_count.desc(),
                candidate_rows.c.created_at.desc(),
                candidate_rows.c.message_id.desc(),
            )
            .limit(limit)
        )).mappings().all()

        results = []
        for row in rows:
            document = IndexDocument(
                document_id=f"conversation:{row.session_id}:{row.message_id}",
                source_type=self.source_type,
                source_id=str(row.message_id),
                scope=query_scope,
                title=row.title or "未命名对话",
                summary=row.summary or "",
                content=row.content,
                version=f"{row.message_id}:{row.created_at.isoformat()}",
                updated_at=(row.created_at.isoformat() if row.created_at else None),
                metadata={
                    "session_id": str(row.session_id),
                    "message_id": row.message_id,
                    "role": row.role,
                    "session_source": row.session_source or "web",
                    "session_updated_at": (
                        row.session_updated_at.isoformat()
                        if row.session_updated_at else ""
                    ),
                },
            )
            results.append(RecallResult(
                document,
                float(row.match_count) / len(terms),
            ))
        return RetrievalBatch(
            source_type=self.source_type,
            results=tuple(results),
            index_source="conversation-db",
            fallback_reason=None,
            candidate_count=len(results),
            metadata={"engine": "postgresql", "token_count": str(len(terms))},
        )


def _escape_like_term(term: str) -> str:
    """把用户检索词当作字面文本，而不是 SQL LIKE 通配符。"""
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
