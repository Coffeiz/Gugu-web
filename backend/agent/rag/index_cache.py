"""进程内 Rust lexical 索引缓存与跨 worker revision 检测。"""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass

from sqlalchemy import func, select

from agent.rag.models import IndexDocument
from agent.rag.persistent_store import load_index_documents
from agent.rag.models import Scope
from agent.rag.legacy_lexical import LegacyBM25
from agent.rag.rust_sidecar import RustLexicalIndex, RustSidecarClient, RustSidecarUnavailable
from agent.rag.scope import matches_scope
from app.models import KnowledgeIndexEntry


INDEX_CACHE_TTL_SECONDS = 30 * 60
PER_OWNER_CACHE_BYTES = 32 * 1024 * 1024
GLOBAL_CACHE_BYTES = 512 * 1024 * 1024
DEFAULT_SOURCE_TYPES = (
    "memory", "project", "file", "note", "canvas", "calendar", "scheduled_task", "conversation",
)


class PythonLexicalIndex:
    """Python BM25 的异步适配器，与 RustLexicalIndex 使用同一查询契约。"""

    def __init__(self, documents: list[IndexDocument]):
        self.documents = list(documents)
        self._index = LegacyBM25(self.documents)

    async def search(self, query: str, *, limit: int = 10, source_types=(), scope: Scope | None = None) -> list:
        source_type_set = set(source_types)
        candidates = self._index.search(query, limit=min(50, max(1, int(limit) * 5)))
        results = [
            item for item in candidates
            if (not source_type_set or item.document.source_type in source_type_set)
            and (scope is None or matches_scope(item.document, scope))
        ]
        return results[:max(1, min(int(limit), 50))]

    @property
    def estimated_bytes(self) -> int:
        tokens = sum(len(token_list) for token_list in self._index.tokens)
        terms = sum(len(term_freq) for term_freq in self._index.term_freq)
        return estimate_document_bytes(self.documents) + tokens * 12 + terms * 48


def estimate_document_bytes(documents: list[IndexDocument]) -> int:
    """估算 owner 级 Python 文档映射占用。"""
    text_bytes = sum(
        len((doc.title + doc.summary + doc.content).encode("utf-8"))
        for doc in documents
    )
    id_bytes = sum(len(document.chunk_id.encode("utf-8")) + 64 for document in documents)
    return max(1, text_bytes + id_bytes)


def estimate_index_bytes(documents: list[IndexDocument], index) -> int:
    """估算统一缓存预算；Rust 倒排由 sidecar 管理，Python 计入倒排结构。"""
    return max(estimate_document_bytes(documents), int(getattr(index, "estimated_bytes", 0) or 0))


@dataclass
class _Entry:
    index: object
    estimated_bytes: int
    revision: str | None
    backend: str
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
        diagnostics: dict[str, object] | None = None,
    ):
        """返回 owner 级 lexical index，Rust/Python 共用缓存生命周期。"""
        from app.core.config import get_settings

        search_settings = get_settings().search
        backend = _selected_backend(search_settings)
        if diagnostics is not None:
            diagnostics["engine"] = backend
        self._purge_expired()
        owner_key = str(owner_user_id)
        key = (owner_key, backend, "all")
        revision = await self._revision(db, owner_user_id)
        entry = self._entries.get(key)
        if entry is not None and self._valid(entry, revision, backend):
            self._touch(key, entry)
            if diagnostics is not None:
                diagnostics["cache_hit"] = True
            return entry.index

        if diagnostics is not None:
            diagnostics["cache_miss_reason"] = (
                "empty_or_expired" if entry is None
                else "revision_changed" if entry.revision != revision
                else "backend_changed"
            )

        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            revision = await self._revision(db, owner_user_id)
            entry = self._entries.get(key)
            if entry is not None and self._valid(entry, revision, backend):
                self._touch(key, entry)
                if diagnostics is not None:
                    diagnostics["cache_hit"] = True
                return entry.index
            documents = await load_index_documents(db, owner_user_id)
            index = await self._build_index(
                backend, owner_user_id, documents, revision, search_settings,
            )
            if diagnostics is not None:
                diagnostics["cache_hit"] = False
            size = estimate_index_bytes(documents, index)
            if size <= self.owner_limit_bytes:
                self._store(key, _Entry(index, size, revision, backend, time.monotonic()))
            else:
                self._entries.pop(key, None)
                self._dispose(_Entry(index, size, revision, backend, time.monotonic()))
            return index

    async def get_transient(
        self, owner_user_id: object, documents: list[IndexDocument], *, revision: str,
        diagnostics: dict[str, object] | None = None,
    ):
        """缓存无数据库索引的来源，供 Memory/Project transient 召回复用。"""
        from app.core.config import get_settings

        settings = get_settings().search
        backend = _selected_backend(settings)
        if diagnostics is not None:
            diagnostics["engine"] = backend
            diagnostics["cache_entries"] = 1
        owner_key = str(owner_user_id)
        fingerprint = _documents_fingerprint(documents)
        key = (owner_key, backend, f"transient:{fingerprint}")
        self._purge_expired()
        entry = self._entries.get(key)
        if entry is not None and self._valid(entry, revision, backend):
            self._touch(key, entry)
            if diagnostics is not None:
                diagnostics["cache_hit"] = True
            return entry.index
        if diagnostics is not None:
            diagnostics["cache_miss_reason"] = (
                "empty_or_expired" if entry is None
                else "revision_changed" if entry.revision != revision
                else "backend_changed"
            )
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._entries.get(key)
            if entry is not None and self._valid(entry, revision, backend):
                self._touch(key, entry)
                if diagnostics is not None:
                    diagnostics["cache_hit"] = True
                return entry.index
            index = await self._build_index(backend, owner_user_id, documents, revision, settings)
            if diagnostics is not None:
                diagnostics["cache_hit"] = False
            size = estimate_index_bytes(documents, index)
            if size <= self.owner_limit_bytes:
                self._store(key, _Entry(index, size, revision, backend, time.monotonic()))
            else:
                self._dispose(_Entry(index, size, revision, backend, time.monotonic()))
            return index

    async def _build_index(self, backend, owner_user_id, documents, revision, settings):
        if backend == "python":
            return PythonLexicalIndex(documents)
        client = RustSidecarClient(
            owner_user_id,
            command=settings.rust_sidecar_command,
            index_dir=settings.rust_sidecar_index_dir,
        )
        try:
            reuse = getattr(client, "reuse_if_current", None)
            reused = await reuse(revision) if reuse is not None else False
            if not reused:
                await client.replace(documents, revision)
        except Exception:
            await client.close()
            raise
        return RustLexicalIndex(documents, client, revision)

    async def _revision(self, db, owner_user_id: object) -> str | None:
        value = (await db.execute(select(func.max(KnowledgeIndexEntry.indexed_at)).where(
            KnowledgeIndexEntry.owner_user_id == owner_user_id,
            KnowledgeIndexEntry.deleted_at.is_(None),
        ))).scalar_one_or_none()
        return value.isoformat() if value is not None else None

    def invalidate(self, owner_user_id: object, source_type: str | None = None) -> int:
        owner_key = str(owner_user_id)
        keys = [key for key in self._entries if key[0] == owner_key]
        for key in keys:
            entry = self._entries.pop(key, None)
            if entry is not None:
                self._dispose(entry)
        return len(keys)

    def clear(self) -> None:
        for entry in self._entries.values():
            self._dispose(entry)
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

    def _valid(self, entry: _Entry, revision: str | None, backend: str) -> bool:
        return (
            time.monotonic() - entry.last_access <= self.ttl_seconds
            and entry.revision == revision
            and entry.backend == backend
        )

    def _touch(self, key: tuple[str, str, str], entry: _Entry) -> None:
        entry.last_access = time.monotonic()
        self._entries.move_to_end(key)

    def _store(self, key: tuple[str, str, str], entry: _Entry) -> None:
        self._purge_expired()
        previous = self._entries.pop(key, None)
        if previous is not None:
            self._dispose(previous)
        self._entries[key] = entry
        self._evict()

    def _evict(self) -> None:
        owner_bytes: dict[str, int] = {}
        for (owner, _, _), entry in self._entries.items():
            owner_bytes[owner] = owner_bytes.get(owner, 0) + entry.estimated_bytes
        while self._entries and sum(owner_bytes.values()) > self.global_limit_bytes:
            (owner, _, _), entry = self._entries.popitem(last=False)
            self._dispose(entry)
            owner_bytes[owner] -= entry.estimated_bytes
        for owner, used in list(owner_bytes.items()):
            while used > self.owner_limit_bytes:
                key = next((key for key in self._entries if key[0] == owner), None)
                if key is None:
                    break
                entry = self._entries.pop(key)
                self._dispose(entry)
                used -= entry.estimated_bytes

    def _purge_expired(self) -> None:
        now = time.monotonic()
        expired = [
            key for key, entry in self._entries.items()
            if now - entry.last_access > self.ttl_seconds
        ]
        for key in expired:
            entry = self._entries.pop(key, None)
            if entry is not None:
                self._dispose(entry)

    @staticmethod
    def _dispose(entry: _Entry) -> None:
        """异步回收 owner sidecar；Python 索引由 GC 回收。"""
        client = getattr(entry.index, "client", None)
        if client is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        loop.create_task(client.close())


_CACHE = KnowledgeIndexCache()


def get_index_cache() -> KnowledgeIndexCache:
    return _CACHE


async def invalidate_index_cache(owner_user_id: object, source_type: str | None = None) -> int:
    return _CACHE.invalidate(owner_user_id, source_type)


async def search_documents_with_cache(
    owner_user_id: object, documents: list[IndexDocument], query: str, *, limit: int = 10,
    diagnostics: dict[str, object] | None = None,
) -> list:
    """在统一 owner 缓存中查询 transient 文档。"""
    revision = _documents_fingerprint(documents)
    index = await _CACHE.get_transient(
        owner_user_id, documents, revision=revision, diagnostics=diagnostics,
    )
    return await index.search(query, limit=limit)


def _selected_backend(settings) -> str:
    if getattr(settings, "rust_lexical_backend", "rust") == "python":
        return "python"
    if not getattr(settings, "rust_sidecar_enabled", True):
        raise RustSidecarUnavailable("Rust lexical sidecar 未启用")
    return "rust"


def _documents_fingerprint(documents: list[IndexDocument]) -> str:
    import hashlib

    payload = "\n".join("|".join(map(str, document.identity())) for document in documents)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


__all__ = [
    "DEFAULT_SOURCE_TYPES",
    "GLOBAL_CACHE_BYTES",
    "INDEX_CACHE_TTL_SECONDS",
    "KnowledgeIndexCache",
    "PER_OWNER_CACHE_BYTES",
    "PythonLexicalIndex",
    "estimate_document_bytes",
    "estimate_index_bytes",
    "get_index_cache",
    "invalidate_index_cache",
    "search_documents_with_cache",
]
