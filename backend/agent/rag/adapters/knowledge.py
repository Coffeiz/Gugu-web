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
        from agent.rag.index_builder import records_to_write_documents

        records = await self.build_source_records(scope=scope)
        return await records_to_write_documents(self.user_id, self.source_type, records)

    async def build_source_record_for(self, source_id: str) -> tuple[dict, Scope] | None:
        """单条读取：只加载一个知识条目的 canonical record（文档级增量入口）。"""
        entry = await KnowledgeStore(self.user_id).get(str(source_id))
        if entry is None:
            return None
        return self._record(entry), self._entry_scope(entry)

    async def build_source_records(self, *, scope: Scope | None = None) -> list[tuple[dict, Scope]]:
        """构建未切块的 canonical Knowledge record，由 TS 负责投影。"""
        entries = await KnowledgeStore(self.user_id).list(
            scope=self._scope(scope) if scope is not None else None,
        )
        return [(self._record(entry), self._entry_scope(entry)) for entry in entries]

    def _record(self, entry) -> dict:
        keywords = [str(item).strip() for item in entry.keywords if str(item).strip()]
        keyword_text = "、".join(keywords)
        summary = entry.topic or entry.source.label or entry.source.type
        if keyword_text:
            summary = f"{summary}；关键词：{keyword_text}"
        keyword_revision = hashlib.sha256(keyword_text.encode("utf-8")).hexdigest()[:12]
        return {
            "source_type": "knowledge", "id": entry.id, "source_id": entry.id,
            "parent_id": entry.id, "title": entry.title, "summary": summary,
            "content": entry.content, "document_version": f"{entry.version}:k{keyword_revision}",
            "updated_at": str(entry.updated_at), "metadata": {
                "topic": entry.topic, "keywords": keyword_text,
                "confidence": entry.confidence, "source_type": entry.source.type,
                "source_ref": entry.source.ref, "source_label": entry.source.label,
                "parent_id": entry.parent_id or "",
            },
        }

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
