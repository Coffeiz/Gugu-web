"""文件、画布和对话的统一业务来源桥接。

这里只负责数据库/存储读取和业务 scope 校验；文档转换交给 TS Worker 的 source
adapter，词法检索交给 TS lexical index，避免为每个来源重复维护搜索算法。
"""
from __future__ import annotations

import time
from collections.abc import Iterable
from contextlib import asynccontextmanager

from agent.rag.index_builder import build_source_documents
from agent.rag.index_cache import get_index_cache, search_documents_with_cache
from agent.rag.models import Scope
from agent.rag.retriever import RetrievalBatch
from agent.rag.scope import matches_scope
from agent.rag.ts_sidecar import TsSidecarUnavailable


def _conversation_document_visible(document, before_message_id: int | None) -> bool:
    """按当前 run 的消息水位过滤 conversation 文档。"""
    if before_message_id is None:
        return True
    metadata = getattr(document, "metadata", None) or {}
    if metadata.get("kind") != "message":
        return True
    raw_id = metadata.get("message_id") or getattr(document, "source_id", None)
    try:
        return int(raw_id) < int(before_message_id)
    except (TypeError, ValueError):
        return False


class IndexedSourceRetriever:
    """把文件、画布和对话来源接入统一的 TS lexical index。"""

    def __init__(self, user_id: object, *, db=None, db_factory=None, source_type: str):
        if source_type not in {"file", "canvas", "conversation"}:
            raise ValueError(f"不支持的统一来源：{source_type}")
        self.user_id = user_id
        self.db = db
        self.db_factory = db_factory
        self.source_type = source_type

    @asynccontextmanager
    async def session_scope(self):
        """每个来源检索使用独立 AsyncSession，避免 gather 共享连接。"""
        if self.db_factory is not None:
            async with self.db_factory() as db:
                yield db
            return
        if self.db is not None:
            yield self.db
            return
        import app.db.session as db_session

        db_session.ensure_engine()
        async with db_session._SessionLocal() as db:
            yield db

    async def retrieve(
        self,
        query: str,
        *,
        scope: Scope | Iterable[Scope] | str,
        strategy: str,
        candidate_limit: int,
    ) -> RetrievalBatch:
        if strategy not in {"auto", "bm25", "embedding"}:
            raise ValueError("策略只能是 auto、bm25 或 embedding")
        scopes = list(scope) if isinstance(scope, (list, tuple)) else [scope]
        valid_scopes = [item for item in scopes if isinstance(item, Scope)]
        if self.source_type == "file":
            valid_scopes = [item for item in valid_scopes if item.scope_type in {"owner", "project", "folder"}]
        elif self.source_type == "canvas":
            valid_scopes = [item for item in valid_scopes if item.scope_type in {"owner", "project"}]
        if not valid_scopes:
            return RetrievalBatch(
                source_type=self.source_type,
                index_source=f"{self.source_type}-db",
                fallback_reason="scope_rejected",
            )

        conversation_before_message_id = None
        if self.source_type == "conversation":
            from agent.rag.context import get_conversation_before_message_id

            conversation_before_message_id = get_conversation_before_message_id()

        async with self.session_scope() as db:
            started = time.monotonic()
            cache = get_index_cache()
            source_key = f"{self.source_type}:all"
            documents = await cache.get_snapshot_documents(
                self.user_id,
                source_key,
                lambda: build_source_documents(db, self.user_id, self.source_type),
            )
            scoped_documents = [
                document for document in documents
                if any(matches_scope(document, item) for item in valid_scopes)
            ]
            if self.source_type == "conversation":
                scoped_documents = [
                    document for document in scoped_documents
                    if _conversation_document_visible(
                        document, conversation_before_message_id,
                    )
                ]
            metadata: dict[str, object] = {
                "document_load_ms": int((time.monotonic() - started) * 1000),
                "source_adapter": self.source_type,
            }
            if conversation_before_message_id is not None:
                metadata["conversation_before_message_id"] = conversation_before_message_id
            try:
                results = await search_documents_with_cache(
                    self.user_id,
                    scoped_documents,
                    query,
                    limit=candidate_limit,
                    source_types={self.source_type},
                    scope=None,
                    diagnostics=metadata,
                )
            except TsSidecarUnavailable:
                results = []
                metadata.update({"engine": "unavailable", "fallback": "lexical_worker_unavailable"})
        return RetrievalBatch(
            source_type=self.source_type,
            results=tuple(results),
            index_source=f"{self.source_type}-db",
            fallback_reason="embedding_not_indexed",
            candidate_count=len(scoped_documents),
            metadata={key: str(value) for key, value in metadata.items()},
        )


__all__ = ["IndexedSourceRetriever"]
