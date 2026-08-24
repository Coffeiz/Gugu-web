"""进程内 BM25 索引缓存与跨 worker revision 检测。"""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass

from sqlalchemy import func, select

from agent.rag.lexical import BM25
from agent.rag.models import IndexDocument
from agent.rag.persistent_store import load_index_documents
from agent.rag.scope import matches_scope
from agent.rag.models import Scope
from app.models import KnowledgeIndexEntry


INDEX_CACHE_TTL_SECONDS = 30 * 60
PER_OWNER_CACHE_BYTES = 32 * 1024 * 1024
GLOBAL_CACHE_BYTES = 512 * 1024 * 1024
DEFAULT_SOURCE_TYPES = (
    "memory", "project", "file", "note", "canvas", "calendar", "scheduled_task", "conversation",
)


def estimate_index_bytes(documents: list[IndexDocument], index: BM25) -> int:
    """估算索引占用，采用偏保守的 token/字符串/Counter 近似。"""
    text_bytes = sum(
        len((doc.title + doc.summary + doc.content).encode("utf-8"))
        for doc in documents
    )
    token_bytes = sum(
        len(token.encode("utf-8")) + 32
        for tokens in index.tokens for token in tokens
    )
    counter_bytes = sum(len(counter) * 72 for counter in index.term_freq)
    vocabulary_bytes = sum(len(term.encode("utf-8")) + 48 for term in index.doc_freq)
    return max(1, text_bytes + token_bytes + counter_bytes + vocabulary_bytes)


@dataclass
class _Entry:
    index: BM25
    estimated_bytes: int
    revision: str | None
    last_access: float


class KnowledgeIndexCache:
    def __init__(
        self,
        *,
        ttl_seconds: int = INDEX_CACHE_TTL_SECONDS,
        owner_limit_bytes: int = PER_OWNER_CACHE_BYTES,
        global_limit_bytes: int = GLOBAL_CACHE_BYTES,
    ):
        self.ttl_seconds = ttl_seconds
        self.owner_limit_bytes = owner_limit_bytes
        self.global_limit_bytes = global_limit_bytes
        self._entries: OrderedDict[tuple[str, str, str], _Entry] = OrderedDict()
        self._locks: dict[tuple[str, str, str], asyncio.Lock] = {}

    async def get(
        self, db, owner_user_id: object, source_type: str, scope: Scope | None = None,
    ) -> BM25:
        self._purge_expired()
        owner_key = str(owner_user_id)
        scope_key = scope.key() if scope is not None else "owner"
        key = (owner_key, source_type, scope_key)
        revision = await self._revision(db, owner_user_id, source_type)
        entry = self._entries.get(key)
        if entry is not None and self._valid(entry, revision):
            self._touch(key, entry)
            return entry.index

        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            revision = await self._revision(db, owner_user_id, source_type)
            entry = self._entries.get(key)
            if entry is not None and self._valid(entry, revision):
                self._touch(key, entry)
                return entry.index
            documents = await load_index_documents(
                db, owner_user_id, source_types={source_type},
            )
            if scope is not None:
                documents = [document for document in documents if matches_scope(document, scope)]
            index = BM25(documents)
            size = estimate_index_bytes(documents, index)
            if size <= self.owner_limit_bytes:
                self._store(key, _Entry(index, size, revision, time.monotonic()))
            else:
                self._entries.pop(key, None)
            return index

    async def _revision(self, db, owner_user_id: object, source_type: str) -> str | None:
        value = (await db.execute(select(func.max(KnowledgeIndexEntry.indexed_at)).where(
            KnowledgeIndexEntry.owner_user_id == owner_user_id,
            KnowledgeIndexEntry.source_type == source_type,
            KnowledgeIndexEntry.deleted_at.is_(None),
        ))).scalar_one_or_none()
        return value.isoformat() if value is not None else None

    def invalidate(self, owner_user_id: object, source_type: str | None = None) -> int:
        owner_key = str(owner_user_id)
        keys = [key for key in self._entries if key[0] == owner_key and (
            source_type is None or key[1] == source_type
        )]
        for key in keys:
            self._entries.pop(key, None)
        return len(keys)

    def clear(self) -> None:
        self._entries.clear()
        self._locks.clear()

    def stats(self) -> dict[str, int]:
        self._purge_expired()
        owner_bytes: dict[str, int] = {}
        total = 0
        for (owner, _, _), entry in self._entries.items():
            total += entry.estimated_bytes
            owner_bytes[owner] = owner_bytes.get(owner, 0) + entry.estimated_bytes
        return {
            "entries": len(self._entries),
            "owners": len(owner_bytes),
            "estimated_bytes": total,
            "estimated_mb": round(total / 1024 / 1024, 2),
        }

    def _valid(self, entry: _Entry, revision: str | None) -> bool:
        return time.monotonic() - entry.last_access <= self.ttl_seconds and entry.revision == revision

    def _touch(self, key: tuple[str, str, str], entry: _Entry) -> None:
        entry.last_access = time.monotonic()
        self._entries.move_to_end(key)

    def _store(self, key: tuple[str, str, str], entry: _Entry) -> None:
        self._purge_expired()
        self._entries.pop(key, None)
        self._entries[key] = entry
        self._evict()

    def _evict(self) -> None:
        owner_bytes: dict[str, int] = {}
        for (owner, _, _), entry in self._entries.items():
            owner_bytes[owner] = owner_bytes.get(owner, 0) + entry.estimated_bytes
        while self._entries and sum(owner_bytes.values()) > self.global_limit_bytes:
            (owner, _, _), entry = self._entries.popitem(last=False)
            owner_bytes[owner] -= entry.estimated_bytes
        for owner, used in list(owner_bytes.items()):
            while used > self.owner_limit_bytes:
                key = next((key for key in self._entries if key[0] == owner), None)
                if key is None:
                    break
                entry = self._entries.pop(key)
                used -= entry.estimated_bytes

    def _purge_expired(self) -> None:
        now = time.monotonic()
        expired = [
            key for key, entry in self._entries.items()
            if now - entry.last_access > self.ttl_seconds
        ]
        for key in expired:
            self._entries.pop(key, None)


_CACHE = KnowledgeIndexCache()


def get_index_cache() -> KnowledgeIndexCache:
    return _CACHE


async def invalidate_index_cache(owner_user_id: object, source_type: str | None = None) -> int:
    return _CACHE.invalidate(owner_user_id, source_type)


__all__ = [
    "DEFAULT_SOURCE_TYPES",
    "GLOBAL_CACHE_BYTES",
    "INDEX_CACHE_TTL_SECONDS",
    "KnowledgeIndexCache",
    "PER_OWNER_CACHE_BYTES",
    "estimate_index_bytes",
    "get_index_cache",
    "invalidate_index_cache",
]
