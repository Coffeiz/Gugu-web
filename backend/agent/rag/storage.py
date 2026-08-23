"""RAG 索引存储协议与 Memory 持久化实现。"""
from __future__ import annotations

import json
from typing import Protocol

from app.services.storage import get_storage
from agent.rag.index import InMemoryIndex
from agent.rag.models import IndexDocument, Scope


MEMORY_INDEX_SCHEMA_VERSION = 1


def _index_key(user_id: object) -> str:
    return f"{user_id}/.agent/rag/memory-index-v1.json"


def _document_to_record(document: IndexDocument) -> dict:
    return {
        "document_id": document.document_id,
        "source_type": document.source_type,
        "source_id": document.source_id,
        "scope": {
            "owner_user_id": document.scope.owner_user_id,
            "platform": document.scope.platform,
            "bot_id": document.scope.bot_id,
            "group_id": document.scope.group_id,
            "scope_type": document.scope.scope_type,
            "scope_id": document.scope.scope_id,
        },
        "title": document.title,
        "summary": document.summary,
        "content": document.content,
        "version": document.version,
        "chunk_index": document.chunk_index,
        "chunk_count": document.chunk_count,
        "parent_document_id": document.parent_document_id,
        "updated_at": document.updated_at,
        "metadata": document.metadata,
    }


def _document_from_record(record: dict) -> IndexDocument | None:
    try:
        raw_scope = record["scope"]
        return IndexDocument(
            document_id=str(record["document_id"]),
            source_type=str(record["source_type"]),
            source_id=str(record["source_id"]),
            scope=Scope(
                owner_user_id=str(raw_scope["owner_user_id"]),
                platform=str(raw_scope.get("platform") or ""),
                bot_id=str(raw_scope.get("bot_id") or ""),
                group_id=str(raw_scope.get("group_id") or ""),
                scope_type=str(raw_scope.get("scope_type") or "owner"),
                scope_id=str(raw_scope.get("scope_id") or ""),
            ),
            title=str(record.get("title") or ""),
            summary=str(record.get("summary") or ""),
            content=str(record.get("content") or ""),
            version=str(record["version"]),
            chunk_index=int(record.get("chunk_index", 0)),
            chunk_count=int(record.get("chunk_count", 1)),
            parent_document_id=record.get("parent_document_id"),
            updated_at=record.get("updated_at"),
            metadata=record.get("metadata") if isinstance(record.get("metadata"), dict) else {},
        )
    except (KeyError, TypeError, ValueError):
        return None


class IndexStore(Protocol):
    def upsert(self, document: IndexDocument) -> None: ...
    def invalidate(self, document_id: str) -> int: ...
    def documents(self) -> list[IndexDocument]: ...


class PersistentMemoryIndex:
    """按 owner 保存的可重建 JSON 索引。

    索引只保存 Memory 的摘要/chunk 和检索元数据；主数据仍由 Memory store 管理。
    同一用户的替换写由上层 pipeline 串行化，覆盖写本身保持幂等。
    """

    def __init__(self, user_id: object):
        self.user_id = user_id

    async def load(self) -> list[IndexDocument] | None:
        try:
            raw = await get_storage().get(_index_key(self.user_id))
            payload = json.loads(raw.decode("utf-8"))
            if payload.get("schema_version") != MEMORY_INDEX_SCHEMA_VERSION:
                return None
            records = payload.get("documents")
            if not isinstance(records, list):
                return None
            return [
                document for record in records
                if isinstance(record, dict)
                for document in [_document_from_record(record)]
                if document is not None
            ]
        except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError, AttributeError):
            return None

    async def replace(self, documents: list[IndexDocument]) -> None:
        payload = {
            "schema_version": MEMORY_INDEX_SCHEMA_VERSION,
            "documents": [_document_to_record(document) for document in documents],
        }
        await get_storage().put(
            _index_key(self.user_id),
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            "application/json",
        )

    async def invalidate(self) -> None:
        await get_storage().delete(_index_key(self.user_id))


__all__ = ["IndexStore", "InMemoryIndex", "PersistentMemoryIndex"]
