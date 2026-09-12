"""进程内 TypeScript lexical 索引缓存与跨 worker revision 检测。"""
from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from collections import OrderedDict
from dataclasses import dataclass

from sqlalchemy import func, select

from agent.rag.models import IndexDocument
from agent.rag.persistent_store import load_index_documents
from agent.rag.models import Scope
from agent.rag.ts_sidecar import (
    TsLexicalIndex,
    TsSidecarUnavailable,
    get_lexical_client,
    index_dir_for_owner,
)
from agent.rag.scope import matches_scope
from app.models import KnowledgeIndexEntry


INDEX_CACHE_TTL_SECONDS = 30 * 60
# 单 owner 索引准入预算。32MB 是语料很小时定的：真实用户索引长到 ~56MB（1.9 万
# 持久文档）后条目永远进不了缓存，每次查询都全量冷装载 5s+，直接打穿搜索超时。
# 提到 128MB；注意 TS 序列化索引住在 worker 进程里，这里的超卖是可控的。
PER_OWNER_CACHE_BYTES = 128 * 1024 * 1024
GLOBAL_CACHE_BYTES = 512 * 1024 * 1024
DEFAULT_SOURCE_TYPES = (
    "memory", "knowledge", "project", "file", "note", "canvas", "calendar", "scheduled_task", "conversation",
)


@asynccontextmanager
async def _observed_lock(lock: asyncio.Lock, phase: str):
    """等待缓存锁时保留独立阶段；没有自动召回观测时等同普通锁。"""
    from agent.rag.observation import await_probe

    await await_probe(phase, lock.acquire())
    try:
        yield
    finally:
        lock.release()


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


@dataclass
class _Entry:
    index: object
    estimated_bytes: int
    revision: str | None
    backend: str
    last_access: float
    persistent_loaded: bool = False


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
        baseline_revision: str | None = None,
        force: bool = False,
    ):
        """返回 owner 级 lexical index，TypeScript/Python 共用缓存生命周期。

        ``force=True`` 跳过全部复用捷径（快照快路径、磁盘恢复、revision 复用）并按
        当前 revision 全量 replace 一次；只给 revision 不一致后的自愈重试用，正常
        查询走缓存与增量 patch。
        """
        from agent.rag.observation import await_probe, probe_update
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
        if (not force and shared_key and entry is not None
                and entry.persistent_loaded and self._valid_snapshot_entry(entry, backend)):
            self._touch(key, entry)
            probe_update(index_cache={"cache_path": "snapshot_fast_hit", "shared_index": True})
            if diagnostics is not None:
                diagnostics["cache_hit"] = True
                diagnostics["shared_index"] = True
                diagnostics["snapshot_reused"] = True
            return entry.index
        revision = baseline_revision
        if revision is None:
            revision = await await_probe(
                "index_revision_read", self._current_revision(
                    db, owner_user_id, backend, search_settings,
                ),
            )
        else:
            probe_update(index_cache={"revision_source": "snapshot_baseline"})
        entry = self._entries.get(key)
        if not force and entry is not None and self._valid(entry, revision, backend) and not shared_key:
            self._touch(key, entry)
            probe_update(index_cache={"cache_path": "revision_cache_hit", "shared_index": False})
            if diagnostics is not None:
                diagnostics["cache_hit"] = True
                diagnostics["cache_miss_reason"] = ""
                diagnostics["document_count"] = _index_document_count(entry.index)
            return entry.index

        if diagnostics is not None:
            diagnostics["cache_miss_reason"] = (
                "empty_or_expired" if entry is None
                else "revision_changed" if entry.revision != revision
                else "backend_changed"
            )
        probe_update(index_cache={
            "cache_path": "cache_miss",
            "cache_entry_present": entry is not None,
            "shared_index": bool(shared_key),
            "forced_resync": force,
            "revision_source": "snapshot_baseline" if baseline_revision is not None else "database",
            "cache_miss_reason": diagnostics.get("cache_miss_reason") if diagnostics else None,
        })

        lock = self._locks.setdefault(key, asyncio.Lock())
        async with _observed_lock(lock, "index_cache_lock_wait"):
            entry = self._entries.get(key)
            if (not force and shared_key and entry is not None
                    and entry.persistent_loaded and self._valid_snapshot_entry(entry, backend)):
                self._touch(key, entry)
                probe_update(index_cache={"cache_path": "snapshot_hit_after_lock", "shared_index": True})
                if diagnostics is not None:
                    diagnostics.update(cache_hit=True, shared_index=True, snapshot_reused=True,
                                       cache_miss_reason="", document_count=_index_document_count(entry.index))
                return entry.index
            revision = baseline_revision
            if revision is None:
                revision = await await_probe(
                    "index_revision_recheck", self._current_revision(
                        db, owner_user_id, backend, search_settings,
                    ),
                )
            if not force and entry is not None and self._valid(entry, revision, backend) and not shared_key:
                self._touch(key, entry)
                probe_update(index_cache={"cache_path": "revision_hit_after_lock", "shared_index": False})
                if diagnostics is not None:
                    diagnostics["cache_hit"] = True
                    diagnostics["cache_miss_reason"] = ""
                    diagnostics["document_count"] = _index_document_count(entry.index)
                return entry.index
            # 冷启动优先让 TS worker 从持久化索引恢复。只有索引不存在、版本不匹配或
            # revision 变化时才读取完整 DB 文档并重建，避免每次进程重启都拉全量正文。
            if backend == "typescript" and not shared_key and not force:
                restored = await await_probe(
                    "index_sidecar_restore",
                    self._build_index(
                        backend, owner_user_id, None, revision, search_settings, diagnostics,
                    ),
                )
                if restored is not None:
                    probe_update(index_cache={
                        "cache_path": "persistent_sidecar_restore",
                        "disk_index_reused": bool(diagnostics and diagnostics.get("disk_index_reused")),
                    })
                    if diagnostics is not None:
                        diagnostics["cache_hit"] = True
                        diagnostics["cache_hit_layer"] = "persistent_sidecar"
                        diagnostics["cache_miss_reason"] = "persistent_sidecar_restore"
                        diagnostics["document_count"] = _index_document_count(restored)
                    self._store(key, _Entry(
                        restored, 1, revision, backend, time.monotonic(),
                    ))
                    return restored
            if backend == "typescript":
                index = await await_probe(
                    "index_ts_database_load",
                    self._build_index(
                        backend, owner_user_id, None, revision, search_settings, diagnostics,
                        allow_database_load=True,
                    ),
                )
                if diagnostics is not None:
                    diagnostics["cache_hit"] = False
                    diagnostics["shared_index"] = bool(shared_key)
                    diagnostics["document_count"] = _index_document_count(index)
                    diagnostics["index_sync"] = "ts_database_load"
                size = estimate_index_bytes([], index)
                if size <= self.owner_limit_bytes:
                    self._store(key, _Entry(
                        index, size, revision, backend, time.monotonic(), persistent_loaded=True,
                    ))
                else:
                    self._entries.pop(key, None)
                    self._dispose(_Entry(index, size, revision, backend, time.monotonic()))
                return index
            documents = await await_probe(
                "index_document_load", load_index_documents(db, owner_user_id),
            )
            probe_update(index_cache={"loaded_document_count": len(documents)})
            index_documents = list(documents)
            # force 是「不信任何缓存状态」的全量重同步：不借旧条目做增量，直接 replace。
            base_entry = None if force else (entry or self._latest_snapshot_entry(owner_key, backend, key))
            if entry is None and shared_key and base_entry is not None:
                current_sources = {document.source_type for document in documents}
                index_documents = [
                    document for document in getattr(base_entry.index, "documents", ())
                    if document.source_type not in current_sources
                ] + index_documents
            if entry is not None and shared_key and not force:
                previous = {
                    _document_key(document): document
                    for document in getattr(entry.index, "documents", ())
                }
                previous.update({_document_key(document): document for document in documents})
                index_documents = list(previous.values())
                if _documents_match(getattr(entry.index, "documents", ()), index_documents):
                    entry.persistent_loaded = True
                    self._touch(key, entry)
                    if diagnostics is not None:
                        diagnostics["cache_hit"] = True
                        diagnostics["shared_index"] = True
                    return entry.index
            probe_update(index_cache={"cache_path": "database_load_and_sync"})
            index = await await_probe(
                "index_worker_sync",
                self._build_index(
                    backend, owner_user_id, index_documents, revision, search_settings, diagnostics,
                    previous_documents=(list(getattr(base_entry.index, "documents", ())) if base_entry is not None else None),
                    previous_revision=(base_entry.revision if base_entry is not None else None),
                ),
            )
            if diagnostics is not None:
                diagnostics["cache_hit"] = False
                diagnostics["shared_index"] = bool(shared_key)
                diagnostics["document_count"] = _index_document_count(index)
            size = estimate_index_bytes(index_documents, index)
            if size <= self.owner_limit_bytes:
                self._store(key, _Entry(index, size, revision, backend, time.monotonic(), persistent_loaded=True))
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
                diagnostics["cache_miss_reason"] = ""
                diagnostics["document_count"] = _index_document_count(entry.index)
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
                    diagnostics["cache_miss_reason"] = ""
                    diagnostics["document_count"] = _index_document_count(entry.index)
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
                diagnostics["document_count"] = _index_document_count(index)
            size = estimate_index_bytes(index_documents, index)
            if size <= self.owner_limit_bytes:
                self._store(key, _Entry(index, size, revision, backend, time.monotonic(),
                                        persistent_loaded=bool(entry and entry.persistent_loaded)))
            else:
                self._dispose(_Entry(index, size, revision, backend, time.monotonic()))
            return index

    async def _build_index(self, backend, owner_user_id, documents, revision, settings,
                           diagnostics: dict[str, object] | None = None,
                           previous_documents: list[IndexDocument] | None = None,
                           previous_revision: str | None = None,
                           allow_database_load: bool = False):
        from agent.rag.observation import await_probe, probe_finish, probe_start, probe_update
        from agent.memory import embedding

        started = time.monotonic()
        if backend == "typescript":
            vector_tag = embedding.model_tag() if embedding.is_enabled() else ""
            client = await await_probe(
                "index_worker_acquire",
                get_lexical_client(
                    owner_user_id,
                    command=settings.ts_sidecar_command,
                    index_dir=index_dir_for_owner(owner_user_id),
                ),
            )
            try:
                reused = await await_probe(
                    "index_worker_restore_check", client.reuse_if_current(revision),
                )
                probe_update(index_build={
                    "document_count": len(documents) if documents is not None else None,
                    "worker_revision_reused": bool(reused),
                })
                if diagnostics is not None:
                    diagnostics["sidecar_reused"] = bool(reused)
                    if client.restore_error:
                        # 磁盘索引损坏或版本不匹配：显式报告，本次必然走全量重建。
                        diagnostics["index_restore_error"] = client.restore_error
                if reused and client._vector_version != vector_tag:
                    vector_result = await await_probe(
                        "index_ts_vector_cache_load",
                        client.load_vectors_from_storage(owner_user_id, vector_tag),
                    )
                    if diagnostics is not None:
                        diagnostics["vector_count"] = int(vector_result.get("vector_count") or 0)
                        diagnostics["vector_version_refreshed"] = True
                if documents is None:
                    if reused:
                        if diagnostics is not None:
                            diagnostics["disk_index_reused"] = True
                        return TsLexicalIndex([], client, revision)
                    if not allow_database_load:
                        return None
                    database_snapshot = await await_probe(
                        "index_ts_document_load",
                        (
                            client.sync_index_from_database(owner_user_id, revision or "", vector_tag)
                            if getattr(settings, "ts_index_sync_mode", "incremental") == "incremental"
                            else client.load_index_from_database(owner_user_id, revision or "", vector_tag)
                        ),
                    )
                    worker_probe = database_snapshot.get("probe")
                    if isinstance(worker_probe, dict):
                        raw_stage_ms = worker_probe.get("stage_ms")
                        raw_counts = worker_probe.get("counts")
                        stage_names = {
                            "data_runtime_database_query",
                            "data_runtime_revision_projection",
                            "data_runtime_document_projection",
                            "data_runtime_load_rag_index_total",
                            "index_install_build",
                            "vector_cache_load",
                            "vector_storage_read",
                            "vector_parse_and_match",
                            "persist_directory_prepare",
                            "persist_serialize",
                            "persist_write_and_rename",
                            "persist_total",
                            "load_index_from_database_total",
                        }
                        count_names = {
                            "database_rows", "documents", "posting_terms",
                            "vector_files_present", "vector_entries_loaded", "vector_count",
                            "index_persisted", "serialized_bytes",
                            "applied_upserts", "applied_deletes", "scanned_rows",
                            "passes", "fallback_full",
                        }
                        probe_update(index_ts_database_load={
                            "stage_ms": {
                                name: int(value)
                                for name, value in raw_stage_ms.items()
                                if name in stage_names and isinstance(value, (int, float))
                                and not isinstance(value, bool)
                            } if isinstance(raw_stage_ms, dict) else {},
                            "counts": {
                                name: int(value)
                                for name, value in raw_counts.items()
                                if name in count_names and isinstance(value, (int, float))
                                and not isinstance(value, bool)
                            } if isinstance(raw_counts, dict) else {},
                        })
                    if diagnostics is not None:
                        used_sync = getattr(settings, "ts_index_sync_mode", "incremental") == "incremental"
                        worker_fell_back = bool((database_snapshot.get("probe") or {}).get("counts", {}).get("fallback_full")) \
                            if isinstance(database_snapshot.get("probe"), dict) else False
                        diagnostics["index_sync"] = (
                            "ts_incremental_sync" if used_sync and not worker_fell_back else "database_load"
                        )
                        if worker_fell_back:
                            diagnostics["index_sync_fallback_full"] = True
                        diagnostics["document_count"] = int(database_snapshot.get("document_count") or 0)
                        diagnostics["vector_count"] = int(database_snapshot.get("vector_count") or 0)
                        diagnostics["sync_applied_upserts"] = int(database_snapshot.get("applied_upserts") or 0)
                        diagnostics["sync_applied_deletes"] = int(database_snapshot.get("applied_deletes") or 0)
                    probe_update(index_build={
                        "document_count": int(database_snapshot.get("document_count") or 0),
                        "vector_count": int(database_snapshot.get("vector_count") or 0),
                        "index_source": "database",
                    })
                    return TsLexicalIndex([], client, revision)
                if not reused:
                    can_patch = bool(
                        settings.ts_sidecar_index_dir
                        and previous_documents is not None
                        and previous_revision is not None
                        and getattr(client, "_revision", None) == previous_revision
                    )
                    if can_patch:
                        from agent.rag.delta import compute_chunk_delta

                        delta_started = time.monotonic()
                        probe_start("index_delta_compute")
                        delta = compute_chunk_delta(previous_documents, documents)
                        upserts = list(delta.upserts)
                        deletes = list(delta.deletes)
                        probe_finish(
                            "index_delta_compute", delta_started,
                            upsert_count=len(upserts), delete_count=len(deletes),
                        )
                        vector_result = await await_probe(
                            "index_worker_patch",
                            client.patch(
                                upserts, deletes, revision, previous_revision,
                                storage_owner_id=owner_user_id,
                                vector_version=vector_tag,
                            ),
                        )
                        if diagnostics is not None:
                            diagnostics["index_sync"] = "patch"
                            diagnostics["upsert_count"] = len(upserts)
                            diagnostics["delete_count"] = len(deletes)
                    else:
                        vector_result = await await_probe(
                            "index_worker_replace",
                            client.replace(
                                documents, revision,
                                storage_owner_id=owner_user_id,
                                vector_version=vector_tag,
                            ),
                        )
                        if diagnostics is not None:
                            diagnostics["index_sync"] = "replace"
                    if diagnostics is not None:
                        diagnostics["vector_count"] = int(vector_result.get("vector_count") or 0)
            except TsSidecarUnavailable as error:
                probe_update(index_build={
                    "outcome": "error",
                    "error_type": type(error).__name__,
                    "error_code": (
                        "revision_mismatch" if error.code == "revision_mismatch"
                        else "other" if error.code else "missing"
                    ),
                })
                await client.close()
                if diagnostics is not None:
                    diagnostics["fallback"] = "typescript_unavailable"
                raise
            else:
                if diagnostics is not None:
                    diagnostics["index_build_ms"] = int((time.monotonic() - started) * 1000)
                return TsLexicalIndex(documents, client, revision)
        raise TsSidecarUnavailable(f"不支持的词法后端: {backend}")

    async def _current_revision(self, db, owner_user_id: object, backend, settings) -> str | None:
        if backend != "typescript":
            return await self._revision(db, owner_user_id)
        client = await get_lexical_client(
            owner_user_id,
            command=settings.ts_sidecar_command,
            index_dir=index_dir_for_owner(owner_user_id),
        )
        return await client.database_revision(owner_user_id)

    async def _revision(self, db, owner_user_id: object) -> str | None:
        from agent.rag.protocol import RAG_PROJECTION_VERSION, TOKENIZER_VERSION

        # max(indexed_at) 必须含墓碑行（软删行）：这是 worker 增量同步的单游标水位。
        # 纯删除时墓碑自身的时间戳推进 revision，删除才能被 worker 看见。
        rows = (await db.execute(select(
            KnowledgeIndexEntry.source_type,
            func.max(KnowledgeIndexEntry.indexed_at),
        ).where(
            KnowledgeIndexEntry.owner_user_id == owner_user_id,
        ).group_by(KnowledgeIndexEntry.source_type))).all()
        if not rows:
            return None
        revisions = ";".join(
            f"{source}:{value.isoformat() if value is not None else ''}"
            for source, value in sorted(rows, key=lambda item: str(item[0]))
        )
        return f"{TOKENIZER_VERSION}:{RAG_PROJECTION_VERSION}:{revisions}"

    def invalidate(
        self, owner_user_id: object, source_type: str | None = None, *,
        include_snapshot: bool = False,
    ) -> int:
        owner_key = str(owner_user_id)
        # snapshot-bound index 要保持到对应 session snapshot 结束；业务 mutation
        # 只让后续 snapshot 使用新 baseline，不破坏当前对话的稳定前缀。
        # include_snapshot 只给 revision 不一致的自愈重试用：快照条目正是可能冻结了
        # 旧 revision 的那一类，不清掉就永远走快路径继续被 worker 拒绝。
        keys = [
            key for key in self._entries
            if key[0] == owner_key
            and (include_snapshot or not key[2].startswith("shared:snapshot:"))
        ]
        for key in keys:
            entry = self._entries.pop(key, None)
            if entry is not None:
                self._dispose(entry)
        return len(keys)

    async def resync(
        self, db, owner_user_id: object, source_type: str, scope: Scope | None = None, *,
        diagnostics: dict[str, object] | None = None,
        baseline_revision: str | None = None,
    ):
        """作废 owner 全部缓存条目并按当前 revision 全量重同步，返回新的索引。

        worker 的 ``state.revision`` 是 per-owner 单槽，被另一个 revision 命名空间
        （快照版 vs DB 投影版）推着走过以后，缓存里冻结了旧 revision 的索引对象会被
        worker 以 ``revision_mismatch`` 拒绝。只有重新装载文档并 replace 才能让 worker
        状态对齐本轮 revision，所以这里必然全量重同步一次。
        """
        from agent.rag.observation import await_probe, probe_finish, probe_start, probe_update

        started = time.monotonic()
        probe_start("revision_cache_invalidate")
        invalidated_entries = self.invalidate(owner_user_id, include_snapshot=True)
        probe_finish(
            "revision_cache_invalidate", started,
            invalidated_entry_count=invalidated_entries,
        )
        probe_update(revision_resync={"invalidated_entry_count": invalidated_entries})
        return await await_probe(
            "revision_resync_forced_index_get",
            self.get(
                db, owner_user_id, source_type, scope,
                diagnostics=diagnostics, baseline_revision=baseline_revision, force=True,
            ),
        )

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
    if hasattr(index, "search_with_timing"):
        results, timing = await index.search_with_timing(
            query, limit=limit, source_types=source_types, scope=scope,
        )
    else:
        results = await index.search(query, limit=limit, source_types=source_types, scope=scope)
        timing = None
    if diagnostics is not None:
        elapsed = int((time.monotonic() - started) * 1000)
        diagnostics["sidecar_search_ms"] = elapsed
        diagnostics["sidecar_queue_wait_ms"] = int(getattr(timing, "queue_wait_ms", 0) or 0)
        diagnostics["sidecar_query_ms"] = int(getattr(timing, "query_ms", 0) or 0)
        diagnostics["search_ms"] = elapsed
    return results


def _selected_backend(settings) -> str:
    """生产词法检索固定使用 TypeScript worker。"""
    return "typescript"


def _documents_fingerprint(documents: list[IndexDocument]) -> str:
    import hashlib
    from agent.rag.protocol import RAG_PROJECTION_VERSION, TOKENIZER_VERSION

    payload = f"{TOKENIZER_VERSION}:{RAG_PROJECTION_VERSION}\n" + "\n".join(
        "|".join(map(str, document.identity())) for document in documents
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def _index_document_count(index) -> int:
    """返回当前索引可诊断的文档数；磁盘恢复索引由 sidecar 提供数量。"""
    return int(getattr(index, "document_count", len(getattr(index, "documents", ()) or ())) or 0)


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
