"""Knowledge 主数据来源适配器。"""

from __future__ import annotations

import hashlib

from agent.knowledge.store import KnowledgeStore
from agent.rag.models import IndexDocument, Scope


class KnowledgeAdapter:
    source_type = "knowledge"

    def __init__(self, user_id: object):
        self.user_id = user_id

    async def build_documents(self, *, scope: Scope) -> list[IndexDocument]:
        entries = await KnowledgeStore(self.user_id).list(scope=self._scope(scope))
        return [self._document(entry, scope) for entry in entries]

    async def build_index_documents(self) -> list[IndexDocument]:
        """构建 owner 全量 Knowledge 文档，仅由索引更新事件调用。"""
        entries = await KnowledgeStore(self.user_id).list()
        return [self._document(entry, self._entry_scope(entry)) for entry in entries]

    def _document(self, entry, scope: Scope) -> IndexDocument:
        keywords = [str(item).strip() for item in entry.keywords if str(item).strip()]
        keyword_text = "、".join(keywords)
        summary = entry.topic or entry.source.label or entry.source.type
        if keyword_text:
            summary = f"{summary}；关键词：{keyword_text}"
        keyword_revision = hashlib.sha256(keyword_text.encode("utf-8")).hexdigest()[:12]
        return IndexDocument(
            document_id=entry.id,
            source_type=self.source_type,
            source_id=entry.id,
            scope=scope,
            title=entry.title,
            summary=summary,
            content=entry.content,
            # 关键词属于可检索字段；纳入版本，确保只有关键词变化也会触发索引更新。
            version=f"{entry.version}:k{keyword_revision}",
            updated_at=str(entry.updated_at),
            metadata={
                "topic": entry.topic,
                "keywords": keyword_text,
                "confidence": entry.confidence,
                "source_type": entry.source.type,
                "source_ref": entry.source.ref,
                "source_label": entry.source.label,
                "parent_id": entry.parent_id or "",
            },
        )

    @staticmethod
    def _entry_scope(entry) -> Scope:
        source_scope = entry.scope
        return Scope(
            owner_user_id=str(source_scope.owner_user_id),
            platform=source_scope.platform,
            bot_id=source_scope.bot_id,
            group_id=source_scope.group_id,
            scope_type=source_scope.type,
            scope_id=source_scope.scope_id,
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
