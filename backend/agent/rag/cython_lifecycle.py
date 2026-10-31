"""Cython RAG 数据库快照、增量同步与索引生命周期适配层。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import tempfile
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from agent.rag.cython_backend import CythonLexicalIndex, CythonRagEngine
from agent.rag.adapters.memory import MemoryAdapter
from agent.rag.persistent_store import (
    RAG_DELTA_PAGE_SIZE,
    RagIndexCursor,
    load_rag_index_delta,
    load_rag_index_revision,
    load_rag_index_snapshot,
)


DELTA_MAX_PASSES = 50
WATERMARK_HORIZON = timedelta(days=31)
CYTHON_SNAPSHOT_VERSION = "cython-rag-index-v3"
SNAPSHOT_PERSIST_DEBOUNCE_SECONDS = 1.5
VECTOR_FILE_MAX_CHARS = 50_000_000
VECTOR_FILE_CACHE_SIZE = 8
_vector_file_cache: OrderedDict[tuple[str, str], tuple[str, dict[str, tuple[float, ...]]]] = OrderedDict()


class _CythonMemoryAdapter(MemoryAdapter):
    """仅 Cython lifecycle 使用本地投影，沿用 MemoryAdapter 的授权与缓存。"""

    async def build_documents(self, *, scope):
        from agent.rag.cython_projection import project_source_records

        records = await self.build_source_records(scope=scope)
        return project_source_records(self.user_id, self.source_type, records)

    async def build_daily_documents(self, *, scope):
        from agent.rag.cython_projection import project_source_records

        records = await self._build_daily_source_records(scope=scope)
        return project_source_records(self.user_id, self.source_type, records)


@dataclass(frozen=True)
class _SnapshotState:
    owner_id: str
    revision: str
    watermark: RagIndexCursor | None
    documents: tuple
    lexical_index: CythonLexicalIndex
    vectors: dict[str, list[float]]
    vector_version: str


def _write_snapshot_state(index_dir: str | Path, state: _SnapshotState) -> dict[str, Any]:
    """从稳定的 engine 状态异步序列化并原子替换完整快照。"""
    from agent.rag import cython_native

    payload = cython_native.snapshot_payload(
        CYTHON_SNAPSHOT_VERSION, state.owner_id, state.revision, state.watermark,
        state.documents, state.lexical_index, state.vectors, state.vector_version,
    )
    payload["database_projection"] = state.lexical_index.database_projection
    directory = Path(index_dir)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = directory / "index.json"
    descriptor, temporary_name = tempfile.mkstemp(prefix=".index-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            cython_native.dump_snapshot(stream, payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, target)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
    return {
        "status": "saved", "document_count": len(payload["documents"]),
        "vector_count": len(payload["vectors"]), "revision": state.revision,
    }


def _serialized_mutation(method):
    """让同一 lifecycle 的异步快照/增量/向量安装串行提交。"""
    async def wrapped(self, *args, **kwargs):
        async with self._mutation_lock:
            return await method(self, *args, **kwargs)
    wrapped.__name__ = method.__name__
    wrapped.__doc__ = method.__doc__
    return wrapped


class CythonRagLifecycle:
    """把 owner-bound DB 快照/增量同步安装到独立 Cython engine。

    owner 授权由调用方完成；数据库查询自身仍以 owner_user_id 硬过滤。
    此对象只读主索引与向量缓存，不执行来源写入、embedding 写入或业务变更。
    """

    def __init__(self, engine: CythonRagEngine | None = None) -> None:
        self.engine = engine or CythonRagEngine()
        self.watermark: RagIndexCursor | None = None
        self._mutation_lock = asyncio.Lock()
        self._pending_snapshot: tuple[Path, str] | None = None
        self._snapshot_persist_task: asyncio.Task | None = None
        self._snapshot_persist_wakeup = asyncio.Event()
        self._snapshot_write_lock = asyncio.Lock()
        self._snapshot_persist_generation = 0
        self._snapshot_flush_requested = False
        self._snapshot_persist_error: Exception | None = None

    @property
    def client(self):
        """与 TS lexical handle 兼容的 owner 身份视图。"""
        return self

    @property
    def owner_user_id(self) -> str:
        return str(getattr(self, "_owner_user_id", ""))

    @property
    def revision(self) -> str:
        return self.engine.revision

    @property
    def document_count(self) -> int:
        return len(self.engine._persistent.documents)

    @property
    def estimated_bytes(self) -> int:
        from agent.rag.index_cache import estimate_document_bytes

        return estimate_document_bytes(list(self.engine._persistent.documents))

    @property
    def documents_by_id(self) -> dict[str, Any]:
        documents = dict(zip(
            self.engine._persistent.document_keys, self.engine._persistent.documents,
        ))
        for key, document in zip(
            self.engine._transient.document_keys, self.engine._transient.documents,
        ):
            documents.setdefault(key, document)
        return documents

    async def unified_query(self, query: str, **options) -> dict[str, Any]:
        """在生命周期锁内执行单次 Cython 查询；不并跑 TS 或做 shadow 对照。"""
        async with self._mutation_lock:
            options.setdefault("revision", self.engine.revision)
            if any(item.get("corpus") == "transient" for item in options.get("searches") or ()):
                options.setdefault("transient_revision", self.engine.transient_revision)
            options["vector_version"] = str(options.get("vector_version") or "")
            if options.get("query_embedding"):
                return await self.engine.unified_query_with_embedding(query, **options)
            options.pop("query_embedding", None)
            return await asyncio.to_thread(self.engine.unified_query, query, **options)

    def _capture_snapshot_state(self, owner_user_id: object) -> _SnapshotState:
        lexical_index = self.engine._persistent
        return _SnapshotState(
            owner_id=str(owner_user_id),
            revision=self.engine.revision,
            watermark=self.watermark,
            documents=lexical_index.documents,
            lexical_index=lexical_index,
            # set_vectors 以整张新映射替换状态，向量列表不会原地修改；浅拷贝冻结映射即可。
            vectors=dict(self.engine._vectors),
            vector_version=self.engine.vector_version,
        )

    def persist_snapshot(self, index_dir: str | Path, owner_user_id: object) -> dict[str, Any]:
        """原子保存 owner-bound 的可重建索引快照；调用方必须提供隔离目录。"""
        return _write_snapshot_state(index_dir, self._capture_snapshot_state(owner_user_id))

    async def _persist_snapshot_now(self, index_dir: str | Path, owner_user_id: object) -> dict[str, Any]:
        """立即保存冷建/向量刷新快照，并使排队中的旧 revision 写入失效。"""
        self._snapshot_persist_generation += 1
        self._pending_snapshot = None
        self._snapshot_persist_wakeup.set()
        self._snapshot_flush_requested = False
        generation = self._snapshot_persist_generation
        snapshot_state = self._capture_snapshot_state(owner_user_id)
        return await self._write_snapshot_serialized(index_dir, snapshot_state, generation)

    async def _write_snapshot_serialized(
        self, index_dir: str | Path, snapshot_state: _SnapshotState, generation: int,
    ) -> dict[str, Any]:
        async with self._snapshot_write_lock:
            if generation != self._snapshot_persist_generation:
                return {"status": "superseded", "revision": snapshot_state.revision}
            write_task = asyncio.create_task(asyncio.to_thread(
                _write_snapshot_state, index_dir, snapshot_state,
            ))
            try:
                return await asyncio.shield(write_task)
            except asyncio.CancelledError:
                # to_thread 不能中止底层写盘；等待它完成，防止解锁后旧写入覆盖新快照。
                await write_task
                raise

    def _schedule_snapshot_persist(self, index_dir: str | Path, owner_user_id: object) -> None:
        """延迟并合并增量快照写入；worker 崩溃时旧快照仍可按水位追平。"""
        self._pending_snapshot = (Path(index_dir), str(owner_user_id))
        self._snapshot_persist_generation += 1
        self._snapshot_persist_error = None
        if self._snapshot_persist_task is None or self._snapshot_persist_task.done():
            self._snapshot_persist_task = asyncio.create_task(self._persist_pending_snapshots())
        self._snapshot_persist_wakeup.set()

    async def _persist_pending_snapshots(self) -> None:
        active_pending: tuple[Path, str] | None = None
        try:
            while self._pending_snapshot is not None:
                generation = self._snapshot_persist_generation
                if self._snapshot_flush_requested:
                    self._snapshot_flush_requested = False
                else:
                    self._snapshot_persist_wakeup.clear()
                    try:
                        await asyncio.wait_for(
                            self._snapshot_persist_wakeup.wait(),
                            timeout=SNAPSHOT_PERSIST_DEBOUNCE_SECONDS,
                        )
                        continue
                    except TimeoutError:
                        if generation != self._snapshot_persist_generation:
                            continue

                async with self._mutation_lock:
                    pending = self._pending_snapshot
                    if pending is None:
                        continue
                    self._pending_snapshot = None
                    index_dir, owner_user_id = pending
                    active_pending = pending
                    # 等 mutation lock 期间可能已有更新把 pending 替换成更新的快照目标。
                    # 使用实际捕获状态时的 generation，避免把最新快照误判为过期并丢弃。
                    generation = self._snapshot_persist_generation
                    snapshot_state = self._capture_snapshot_state(owner_user_id)
                try:
                    saved = await self._write_snapshot_serialized(
                        index_dir, snapshot_state, generation,
                    )
                    active_pending = None
                    if saved["status"] == "superseded":
                        continue
                except asyncio.CancelledError:
                    if active_pending is not None and self._pending_snapshot is None:
                        self._pending_snapshot = active_pending
                    raise
                except Exception as exc:
                    # 保留最新待写目标，供显式 flush 或后续变更重试；数据库仍是事实源。
                    if self._pending_snapshot is None:
                        self._pending_snapshot = pending
                    self._snapshot_persist_error = exc
                    return
        finally:
            self._snapshot_persist_task = None

    async def flush_snapshot_persistence(self) -> None:
        """显式等待并写完当前最新快照，供受控关闭与测试使用。"""
        if self._snapshot_persist_error is not None:
            error = self._snapshot_persist_error
            self._snapshot_persist_error = None
            if self._pending_snapshot is None:
                raise error
        if self._pending_snapshot is not None and self._snapshot_persist_task is None:
            self._snapshot_persist_task = asyncio.create_task(self._persist_pending_snapshots())
        if self._pending_snapshot is not None:
            self._snapshot_flush_requested = True
            self._snapshot_persist_wakeup.set()
        task = self._snapshot_persist_task
        if task is not None:
            await task
        if self._snapshot_persist_error is not None:
            error = self._snapshot_persist_error
            self._snapshot_persist_error = None
            raise error

    def restore_snapshot(
        self,
        index_dir: str | Path,
        owner_user_id: object,
        *,
        expected_revision: str | None = None,
    ) -> dict[str, Any]:
        """验证 owner/版本/revision 后恢复快照；失败不改动当前 engine。"""
        from agent.rag.storage import _document_from_record

        target = Path(index_dir) / "index.json"
        try:
            payload = json.loads(target.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"status": "missing"}
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return {"status": "corrupt"}
        if not isinstance(payload, dict):
            return {"status": "corrupt"}
        if payload.get("version") != CYTHON_SNAPSHOT_VERSION:
            return {"status": "version_mismatch"}
        if str(payload.get("owner_id") or "").lower() != str(owner_user_id).lower():
            return {"status": "owner_mismatch"}
        if not isinstance(payload.get("database_projection"), bool):
            return {"status": "corrupt"}
        revision = str(payload.get("revision") or "")
        if expected_revision is not None and revision != str(expected_revision):
            return {"status": "revision_mismatch", "revision": revision}
        raw_documents = payload.get("documents")
        raw_tokens = payload.get("tokens")
        if not isinstance(raw_documents, list) or not isinstance(raw_tokens, list):
            return {"status": "corrupt"}
        documents = [_document_from_record(item) for item in raw_documents if isinstance(item, dict)]
        if len(documents) != len(raw_documents) or any(
            document is None or document.scope.owner_user_id.lower() != str(owner_user_id).lower()
            for document in documents
        ):
            return {"status": "owner_mismatch"}
        if len(raw_tokens) != len(documents) or any(
            not isinstance(terms, list) or any(not isinstance(term, str) for term in terms)
            for terms in raw_tokens
        ):
            return {"status": "corrupt"}
        vector_version = str(payload.get("vector_version") or "")
        raw_vectors = payload.get("vectors")
        if not isinstance(raw_vectors, dict):
            return {"status": "corrupt"}
        valid_slots = {key for document in documents if document is not None
                       for key in (_worker_document_slot(document),)}
        vectors = {
            str(key): [float(value) for value in vector]
            for key, vector in raw_vectors.items()
            if str(key) in valid_slots and isinstance(vector, list) and all(
                isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
                for value in vector
            )
        }
        raw_watermark = payload.get("watermark")
        watermark = None
        if raw_watermark is not None:
            if not isinstance(raw_watermark, dict) or not isinstance(raw_watermark.get("ts"), str):
                return {"status": "corrupt"}
            try:
                timestamp = datetime.fromisoformat(raw_watermark["ts"].replace("Z", "+00:00"))
                row_id = int(raw_watermark.get("id", 0))
            except (TypeError, ValueError):
                return {"status": "corrupt"}
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            watermark = RagIndexCursor(timestamp, row_id)
        installed = [document for document in documents if document is not None]
        self.engine.replace(
            installed, revision, vectors=vectors, vector_version=vector_version,
            tokenized_documents=raw_tokens, database_projection=payload["database_projection"],
        )
        self.watermark = watermark
        return {"status": "restored", "revision": revision,
                "document_count": len(installed), "vector_count": self.engine.vector_count,
                "vector_version": self.engine.vector_version, "watermark": self.watermark}

    @_serialized_mutation
    async def sync_index_from_database(
        self,
        db,
        owner_user_id: object,
        revision: str,
        *,
        vector_version: str = "",
        page_size: int = RAG_DELTA_PAGE_SIZE,
        max_passes: int = DELTA_MAX_PASSES,
        now: datetime | None = None,
        snapshot_dir: str | Path | None = None,
    ) -> dict[str, Any]:
        """按 `(indexed_at,id)` 增量安装；水位过期或超预算时完整重载。"""
        return await self._sync_index_from_database_unlocked(
            db, owner_user_id, revision, vector_version=vector_version,
            page_size=page_size, max_passes=max_passes, now=now,
            snapshot_dir=snapshot_dir,
        )

    async def _sync_index_from_database_unlocked(
        self,
        db,
        owner_user_id: object,
        revision: str,
        *,
        vector_version: str = "",
        page_size: int = RAG_DELTA_PAGE_SIZE,
        max_passes: int = DELTA_MAX_PASSES,
        now: datetime | None = None,
        snapshot_dir: str | Path | None = None,
    ) -> dict[str, Any]:
        """由已持有 mutation lock 的入口复用增量追平路径。"""
        target_revision = str(revision or "")
        if not target_revision:
            raise ValueError("sync_index_from_database 需要 revision")
        clock = now or datetime.now(timezone.utc)
        watermark_usable = self.watermark is not None and self.watermark.timestamp >= clock - WATERMARK_HORIZON
        if not watermark_usable:
            result = await self._load_index_from_database_unlocked(
                db, owner_user_id, revision=target_revision, vector_version=vector_version,
            )
            if snapshot_dir is not None:
                await self._persist_snapshot_now(snapshot_dir, owner_user_id)
            return {**result, "fallback_full": 1, "applied_upserts": 0, "applied_deletes": 0,
                    "scanned_rows": 0, "passes": 0}

        cursor = self.watermark
        upserts = []
        deletes: list[str] = []
        scanned_rows = 0
        passes = 0
        overflow = False
        while True:
            delta = await load_rag_index_delta(
                db, owner_user_id, cursor, limit=page_size,
                cython_transform=True,
            )
            scanned_rows += delta.scanned_rows
            upserts.extend(delta.upserts)
            deletes.extend(delta.deletes)
            if delta.cursor is None or not delta.has_more:
                cursor = delta.cursor or cursor
                break
            cursor = delta.cursor
            passes += 1
            if passes >= max_passes:
                overflow = True
                break

        if overflow:
            result = await self._load_index_from_database_unlocked(
                db, owner_user_id, revision=target_revision, vector_version=vector_version,
            )
            if snapshot_dir is not None:
                await self._persist_snapshot_now(snapshot_dir, owner_user_id)
            return {**result, "fallback_full": 1, "applied_upserts": 0, "applied_deletes": 0,
                    "scanned_rows": scanned_rows, "passes": passes}

        vector_version_changed = self.engine.vector_version != vector_version
        self.engine.patch(
            upserts, deletes, revision=target_revision,
            base_revision=self.engine.revision,
        )
        self.watermark = cursor
        if vector_version_changed or upserts or deletes:
            documents = self.engine._persistent.documents
            vectors = await self._read_vectors(owner_user_id, documents, vector_version)
            self.engine.set_vectors(_worker_vector_map(documents, vectors), vector_version)
        if snapshot_dir is not None and (vector_version_changed or upserts or deletes):
            self._schedule_snapshot_persist(snapshot_dir, owner_user_id)
        return {
            "status": "ok", "revision": self.engine.revision,
            "document_count": len(self.engine._persistent.documents),
            "vector_count": self.engine.vector_count,
            "vector_version": self.engine.vector_version,
            "watermark": self.watermark,
            "fallback_full": 0, "applied_upserts": len(upserts),
            "applied_deletes": len(deletes), "scanned_rows": scanned_rows,
            "passes": passes,
        }

    async def _load_index_from_database_unlocked(
        self, db, owner_user_id: object, *, revision: str | None = None,
        vector_version: str = "",
    ) -> dict[str, Any]:
        """由已持有 mutation lock 的 sync 路径调用完整快照安装。"""
        snapshot = await load_rag_index_snapshot(
            db, owner_user_id, cython_transform=True,
        )
        installed_revision = str(revision if revision is not None else snapshot.revision or "")
        vectors = await self._read_vectors(owner_user_id, snapshot.documents, vector_version)
        self.engine.replace(
            snapshot.documents, installed_revision,
            vectors=_worker_vector_map(snapshot.documents, vectors), vector_version=vector_version,
            database_projection=True,
        )
        self.watermark = snapshot.watermark
        return {
            "status": "ok", "revision": self.engine.revision,
            "document_count": len(snapshot.documents), "vector_count": self.engine.vector_count,
            "vector_version": self.engine.vector_version,
            "watermark": self.watermark,
        }

    @_serialized_mutation
    async def load_index_from_database(
        self, db, owner_user_id: object, *, revision: str | None = None,
        vector_version: str = "",
    ) -> dict[str, Any]:
        """从同一 DB 查询快照安装文档并加载当前模型版本的已缓存向量。"""
        return await self._load_index_from_database_unlocked(
            db, owner_user_id, revision=revision, vector_version=vector_version,
        )

    @_serialized_mutation
    async def load_index_from_snapshot_or_database(
        self, db, owner_user_id: object, index_dir: str | Path, *,
        vector_version: str = "", revision: str | None = None,
    ) -> dict[str, Any]:
        """以 owner revision 校验快照，安全时增量追平，其他情况完整重建。"""
        self._owner_user_id = str(owner_user_id)
        current_revision = str(revision) if revision is not None else (
            await load_rag_index_revision(db, owner_user_id)
        )
        restored: dict[str, Any] = {"status": "missing"}
        if current_revision:
            restored = self.restore_snapshot(
                index_dir, owner_user_id, expected_revision=current_revision,
            )
            if restored.get("status") == "restored":
                vectors_refreshed = self.engine.vector_version != str(vector_version or "")
                if vectors_refreshed:
                    # 先清除快照中旧模型版本的向量；即使 StorageReader 抛错，
                    # 后续也只能走 lexical fallback，不能误用旧向量。
                    self.engine.set_vectors({}, vector_version)
                    vectors = await self._read_vectors(
                        owner_user_id, self.engine._persistent.documents, vector_version,
                    )
                    self.engine.set_vectors(
                        _worker_vector_map(self.engine._persistent.documents, vectors), vector_version,
                    )
                    await self._persist_snapshot_now(index_dir, owner_user_id)
                return {
                    "status": "ok", "revision": self.engine.revision,
                    "document_count": len(self.engine._persistent.documents),
                    "vector_count": self.engine.vector_count,
                    "vector_version": self.engine.vector_version,
                    "watermark": self.watermark,
                    "snapshot_hit": True, "snapshot_status": "restored",
                    "vectors_refreshed": vectors_refreshed,
                }

            if restored.get("status") == "revision_mismatch":
                stale_snapshot = self.restore_snapshot(index_dir, owner_user_id)
                previous_revision = str(stale_snapshot.get("revision") or "")
                revision_prefix = lambda value: ":".join(value.split(":", 2)[:2])
                watermark = stale_snapshot.get("watermark")
                version_compatible = (
                    stale_snapshot.get("status") == "restored"
                    and previous_revision
                    and revision_prefix(previous_revision) == revision_prefix(current_revision)
                    and watermark is not None
                )
                if version_compatible:
                    synced = await self._sync_index_from_database_unlocked(
                        db, owner_user_id, current_revision, vector_version=vector_version,
                    )
                    if not synced.get("fallback_full"):
                        self._schedule_snapshot_persist(index_dir, owner_user_id)
                        return {
                            **synced, "snapshot_hit": True,
                            "snapshot_status": "incremental_refresh",
                            "snapshot_save_scheduled": True,
                        }

        loaded = await self._load_index_from_database_unlocked(
            db, owner_user_id, revision=current_revision, vector_version=vector_version,
        )
        saved = await self._persist_snapshot_now(index_dir, owner_user_id)
        return {
            **loaded, "snapshot_hit": False,
            "snapshot_status": restored.get("status") if current_revision else "empty_revision",
            "snapshot_saved": saved.get("status") == "saved",
        }

    @_serialized_mutation
    async def load_vectors_from_storage(
        self, owner_user_id: object, vector_version: str,
    ) -> dict[str, Any]:
        """只按当前索引文档键装载缓存向量，不生成或写入向量。"""
        version = str(vector_version or "")
        vectors = await self._read_vectors(owner_user_id, self.engine._persistent.documents, version)
        self.engine.set_vectors(_worker_vector_map(self.engine._persistent.documents, vectors), version)
        return {"status": "ok", "vector_count": self.engine.vector_count, "vector_version": version}

    @_serialized_mutation
    async def prepare_memory(
        self,
        owner_user_id: object,
        scopes,
        *,
        source_filter: str = "all",
        snapshot_revision: str = "",
        snapshot_text: str = "",
        vector_version: str = "",
    ) -> dict[str, Any]:
        """复用 Python Memory adapter 准备 owner/group/member transient 语料。"""
        from agent.rag.context import _snapshot_revision
        from agent.rag.delta import chunk_slot_key

        owner = str(owner_user_id)
        authorized_scopes = _validate_memory_scopes(owner, scopes)
        adapter = _CythonMemoryAdapter(owner_user_id)
        token = _snapshot_revision.set(str(snapshot_revision or ""))
        source_names: list[str] = []
        documents = []

        async def load_scope(scope):
            if scope.scope_type == "owner":
                return await adapter.build_cached_owner_documents(scope=scope)
            return await adapter.build_cached_documents(scope=scope)

        try:
            # 不同 scope 的 revision/Storage 读取相互独立；有限并发隐藏 I/O 等待，
            # 同时避免大量群/成员 scope 将数据库连接瞬时打满。gather 保持输入顺序。
            semaphore = asyncio.Semaphore(4)

            async def load_scope_bounded(scope):
                async with semaphore:
                    return await load_scope(scope)

            loaded_scopes = await asyncio.gather(*(
                load_scope_bounded(scope) for scope in authorized_scopes
            ))
            for loaded, source in loaded_scopes:
                documents.extend(loaded)
                source_names.append(source)
        finally:
            _snapshot_revision.reset(token)

        allowed = {"profile", "pattern", "daily", "memory"} if source_filter == "all" else {str(source_filter)}
        from dataclasses import replace
        filtered = [
            replace(document, scope=replace(document.scope, scope_id=""))
            if document.source_type == "memory" and document.source_id == "daily"
            and document.scope.scope_type == "owner" else document
            for document in documents if document.source_id in allowed
        ]
        authorized = [document for document in filtered if any(
            _memory_scope_allows(scope, document.scope) for scope in authorized_scopes
        )]
        snapshot_context = _normalized_snapshot_context(snapshot_text)
        snapshot_filtered = [
            document for document in authorized
            if not _snapshot_covers_context(document.content, snapshot_context)
        ]
        vectors = await self._read_vectors(owner_user_id, snapshot_filtered, vector_version)
        # transient revision 仅用于本地缓存失效，不是跨运行时协议；直接分帧
        # 摘要完整字段，避免构造整批 RagDocument wire 字典和大 JSON 字符串。
        from agent.rag import cython_native

        transient_revision = cython_native.memory_revision(
            snapshot_filtered, str(vector_version or ""),
        )
        # Python 缓存读取器以 parent:version:chunk 返回，worker state 与 unified
        # query 则以稳定 chunk slot（parent:chunk）索引 vectors；在此转换键空间。
        # _read_vectors 的 Cython JSON 校验器已逐元素验证有限数值；不要在映射
        # chunk-slot 时再次扫描每个高维向量。
        vector_map = _worker_vector_map(snapshot_filtered, vectors, values_validated=True)
        self.engine.replace_transient(
            snapshot_filtered, transient_revision,
            vectors=vector_map, vector_version=vector_version,
            revision_is_content_addressed=True,
        )
        return {
            "status": "ok", "transient_revision": transient_revision,
            "document_count": len(snapshot_filtered), "vector_count": len(vector_map),
            "vector_version": self.engine.transient_vector_version,
            "memory_source": ",".join(source_names) or "empty",
            "probe": {
                "counts": {
                    "scope_count": len(authorized_scopes),
                    "base_documents": len(documents),
                    "source_allowed_documents": len(filtered),
                    "scope_authorized_documents": len(authorized),
                    "snapshot_excluded_documents": len(authorized) - len(snapshot_filtered),
                    "selected_documents": len(snapshot_filtered),
                    "vector_count": len(vector_map),
                },
            },
        }

    @staticmethod
    async def _read_vectors(owner_user_id, documents, vector_version: str) -> dict[str, list[float]]:
        if not vector_version:
            return {}
        from agent.memory.embedding import model_tag
        if vector_version != model_tag():
            return {}
        from app.services.storage import get_storage

        owner = str(owner_user_id)
        _validate_scope_component(owner, "ownerId")
        storage = get_storage()
        base = f"{owner}/.agent/"
        vector_keys = (
            ("memory", f"{base}memory_vec.json"),
            ("knowledge", f"{base}knowledge/vectors.json"),
            ("pattern", f"{base}pattern_vec.json"),
        )
        raw_texts = await asyncio.gather(*(
            _read_vector_text(storage, key) for _, key in vector_keys
        ))
        vector_maps = {
            cache_name: _parse_vector_file(raw_text, f"{owner}:{cache_name}:{vector_version}", vector_version)
            for (cache_name, _), raw_text in zip(vector_keys, raw_texts)
        }
        from agent.rag.vector_cache import cache_key

        from agent.rag import cython_native

        return cython_native.map_document_vectors(documents, vector_maps, cache_key)


__all__ = ["CythonRagLifecycle", "DELTA_MAX_PASSES", "WATERMARK_HORIZON"]


def _validate_memory_scopes(owner_id: str, scopes) -> list:
    from dataclasses import replace
    from agent.rag.models import Scope

    if not scopes:
        return [Scope(owner_user_id=owner_id, scope_type="owner", scope_id=owner_id)]
    result = []
    seen = set()
    for scope in scopes:
        if not isinstance(scope, Scope) or str(scope.owner_user_id).lower() != owner_id.lower():
            raise ValueError("Memory scope owner 与当前 owner 不一致")
        if scope.scope_type not in {"owner", "group", "member"}:
            raise ValueError("Memory scope 类型不受支持")
        if scope.scope_type == "owner":
            # TsSidecarClient 会把 owner scope 的空 id 规范化为绑定 owner 后再发给 TS。
            if str(scope.scope_id or "") not in {"", owner_id}:
                raise ValueError("Memory owner scope 不匹配")
            if not scope.scope_id:
                scope = replace(scope, scope_id=owner_id)
        elif (not scope.scope_id or not scope.platform or not scope.bot_id
              or (scope.scope_type == "member" and not scope.group_id)):
            raise ValueError("Memory scope 缺少必要字段")
        else:
            _validate_scope_component(scope.platform, "platform")
            _validate_scope_component(scope.bot_id, "botId")
            _validate_scope_component(scope.scope_id, "scopeId")
            if scope.scope_type == "group" and scope.group_id and scope.group_id != scope.scope_id:
                raise ValueError("Memory group scope 不匹配")
            if scope.scope_type == "member" and not scope.scope_id.startswith(f"{scope.group_id}:"):
                raise ValueError("Memory member scope 不匹配")
        key = (scope.scope_type, scope.scope_id, scope.platform, scope.bot_id, scope.group_id)
        if key in seen:
            raise ValueError("Memory scope 不得重复")
        seen.add(key)
        result.append(scope)
    return result


def _validate_scope_component(value: object, label: str) -> None:
    component = str(value or "").strip()
    if not component or component in {".", ".."} or any(char in component for char in ("/", "\\", "\0")):
        raise ValueError(f"Memory {label} 非法")


def _memory_scope_allows(authorized_scope, document_scope) -> bool:
    if authorized_scope.scope_type == "owner":
        return document_scope.scope_type == "owner"
    return (
        document_scope.scope_type == authorized_scope.scope_type
        and document_scope.scope_id == authorized_scope.scope_id
        and document_scope.platform == authorized_scope.platform
        and document_scope.bot_id == authorized_scope.bot_id
        and document_scope.group_id == (
            authorized_scope.group_id
            or (authorized_scope.scope_id if authorized_scope.scope_type == "group" else "")
        )
    )


def _worker_vector_map(
    documents,
    vectors: dict[str, list[float]],
    *,
    values_validated: bool = False,
) -> dict[str, list[float]]:
    """转换为稳定 chunk-slot 键；有效 float 列表保持引用，安装时再统一复制。"""
    from agent.rag.delta import chunk_slot_key

    result = {}
    for document in documents:
        vector = vectors.get(document.chunk_id)
        if vector is None:
            continue
        if values_validated:
            result[chunk_slot_key(document)] = vector
            continue
        is_float_list = isinstance(vector, list)
        valid_vector = True
        for value in vector:
            if (not isinstance(value, (int, float)) or isinstance(value, bool)
                    or not math.isfinite(value)):
                valid_vector = False
                break
            if type(value) is not float:
                is_float_list = False
        if not valid_vector:
            continue
        if is_float_list:
            result[chunk_slot_key(document)] = vector
        else:
            result[chunk_slot_key(document)] = [float(value) for value in vector]
    return result


def _worker_document_slot(document) -> str:
    from agent.rag.delta import chunk_slot_key

    return chunk_slot_key(document)


async def _read_vector_text(storage, key: str) -> str | None:
    """复刻 StorageReader 的 50M 字符/200MB 上限与 best-effort 单文件读取。"""
    try:
        raw = await storage.get(key)
        if len(raw) > VECTOR_FILE_MAX_CHARS * 4:
            return None
        text = raw.decode("utf-8", errors="replace").removeprefix("\ufeff")
        return _js_utf16_slice(text, VECTOR_FILE_MAX_CHARS)
    except Exception:
        return None


def _js_utf16_slice(value: str, limit: int) -> str:
    encoded = value.encode("utf-16-le", errors="surrogatepass")[:limit * 2]
    return encoded.decode("utf-16-le", errors="surrogatepass")


def _parse_vector_file(
    raw_text: str | None, cache_key: str, vector_version: str,
) -> dict[str, tuple[float, ...]]:
    if raw_text is None or not raw_text.strip():
        return {}
    digest = hashlib.sha256(raw_text.encode("utf-8", errors="replace")).hexdigest()
    versioned_key = (cache_key, vector_version)
    cached = _vector_file_cache.get(versioned_key)
    if cached is not None and cached[0] == digest:
        _vector_file_cache.move_to_end(versioned_key)
        validated = cached[1]
    else:
        try:
            parsed = json.loads(raw_text, parse_constant=_reject_json_constant)
        except (json.JSONDecodeError, ValueError):
            parsed = None
        from agent.rag import cython_native

        vectors = cython_native.validate_vector_mapping(parsed, vector_version) if isinstance(parsed, dict) else {}
        validated = {key: tuple(vector) for key, vector in vectors.items()}
        _vector_file_cache[versioned_key] = (digest, validated)
        _vector_file_cache.move_to_end(versioned_key)
        while len(_vector_file_cache) > VECTOR_FILE_CACHE_SIZE:
            _vector_file_cache.popitem(last=False)
    # 仅复制映射容器；向量以 tuple 缓存且不可变，避免每次命中都复制整份高维数据。
    return dict(validated)


def _reject_json_constant(value: str):
    raise ValueError(f"非标准 JSON 数字常量：{value}")


_JS_WHITESPACE = re.compile(r"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")


def _snapshot_covers(document_text: str, snapshot_text: str) -> bool:
    """判断单条 Memory 是否已由本轮 snapshot 覆盖。"""
    return _snapshot_covers_context(
        document_text, _normalized_snapshot_context(snapshot_text),
    )


def _normalized_snapshot_context(snapshot_text: str) -> bytes:
    """预处理一次 snapshot 文本，供整批 Memory 文档复用。"""
    normalized = _JS_WHITESPACE.sub("", str(snapshot_text or ""))
    return normalized.encode("utf-16-le", errors="surrogatepass")


def _snapshot_covers_context(document_text: str, context_encoded: bytes) -> bool:
    joined = _JS_WHITESPACE.sub("", str(document_text or "").strip())
    if not joined or not context_encoded:
        return False
    js_length = len(joined.encode("utf-16-le", errors="surrogatepass")) // 2
    minimum = max(80, int(js_length * 0.7))
    encoded = joined.encode("utf-16-le", errors="surrogatepass")[:minimum * 2]
    return len(encoded) > 0 and encoded in context_encoded
