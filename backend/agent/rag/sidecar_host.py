"""gugu-rag-sidecar 宿主：统一托管 TS worker 与常驻 Cython RAG lifecycle。

多个 Python 进程（uvicorn worker、gugu-worker、gateway）连接本宿主后共享热索引。
宿主内持有真实的 ``TsSidecarClient``，并按 owner/cache scope 持有 Cython 生命周期；
TS 请求继续转发给 per-owner worker，Cython 请求在宿主进程内执行。

协议（行分界 JSON，读上限与 stdio 相同 32MB）：
    请求 {"v":1, "req_id", "owner", "timeout_ms", "payload"}
    响应 {"req_id", "payload", "state"}            state=宿主内 client 状态镜像
    错误 {"req_id", "status":"error", "code", "message"}

两个特殊 op 在宿主侧判定（判定依据是宿主内真实 worker 进程状态，跨进程不可见）：
    reuse_if_current → 磁盘恢复/revision 比对后回 {"ok": bool}
    replace_transient → 指纹未变且进程未重启时短路，不重传 Memory 语料

启动：``python -m agent.rag.sidecar_host --socket /run/user/<uid>/gugu-rag-sidecar.sock``
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import signal
import sys
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent.rag.ts_sidecar import (
    SIDECAR_STREAM_LIMIT_BYTES,
    SIDE_CAR_IDLE_TTL_SECONDS,
    TsSidecarClient,
    TsSidecarUnavailable,
    _client_state_mirror,
    index_dir_for_owner,
)

_log = logging.getLogger("agent.rag.sidecar_host")

RANK_OWNER = "__rank__"
REAP_INTERVAL_SECONDS = 60
CYTHON_CACHE_SCOPE_MAX_LENGTH = 256


@dataclass
class _CythonEntry:
    owner: str
    cache_scope: str
    lifecycle: Any
    estimated_bytes: int
    last_used: float
    active_requests: int = 0


@dataclass
class _CythonTransientEntry:
    owner: str
    revision: str
    index: Any
    estimated_bytes: int
    last_used: float
    active_requests: int = 0


class SidecarHost:
    def __init__(self, socket_path: str):
        self.socket_path = socket_path
        self._clients: dict[str, TsSidecarClient] = {}
        self._lock = asyncio.Lock()
        self._server: asyncio.Server | None = None
        self._reaper: asyncio.Task | None = None
        self._cython_entries: OrderedDict[tuple[str, str], _CythonEntry] = OrderedDict()
        self._cython_transient_entries: OrderedDict[tuple[str, str], _CythonTransientEntry] = OrderedDict()
        self._cython_lock = asyncio.Lock()

    def _client_for(self, owner: str) -> TsSidecarClient:
        """按 owner 取宿主内真实 client；直接构造，不走 get_lexical_client
        （后者在 socket 配置存在时会递归连回宿主自己）。"""
        client = self._clients.get(owner)
        if client is None:
            from app.core.config import get_settings

            command = get_settings().search.ts_sidecar_command
            index_dir = "" if owner == RANK_OWNER else index_dir_for_owner(owner)
            client = TsSidecarClient(owner, command=command, index_dir=index_dir)
            self._clients[owner] = client
        client.touch()
        return client

    async def handle_request(self, envelope: dict) -> tuple[dict, TsSidecarClient | None]:
        """处理单个信封；返回 (响应 payload, 本次使用的内层 client)。

        宿主侧分段计时注入响应 ``probe.stage_ms``：``host_queue_ms`` = 到达→
        派发（含 worker 进程确保），``host_upstream_ms`` = client._request 全程
        （内含每 owner 锁等待 + worker 往返）——这是此前 RAG_PROBE 的诊断盲区
        （sync op 不记 queue_wait、宿主内排队不可见）。worker 自身耗时由 worker
        探针的 stage_ms 承担，两者相减即为宿主内等待。
        """
        loop = asyncio.get_running_loop()
        arrival = loop.time()
        owner = str(envelope.get("owner") or "")
        payload = envelope.get("payload")
        if not owner or not isinstance(payload, dict):
            return ({"status": "error", "code": "bad_request",
                     "message": "信封缺少 owner/payload"}, None)
        timeout_ms = int(envelope.get("timeout_ms") or 0)
        timeout_seconds = max(0.05, timeout_ms / 1000) if timeout_ms else None
        if str(payload.get("op") or "").startswith("cython_"):
            return await self._handle_cython_envelope(owner, payload), None
        client = self._client_for(owner)
        op = payload.get("op")
        dispatch = loop.time()
        try:
            if op == "reuse_if_current":
                ok = await client.reuse_if_current(payload.get("revision"))
                response = {"ok": ok}
            elif op == "replace_transient":
                short = self._transient_short_circuit(client, payload)
                if short is not None:
                    response = short
                else:
                    response = dict(
                        (await client._request(payload, timeout_seconds=timeout_seconds)).response,
                    )
            else:
                response = dict(
                    (await client._request(payload, timeout_seconds=timeout_seconds)).response,
                )
            if isinstance(response, dict) and response.get("status") == "ok":
                probe = response.get("probe")
                if not isinstance(probe, dict):
                    probe = {}
                    response["probe"] = probe
                stage = probe.setdefault("stage_ms", {})
                stage["host_queue_ms"] = int((dispatch - arrival) * 1000)
                stage["host_upstream_ms"] = int((loop.time() - dispatch) * 1000)
            return response, client
        except TsSidecarUnavailable as exc:
            response: dict[str, Any] = {
                "status": "error", "code": exc.code or "sidecar_unavailable",
                "message": str(exc),
            }
            if exc.diagnostics:
                response["diagnostics"] = exc.diagnostics
            return response, client

    async def _handle_cython_envelope(self, owner: str, payload: dict) -> dict:
        try:
            if payload.get("op") == "cython_transient_search":
                return await self._handle_cython_transient_search(owner, payload)
            return await self._handle_cython_request(owner, payload)
        except Exception as exc:
            from agent.rag.cython_backend import CythonRevisionMismatch

            if isinstance(exc, CythonRevisionMismatch):
                return {"status": "error", "code": "revision_mismatch",
                        "message": "Cython RAG 索引版本需要重新同步"}
            _log.warning("Cython RAG sidecar 请求失败：%s", type(exc).__name__)
            return {"status": "error", "code": "cython_worker_failure",
                    "message": "Cython RAG worker 请求失败"}

    async def _handle_cython_request(self, owner: str, payload: dict) -> dict:
        """在 sidecar 常驻进程内维护 owner/cache-scope 隔离的 Cython lifecycle。"""
        from agent.rag.index_cache import (
            GLOBAL_CACHE_BYTES, INDEX_CACHE_TTL_SECONDS, PER_OWNER_CACHE_BYTES,
        )

        cache_scope = str(payload.get("cache_scope") or "all")
        if (not owner or owner in {".", ".."} or "/" in owner or "\\" in owner
                or len(cache_scope) > CYTHON_CACHE_SCOPE_MAX_LENGTH):
            return {"status": "error", "code": "bad_request",
                    "message": "Cython RAG 请求范围无效"}
        key = (owner, cache_scope)
        op = str(payload.get("op") or "")
        now = time.monotonic()
        if op == "cython_try_acquire":
            requested_revision = str(payload.get("revision") or "")
            requested_vectors = str(payload.get("vector_version") or "")
            async with self._cython_lock:
                entry = self._cython_entries.get(key)
                if entry is None:
                    return {"status": "ok", "ready": False}
                if now - entry.last_used > INDEX_CACHE_TTL_SECONDS:
                    self._cython_entries.pop(key, None)
                    return {"status": "ok", "ready": False}
                if (entry.lifecycle.revision != requested_revision
                        or entry.lifecycle.engine.vector_version != requested_vectors):
                    return {"status": "ok", "ready": False}
                entry.last_used = now
                self._cython_entries.move_to_end(key)
                return {**self._cython_state(entry), "ready": True}

        async with self._cython_lock:
            entry = self._cython_entries.get(key)
            if entry is not None:
                entry.last_used = now
                entry.active_requests += 1
                self._cython_entries.move_to_end(key)

        try:
            if entry is None:
                entry = await self._create_cython_entry(owner, cache_scope)
            requested_revision = payload.get("revision")
            requested_vectors = str(payload.get("vector_version") or "")
            if op == "cython_acquire":
                if (entry.lifecycle.revision != str(requested_revision or "")
                        or entry.lifecycle.engine.vector_version != requested_vectors):
                    await self._load_cython_entry(entry, requested_revision, requested_vectors)
                return self._cython_state(entry)
            if entry.lifecycle.revision != str(requested_revision or entry.lifecycle.revision):
                await self._load_cython_entry(entry, requested_revision, requested_vectors)
            if op == "cython_prepare_memory":
                from agent.rag.models import Scope

                scopes = [Scope(**item) for item in payload.get("scopes", [])]
                result = await entry.lifecycle.prepare_memory(
                    self._cython_database_owner(owner), scopes,
                    source_filter=str(payload.get("source_filter") or "all"),
                    snapshot_revision=str(payload.get("snapshot_revision") or ""),
                    snapshot_text=str(payload.get("snapshot_text") or ""),
                    vector_version=str(payload.get("vector_version") or ""),
                )
                return result
            if op == "cython_unified_query":
                from agent.rag.models import Scope

                options = dict(payload.get("options") or {})
                searches = []
                for item in options.get("searches") or ():
                    spec = dict(item)
                    raw_scope = spec.get("scope")
                    if isinstance(raw_scope, dict):
                        scope = Scope(**raw_scope)
                        if scope.owner_user_id != owner:
                            raise ValueError("Cython RAG 查询 scope owner 不匹配")
                        spec["scope"] = scope
                    searches.append(spec)
                options["searches"] = searches
                result = await entry.lifecycle.unified_query(
                    str(payload.get("query") or ""), **options,
                )
                return result
            if op == "cython_flush_snapshot":
                return await entry.lifecycle.flush_snapshot_persistence()
            return {"status": "error", "code": "unknown_operation",
                    "message": "未知的 Cython RAG 操作"}
        finally:
            async with self._cython_lock:
                current = self._cython_entries.get(key)
                if entry is not None and current is entry:
                    current.active_requests = max(0, current.active_requests - 1)
                    current.last_used = time.monotonic()
                    current.estimated_bytes = int(entry.lifecycle.estimated_bytes)
                    self._cython_entries.move_to_end(key)
            await self._evict_cython_entries(
                ttl_seconds=INDEX_CACHE_TTL_SECONDS,
                owner_limit_bytes=PER_OWNER_CACHE_BYTES,
                global_limit_bytes=GLOBAL_CACHE_BYTES,
            )

    async def _handle_cython_transient_search(self, owner: str, payload: dict) -> dict:
        """在 sidecar 中缓存并搜索 transient RAG 文档，供能力目录等小型语料复用。"""
        from agent.rag.cython_backend import CythonLexicalIndex
        from agent.rag.cython_runtime import ensure_cython_native_loaded
        from agent.rag.index_cache import (
            GLOBAL_CACHE_BYTES, INDEX_CACHE_TTL_SECONDS, PER_OWNER_CACHE_BYTES,
            estimate_document_bytes,
        )
        from agent.rag.models import Scope
        from agent.rag.ts_sidecar import _from_wire_document, _wire_document

        revision = str(payload.get("revision") or "")
        raw_documents = payload.get("documents")
        if not owner or not revision or not isinstance(raw_documents, list):
            return {"status": "error", "code": "bad_request",
                    "message": "Cython transient 请求无效"}
        documents = []
        for raw in raw_documents:
            if not isinstance(raw, dict):
                return {"status": "error", "code": "bad_request",
                        "message": "Cython transient 文档结构无效"}
            if str(raw.get("owner_user_id") or "") != owner:
                return {"status": "error", "code": "owner_mismatch",
                        "message": "Cython transient 文档 owner 不匹配"}
            document = _from_wire_document(raw, owner)
            if document is None:
                return {"status": "error", "code": "bad_request",
                        "message": "Cython transient 文档无法解析"}
            # wire 文档不传 owner 字段，因此 scope owner 由 envelope 绑定。
            if not isinstance(document.scope, Scope) or document.scope.owner_user_id != owner:
                return {"status": "error", "code": "owner_mismatch",
                        "message": "Cython transient scope owner 不匹配"}
            documents.append(document)

        fingerprint = hashlib.sha256(json.dumps(
            raw_documents, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")).hexdigest()[:32]
        key = (owner, fingerprint)
        async with self._cython_lock:
            entry = self._cython_transient_entries.get(key)
            if entry is not None:
                cache_hit = True
                entry.active_requests += 1
                entry.last_used = time.monotonic()
                self._cython_transient_entries.move_to_end(key)
            else:
                cache_hit = False
        if entry is None:
            await ensure_cython_native_loaded()
            index = await asyncio.to_thread(CythonLexicalIndex.build, documents, revision)
            estimated_bytes = max(
                estimate_document_bytes(documents),
                len(json.dumps(raw_documents, ensure_ascii=False).encode("utf-8")) * 2,
            )
            async with self._cython_lock:
                entry = self._cython_transient_entries.get(key)
                if entry is None:
                    entry = _CythonTransientEntry(
                        owner, fingerprint, index, estimated_bytes, time.monotonic(), 1,
                    )
                    self._cython_transient_entries[key] = entry
                else:
                    entry.active_requests += 1
                    entry.last_used = time.monotonic()
                self._cython_transient_entries.move_to_end(key)

        query_started = time.monotonic()
        try:
            scope_raw = payload.get("scope")
            scope = Scope(**scope_raw) if isinstance(scope_raw, dict) else None
            if scope is not None and scope.owner_user_id != owner:
                return {"status": "error", "code": "owner_mismatch",
                        "message": "Cython transient 查询 scope owner 不匹配"}
            results, search_diagnostics = await asyncio.to_thread(
                entry.index.search,
                str(payload.get("query") or ""),
                limit=max(1, min(int(payload.get("limit") or 10), 100)),
                source_types=tuple(map(str, payload.get("source_types") or ())),
                scope=scope,
            )
            return {
                "status": "ok",
                "cache_hit": cache_hit,
                "results": [{
                    "score": result.score,
                    "document": _wire_document(result.document),
                } for result in results],
                "timing": {
                    "queue_wait_ms": 0,
                    "query_ms": int((time.monotonic() - query_started) * 1000),
                    "candidate_count": int(search_diagnostics.candidate_count),
                    "eligible_count": int(search_diagnostics.eligible_count),
                },
            }
        finally:
            async with self._cython_lock:
                current = self._cython_transient_entries.get(key)
                if current is entry:
                    current.active_requests = max(0, current.active_requests - 1)
                    current.last_used = time.monotonic()
                    self._cython_transient_entries.move_to_end(key)
            await self._evict_cython_entries(
                ttl_seconds=INDEX_CACHE_TTL_SECONDS,
                owner_limit_bytes=PER_OWNER_CACHE_BYTES,
                global_limit_bytes=GLOBAL_CACHE_BYTES,
            )

    async def _create_cython_entry(self, owner: str, cache_scope: str) -> _CythonEntry:
        from agent.rag.cython_runtime import ensure_cython_native_loaded
        from agent.rag.cython_lifecycle import CythonRagLifecycle

        key = (owner, cache_scope)
        async with self._cython_lock:
            existing = self._cython_entries.get(key)
            if existing is not None:
                existing.active_requests += 1
                existing.last_used = time.monotonic()
                return existing
        await ensure_cython_native_loaded()
        lifecycle = CythonRagLifecycle()
        async with self._cython_lock:
            existing = self._cython_entries.get(key)
            if existing is not None:
                existing.active_requests += 1
                existing.last_used = time.monotonic()
                return existing
            entry = _CythonEntry(owner, cache_scope, lifecycle, 0, time.monotonic(), 1)
            self._cython_entries[key] = entry
            return entry

    async def _load_cython_entry(
        self, entry: _CythonEntry, revision: object, vector_version: str,
    ) -> dict[str, Any]:
        import app.db.session as db_session

        db_session.ensure_engine()
        session_factory = db_session._SessionLocal
        if session_factory is None:
            raise RuntimeError("Cython RAG sidecar 数据库会话工厂未初始化")
        database_owner = self._cython_database_owner(entry.owner)
        cache_tag = hashlib.sha256(entry.cache_scope.encode("utf-8")).hexdigest()[:20]
        snapshot_dir = Path(index_dir_for_owner(entry.owner)).parent / "cython" / cache_tag
        async with session_factory() as db:
            result = await entry.lifecycle.load_index_from_snapshot_or_database(
                db, database_owner, snapshot_dir,
                vector_version=vector_version,
                revision=str(revision) if revision is not None else None,
            )
        entry.estimated_bytes = int(entry.lifecycle.estimated_bytes)
        return result

    @staticmethod
    def _cython_database_owner(owner: str):
        """把 IPC 文本身份恢复为 DB UUID；不允许把无效 owner 带进 SQL 查询。"""
        try:
            return uuid.UUID(owner)
        except (TypeError, ValueError, AttributeError) as exc:
            raise ValueError("Cython RAG owner 格式无效") from exc

    @staticmethod
    def _cython_state(entry: _CythonEntry) -> dict[str, Any]:
        watermark = entry.lifecycle.watermark
        return {
            "status": "ok",
            "revision": entry.lifecycle.revision,
            "document_count": entry.lifecycle.document_count,
            "estimated_bytes": int(entry.lifecycle.estimated_bytes),
            "vector_count": entry.lifecycle.engine.vector_count,
            "vector_version": entry.lifecycle.engine.vector_version,
            "watermark": ({"ts": watermark.timestamp.isoformat(), "id": watermark.row_id}
                          if watermark else None),
        }

    async def _evict_cython_entries(
        self, *, ttl_seconds: int, owner_limit_bytes: int, global_limit_bytes: int,
    ) -> int:
        now = time.monotonic()
        async with self._cython_lock:
            sizes_by_owner: dict[str, int] = {}
            for entry in (*self._cython_entries.values(),
                          *self._cython_transient_entries.values()):
                sizes_by_owner[entry.owner] = sizes_by_owner.get(entry.owner, 0) + entry.estimated_bytes
            total = sum(sizes_by_owner.values())
            candidates = [
                ("lifecycle", key, entry)
                for key, entry in self._cython_entries.items()
                if entry.active_requests == 0
            ] + [
                ("transient", key, entry)
                for key, entry in self._cython_transient_entries.items()
                if entry.active_requests == 0
            ]
            candidates.sort(key=lambda item: item[2].last_used)
            victims: list[tuple[str, tuple[str, str], Any]] = []
            for kind, key, entry in candidates:
                if now - entry.last_used >= ttl_seconds:
                    victims.append((kind, key, entry))
                    total -= entry.estimated_bytes
                    sizes_by_owner[entry.owner] -= entry.estimated_bytes
            for kind, key, entry in candidates:
                if (total <= global_limit_bytes
                        and sizes_by_owner.get(entry.owner, 0) <= owner_limit_bytes):
                    continue
                if any(victim_kind == kind and victim_key == key
                       for victim_kind, victim_key, _ in victims):
                    continue
                victims.append((kind, key, entry))
                total -= entry.estimated_bytes
                sizes_by_owner[entry.owner] = max(
                    0, sizes_by_owner.get(entry.owner, 0) - entry.estimated_bytes,
                )
            for kind, key, entry in victims:
                cache = (self._cython_entries if kind == "lifecycle"
                         else self._cython_transient_entries)
                if cache.get(key) is entry:
                    cache.pop(key, None)
        return len(victims)

    @staticmethod
    def _transient_short_circuit(client: TsSidecarClient, payload: dict) -> dict | None:
        """指纹未变且宿主内 worker 进程未重启 → 瞬态语料已在，免重传。"""
        if payload.get("force"):
            return None
        process = client._process
        if process is None or process.returncode is not None:
            return None
        revision = str(payload.get("revision") or "")
        if (client._transient_revision == revision
                and client._transient_generation == client._process_generation):
            return {"status": "ok", "revision": revision, "short_circuit": True}
        return None

    async def _handle_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    envelope = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload, client = await self.handle_request(envelope)
                response: dict[str, Any] = {
                    "req_id": envelope.get("req_id"),
                    "payload": payload,
                    "state": _client_state_mirror(client) if client is not None else {},
                }
                if payload.get("status") == "error":
                    response = {
                        "req_id": envelope.get("req_id"),
                        "status": "error",
                        "code": payload.get("code"),
                        "message": payload.get("message"),
                    }
                    if isinstance(payload.get("diagnostics"), dict):
                        response["diagnostics"] = payload["diagnostics"]
                writer.write((json.dumps(response, ensure_ascii=False) + "\n").encode())
                await writer.drain()
        except (ConnectionError, OSError, ValueError):
            # ValueError = readline 流上限：半行残留后该连接不可信，丢弃整条连接。
            pass
        finally:
            try:
                writer.close()
            except (ConnectionError, OSError):
                pass

    async def _reap_idle(self) -> None:
        while True:
            await asyncio.sleep(REAP_INTERVAL_SECONDS)
            await self._reap_once()

    async def _reap_once(self) -> int:
        """清扫一轮空闲 worker，返回回收数。"""
        idle = [owner for owner, client in self._clients.items()
                if client.is_idle()]
        reaped = 0
        for owner in idle:
            # 关闭上一个 client 的 await 期间，这个 owner 可能刚来新请求
            # （_client_for 的 touch 会刷新最后使用时间、请求随后 active++）。
            # 真正回收前必须在锁内重验「dict 里仍是这个 owner 的 client 且仍
            # 空闲」；锁不跨 close 的 await——close 期间的新请求会拿到新 client，
            # 与被回收的旧实例互不影响。
            async with self._lock:
                client = self._clients.get(owner)
                if client is None or not client.is_idle():
                    continue
                self._clients.pop(owner, None)
            await client.close()
            reaped += 1
            _log.info("sidecar 宿主回收空闲 worker owner=%s…", owner[:8])
        from agent.rag.index_cache import INDEX_CACHE_TTL_SECONDS
        cython_reaped = await self._evict_cython_entries(
            ttl_seconds=INDEX_CACHE_TTL_SECONDS,
            owner_limit_bytes=2**63 - 1,
            global_limit_bytes=2**63 - 1,
        )
        return reaped + cython_reaped

    async def start(self) -> None:
        path = Path(self.socket_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            path.unlink()   # 残留 socket 文件
        self._server = await asyncio.start_unix_server(
            self._handle_connection, path=str(path), limit=SIDECAR_STREAM_LIMIT_BYTES,
        )
        path.chmod(0o600)
        self._reaper = asyncio.create_task(self._reap_idle())
        _log.info("sidecar 宿主就绪 socket=%s", self.socket_path)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
        if self._reaper is not None:
            self._reaper.cancel()
            await asyncio.gather(self._reaper, return_exceptions=True)
        for owner, client in self._clients.items():
            await client.close()
        for entry in self._cython_entries.values():
            try:
                await entry.lifecycle.flush_snapshot_persistence()
            except Exception as exc:
                _log.warning("Cython RAG 关闭前快照收束失败：%s", type(exc).__name__)
        _log.info("sidecar 宿主已关闭（workers=%d）", len(self._clients))


async def _amain(socket_path: str) -> None:
    from app.core.config import get_settings

    settings = get_settings()   # 提前加载配置，TS worker 子进程的环境注入依赖它
    if settings.search.rag_backend == "cython":
        from agent.rag.cython_runtime import ensure_cython_native_loaded

        warm_started = time.monotonic()
        try:
            await ensure_cython_native_loaded()
            _log.info(
                "Cython RAG native runtime 已预热（%d ms）",
                int((time.monotonic() - warm_started) * 1000),
            )
        except Exception as exc:
            _log.warning("Cython RAG native runtime 预热失败：%s", type(exc).__name__)
    host = SidecarHost(socket_path)
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_event.set)
    await host.start()
    await stop_event.wait()
    await host.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="gugu-rag-sidecar 宿主")
    parser.add_argument("--socket", required=True, help="unix socket 路径")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        stream=sys.stdout,
    )
    asyncio.run(_amain(args.socket))


if __name__ == "__main__":
    main()
