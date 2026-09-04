"""进程内 TypeScript lexical 索引缓存与跨 worker revision 检测。"""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Awaitable, Callable

from sqlalchemy import func, select

from agent.rag.models import IndexDocument
from agent.rag.persistent_store import load_index_documents
from agent.rag.models import Scope
from agent.rag.ts_sidecar import (
    TsLexicalIndex,
    TsSidecarUnavailable,
    _index_document_digest,
    get_lexical_client,
    index_dir_for_owner,
)
from agent.rag.scope import matches_scope
from app.models import KnowledgeIndexEntry


INDEX_CACHE_TTL_SECONDS = 30 * 60
PER_OWNER_CACHE_BYTES = 32 * 1024 * 1024
GLOBAL_CACHE_BYTES = 512 * 1024 * 1024
DEFAULT_SOURCE_TYPES = (
    "memory", "project", "file", "note", "canvas", "calendar", "scheduled_task", "conversation",
)


def estimate_document_bytes(documents: list[IndexDocument]) -> int:
    """估算 owner 级 Python 文档映射占用。"""
    text_bytes = sum(
        len((doc.title + doc.summary + doc.content).encode("utf-8"))
        for doc in documents
    )
    id_bytes = sum(len(document.chunk_id.encode("utf-8")) + 64 for document in documents)
    return max(1, text_bytes + id_bytes)


def estimate_index_bytes(documents: list[IndexDocument], index) -> int:
    """估算统一 TypeScript lexical index 的缓存预算。"""
    return max(estimate_document_bytes(documents), int(getattr(index, "estimated_bytes", 0) or 0))


def _worker_document_key(document: IndexDocument) -> str:
    """返回 sidecar 使用的稳定 chunk slot，不包含可变的文档版本。"""
    parent = document.parent_document_id or document.document_id
    return f"{document.source_type}:{parent}:{document.chunk_index}"


@dataclass
class _Entry:
    index: object
    estimated_bytes: int
    revision: str | None
    backend: str
    last_access: float


@dataclass
class _SnapshotDocuments:
    documents: list[IndexDocument]
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
        self._snapshot_documents: dict[tuple[str, str, str], _SnapshotDocuments] = {}
        self._snapshot_document_locks: dict[tuple[str, str, str], asyncio.Lock] = {}

    async def get(
        self, db, owner_user_id: object, source_type: str, scope: Scope | None = None,
        diagnostics: dict[str, object] | None = None,
        baseline_revision: str | None = None,
    ):
        """返回 owner 级 lexical index，TypeScript/Python 共用缓存生命周期。"""
        from app.core.config import get_settings

        search_settings = get_settings().search
        backend = _selected_backend(search_settings)
        if diagnostics is not None:
            diagnostics["engine"] = backend
        self._purge_expired()
        owner_key = str(owner_user_id)
        from agent.rag.context import get_shared_index_key

        shared_key = get_shared_index_key()
        cache_scope = (
            f"shared:{shared_key}"
            if shared_key
            else f"all@{baseline_revision}" if baseline_revision else "all"
        )
        key = (owner_key, backend, cache_scope)
        entry = self._entries.get(key)
        if shared_key and entry is not None and self._valid_snapshot_entry(entry, backend):
            self._touch(key, entry)
            if diagnostics is not None:
                diagnostics["cache_hit"] = True
                diagnostics["shared_index"] = True
                diagnostics["snapshot_reused"] = True
            return entry.index
        revision = baseline_revision or await self._revision(db, owner_user_id)
        entry = self._entries.get(key)
        if entry is not None and self._valid(entry, revision, backend) and not shared_key:
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
            revision = baseline_revision or await self._revision(db, owner_user_id)
            entry = self._entries.get(key)
            if entry is not None and self._valid(entry, revision, backend) and not shared_key:
                self._touch(key, entry)
                if diagnostics is not None:
                    diagnostics["cache_hit"] = True
                return entry.index
            # 冷启动优先让 TS worker 从持久化索引恢复。只有索引不存在、版本不匹配或
            # revision 变化时才读取完整 DB 文档并重建，避免每次进程重启都拉全量正文。
            if backend == "typescript" and not shared_key:
                restored = await self._build_index(
                    backend, owner_user_id, None, revision, search_settings, diagnostics,
                )
                if restored is not None:
                    if diagnostics is not None:
                        diagnostics["cache_hit"] = True
                        diagnostics["cache_hit_layer"] = "persistent_sidecar"
                    self._store(key, _Entry(
                        restored, 1, revision, backend, time.monotonic(),
                    ))
                    return restored
            documents = await load_index_documents(db, owner_user_id)
            index_documents = list(documents)
            base_entry = entry or self._latest_snapshot_entry(owner_key, backend, key)
            if entry is None and shared_key and base_entry is not None:
                current_sources = {document.source_type for document in documents}
                index_documents = [
                    document for document in getattr(base_entry.index, "documents", ())
                    if document.source_type not in current_sources
                ] + index_documents
            if entry is not None and shared_key:
                previous = {
                    _document_key(document): document
                    for document in getattr(entry.index, "documents", ())
                }
                previous.update({_document_key(document): document for document in documents})
                index_documents = list(previous.values())
                if _documents_match(getattr(entry.index, "documents", ()), index_documents):
                    self._touch(key, entry)
                    if diagnostics is not None:
                        diagnostics["cache_hit"] = True
                        diagnostics["shared_index"] = True
                    return entry.index
            index = await self._build_index(
                backend, owner_user_id, index_documents, revision, search_settings, diagnostics,
                previous_documents=(list(getattr(base_entry.index, "documents", ())) if base_entry is not None else None),
                previous_revision=(base_entry.revision if base_entry is not None else None),
            )
            if diagnostics is not None:
                diagnostics["cache_hit"] = False
                diagnostics["shared_index"] = bool(shared_key)
            size = estimate_index_bytes(index_documents, index)
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
        from agent.rag.context import get_shared_index_key

        fingerprint = _documents_fingerprint(documents)
        shared_key = get_shared_index_key()
        key = (
            owner_key, backend,
            f"shared:{shared_key}" if shared_key else f"transient:{fingerprint}",
        )
        self._purge_expired()
        entry = self._entries.get(key)
        if entry is not None and self._valid(entry, revision, backend) and not shared_key:
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
            if entry is not None and self._valid(entry, revision, backend) and not shared_key:
                self._touch(key, entry)
                if diagnostics is not None:
                    diagnostics["cache_hit"] = True
                return entry.index
            index_documents = list(documents)
            base_entry = entry or self._latest_snapshot_entry(owner_key, backend, key)
            if entry is None and shared_key and base_entry is not None:
                current_sources = {document.source_type for document in documents}
                index_documents = [
                    document for document in getattr(base_entry.index, "documents", ())
                    if document.source_type not in current_sources
                ] + index_documents
            if entry is not None and shared_key:
                previous = {
                    _document_key(document): document
                    for document in getattr(entry.index, "documents", ())
                }
                previous.update({_document_key(document): document for document in documents})
                index_documents = list(previous.values())
                if _documents_match(getattr(entry.index, "documents", ()), index_documents):
                    self._touch(key, entry)
                    if diagnostics is not None:
                        diagnostics["cache_hit"] = True
                        diagnostics["shared_index"] = True
                    return entry.index
            index = await self._build_index(
                backend, owner_user_id, index_documents, revision, settings, diagnostics,
                previous_documents=(list(getattr(base_entry.index, "documents", ())) if base_entry is not None else None),
                previous_revision=(base_entry.revision if base_entry is not None else None),
            )
            if diagnostics is not None:
                diagnostics["cache_hit"] = False
                diagnostics["shared_index"] = bool(shared_key)
            size = estimate_index_bytes(index_documents, index)
            if size <= self.owner_limit_bytes:
                self._store(key, _Entry(index, size, revision, backend, time.monotonic()))
            else:
                self._dispose(_Entry(index, size, revision, backend, time.monotonic()))
            return index

    async def _build_index(self, backend, owner_user_id, documents, revision, settings,
                           diagnostics: dict[str, object] | None = None,
                           previous_documents: list[IndexDocument] | None = None,
                           previous_revision: str | None = None):
        started = time.monotonic()
        if backend == "typescript":
            client = await get_lexical_client(
                owner_user_id,
                command=settings.ts_sidecar_command,
                index_dir=index_dir_for_owner(owner_user_id),
            )
            try:
                reused = await client.reuse_if_current(revision)
                if diagnostics is not None:
                    diagnostics["sidecar_reused"] = bool(reused)
                if documents is None:
                    if reused:
                        if diagnostics is not None:
                            diagnostics["disk_index_reused"] = True
                        return TsLexicalIndex([], client, revision)
                    return None
                if not reused:
                    can_patch = bool(
                        settings.ts_sidecar_index_dir
                        and previous_documents is not None
                        and previous_revision is not None
                        and getattr(client, "_revision", None) == previous_revision
                    )
                    if can_patch:
                        previous = {_worker_document_key(document): document for document in previous_documents}
                        current = {_worker_document_key(document): document for document in documents}
                        upserts = [
                            document for key, document in current.items()
                            if key not in previous or _index_document_digest(previous[key]) != _index_document_digest(document)
                        ]
                        deletes = [
                            _worker_document_key(document) for key, document in previous.items()
                            if key not in current
                        ]
                        await client.patch(upserts, deletes, revision, previous_revision)
                        if diagnostics is not None:
                            diagnostics["index_sync"] = "patch"
                            diagnostics["upsert_count"] = len(upserts)
                            diagnostics["delete_count"] = len(deletes)
                    else:
                        await client.replace(documents, revision)
                        if diagnostics is not None:
                            diagnostics["index_sync"] = "replace"
            except TsSidecarUnavailable:
                await client.close()
                if diagnostics is not None:
                    diagnostics["fallback"] = "typescript_unavailable"
                raise
            else:
                if diagnostics is not None:
                    diagnostics["index_build_ms"] = int((time.monotonic() - started) * 1000)
                return TsLexicalIndex(documents, client, revision)
        raise TsSidecarUnavailable(f"不支持的词法后端: {backend}")

    async def _revision(self, db, owner_user_id: object) -> str | None:
        from agent.rag.protocol import TOKENIZER_VERSION

        rows = (await db.execute(select(
            KnowledgeIndexEntry.source_type,
            func.max(KnowledgeIndexEntry.indexed_at),
        ).where(
            KnowledgeIndexEntry.owner_user_id == owner_user_id,
            KnowledgeIndexEntry.deleted_at.is_(None),
        ).group_by(KnowledgeIndexEntry.source_type))).all()
        if not rows:
            return None
        revisions = ";".join(
            f"{source}:{value.isoformat() if value is not None else ''}"
            for source, value in sorted(rows, key=lambda item: str(item[0]))
        )
        return f"{TOKENIZER_VERSION}:{revisions}"

    def invalidate(self, owner_user_id: object, source_type: str | None = None) -> int:
        owner_key = str(owner_user_id)
        # snapshot-bound index 要保持到对应 session snapshot 结束；业务 mutation
        # 只让后续 snapshot 使用新 baseline，不破坏当前对话的稳定前缀。
        keys = [
            key for key in self._entries
            if key[0] == owner_key and not key[2].startswith("shared:snapshot:")
        ]
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
        self._snapshot_documents.clear()
        self._snapshot_document_locks.clear()

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

    def _valid_snapshot_entry(self, entry: _Entry, backend: str) -> bool:
        return (
            time.monotonic() - entry.last_access <= self.ttl_seconds
            and entry.backend == backend
        )

    def _latest_snapshot_entry(
        self, owner_key: str, backend: str, exclude: tuple[str, str, str],
    ) -> _Entry | None:
        candidates = [
            entry for key, entry in self._entries.items()
            if key != exclude and key[0] == owner_key
            and key[1] == backend and key[2].startswith("shared:snapshot:")
            and self._valid_snapshot_entry(entry, backend)
        ]
        return max(candidates, key=lambda entry: entry.last_access, default=None)

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
        document_expired = [
            key for key, entry in self._snapshot_documents.items()
            if now - entry.last_access > self.ttl_seconds
        ]
        for key in document_expired:
            self._snapshot_documents.pop(key, None)

    async def get_snapshot_documents(
        self,
        owner_user_id: object,
        source_key: str,
        loader: Callable[[], Awaitable[list[IndexDocument]]],
    ) -> list[IndexDocument]:
        """在同一 snapshot 内复用来源文档，避免索引命中前重复读取主数据。"""
        from agent.rag.context import get_shared_index_key

        shared_key = get_shared_index_key()
        if not shared_key:
            return await loader()
        key = (str(owner_user_id), shared_key, source_key)
        self._purge_expired()
        entry = self._snapshot_documents.get(key)
        if entry is not None:
            entry.last_access = time.monotonic()
            return list(entry.documents)
        lock = self._snapshot_document_locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._snapshot_documents.get(key)
            if entry is not None:
                entry.last_access = time.monotonic()
                return list(entry.documents)
            documents = list(await loader())
            self._snapshot_documents[key] = _SnapshotDocuments(
                documents=documents, last_access=time.monotonic(),
            )
            return list(documents)

    @staticmethod
    def _dispose(entry: _Entry) -> None:
        """释放 Python 索引包装；常驻 TS worker 由应用生命周期统一回收。"""
        # lexical client 由应用级 manager 持有，缓存淘汰只释放 Python entry，
        # 保留 worker 内存索引以便后续 revision 变化直接 patch。
        return


_CACHE = KnowledgeIndexCache()


def get_index_cache() -> KnowledgeIndexCache:
    return _CACHE


async def invalidate_index_cache(owner_user_id: object, source_type: str | None = None) -> int:
    return _CACHE.invalidate(owner_user_id, source_type)


async def search_documents_with_cache(
    owner_user_id: object, documents: list[IndexDocument], query: str, *, limit: int = 10,
    source_types=(), scope=None, diagnostics: dict[str, object] | None = None,
) -> list:
    """在统一 owner 缓存中查询 transient 文档。"""
    revision = _documents_fingerprint(documents)
    lookup_started = time.monotonic()
    index = await _CACHE.get_transient(
        owner_user_id, documents, revision=revision, diagnostics=diagnostics,
    )
    if diagnostics is not None:
        diagnostics["index_lookup_ms"] = int((time.monotonic() - lookup_started) * 1000)
    started = time.monotonic()
    results = await index.search(query, limit=limit, source_types=source_types, scope=scope)
    if diagnostics is not None:
        elapsed = int((time.monotonic() - started) * 1000)
        diagnostics["sidecar_search_ms"] = elapsed
        client = getattr(index, "client", None)
        diagnostics["sidecar_queue_wait_ms"] = int(
            getattr(client, "last_search_queue_wait_ms", 0) or 0
        )
        diagnostics["sidecar_query_ms"] = int(
            getattr(client, "last_search_query_ms", 0) or 0
        )
        diagnostics["search_ms"] = elapsed
    return results


def _selected_backend(settings) -> str:
    """生产词法检索固定使用 TypeScript worker。"""
    return "typescript"


def _documents_fingerprint(documents: list[IndexDocument]) -> str:
    import hashlib
    from agent.rag.protocol import TOKENIZER_VERSION

    payload = TOKENIZER_VERSION + "\n" + "\n".join(
        "|".join(map(str, document.identity())) for document in documents
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def _documents_match(left, right) -> bool:
    return {
        _document_key(document): document.identity()
        for document in left
    } == {
        _document_key(document): document.identity()
        for document in right
    }


def _document_key(document: IndexDocument) -> tuple[str, str]:
    """共享索引内的稳定键；来源必须参与，避免跨来源 chunk_id 碰撞。"""
    return document.source_type, document.chunk_id


__all__ = [
    "DEFAULT_SOURCE_TYPES",
    "GLOBAL_CACHE_BYTES",
    "INDEX_CACHE_TTL_SECONDS",
    "KnowledgeIndexCache",
    "PER_OWNER_CACHE_BYTES",
    "estimate_document_bytes",
    "estimate_index_bytes",
    "get_index_cache",
    "invalidate_index_cache",
    "search_documents_with_cache",
]
