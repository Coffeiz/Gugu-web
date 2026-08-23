"""可替换的内存索引生命周期接口。

Memory 试点的生产查询默认使用 `PersistentMemoryIndex`；本实现保留给测试和
无法持久化时的可重建回退。
"""
from __future__ import annotations

from agent.rag.models import IndexDocument


class InMemoryIndex:
    def __init__(self) -> None:
        self._documents: dict[str, IndexDocument] = {}

    def upsert(self, document: IndexDocument) -> None:
        # 同一父文档的新版本写入时，先让旧版本整体失效，避免新旧 chunk 并存。
        parent = document.parent_document_id or document.document_id
        stale = [
            key for key, value in self._documents.items()
            if (value.parent_document_id or value.document_id) == parent
            and value.version != document.version
        ]
        for key in stale:
            del self._documents[key]
        self._documents[document.chunk_id] = document

    def invalidate(self, document_id: str) -> int:
        keys = [key for key, value in self._documents.items() if value.document_id == document_id or value.parent_document_id == document_id]
        for key in keys:
            del self._documents[key]
        return len(keys)

    def documents(self) -> list[IndexDocument]:
        return list(self._documents.values())
