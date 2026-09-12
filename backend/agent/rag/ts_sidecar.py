"""TypeScript RAG worker 的异步 JSONL 客户端。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shlex
import uuid
import weakref
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent.rag.hybrid import hybrid_results
from agent.rag.models import IndexDocument, RecallCandidate, RecallResult, Scope
from agent.rag.scope import matches_scope


def _record_worker_restore_probe(response: dict[str, Any]) -> None:
    restore_probe = response.get("restore_probe")
    if not isinstance(restore_probe, dict):
        return

    stage_names = {
        "restore_read_file", "restore_json_parse", "restore_index_install",
        "restore_vector_map", "restore_total",
    }
    count_names = {
        "index_file_present", "index_file_bytes", "documents", "vectors", "restored",
    }
    raw_stage_ms = restore_probe.get("stage_ms")
    raw_counts = restore_probe.get("counts")
    from agent.rag.observation import probe_update

    probe_update(index_worker_restore={
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


class TsSidecarUnavailable(RuntimeError):
    """TS worker 未配置、启动失败或协议请求失败。

    ``code`` 保留 worker 返回的机器可读错误码（如 ``revision_mismatch``）。调用方
    靠它区分「索引 revision 与 worker 当前状态不一致」这类可自愈故障和真正的
    不可用，而不是去匹配中文文案。
    """

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SidecarRequestTiming:
    """一次 sidecar 请求自己的计时，不挂在共享 owner client 上。"""

    queue_wait_ms: int = 0
    query_ms: int = 0
    ensure_process_ms: int = 0
    response_wait_ms: int = 0


@dataclass(frozen=True)
class SidecarRequestResult:
    response: dict
    timing: SidecarRequestTiming


def index_dir_for_owner(owner_user_id: object) -> str:
    """返回用户私有的隐藏 RAG 索引根目录。

    生产环境把派生索引放在用户存储目录下；没有完整运行配置的单测继续使用
    search.ts_sidecar_index_dir，避免测试依赖真实用户存储。
    """
    from app.core.config import get_settings

    settings = get_settings()
    storage = getattr(settings, "storage", None)
    local_path = getattr(storage, "local_path", "") if storage is not None else ""
    if local_path:
        return str(Path(local_path).expanduser() / str(owner_user_id) / ".system" / "rag" / "ts-index")
    return str(Path(settings.search.ts_sidecar_index_dir).expanduser())


SIDE_CAR_IDLE_TTL_SECONDS = 30 * 60
# 索引构建类 op（replace/patch/build_and_index/replace_transient）的等待上限：
# 全量语料装载远超 500ms 搜索超时，且不在用户等待路径上（ping 预热同理单独放宽）。
BUILD_TIMEOUT_SECONDS = 30.0
# 批量查询响应把多来源候选连同原文聚合在一条 JSONL 里，64KB 默认流上限会被
# readline 以 "chunk is longer than limit" 打断，放宽到 32MB。
SIDECAR_STREAM_LIMIT_BYTES = 32 * 1024 * 1024
SIDE_CAR_REAPER_INTERVAL_SECONDS = 60
# esbuild 单文件制品保留的版本常量，用于识别旧制品写下的过期索引目录。
_ARTIFACT_VERSION_RE = re.compile(rb'RAG_WORKER_VERSION\s*=\s*"([^"]+)"')


class TsSidecarClient:
    """一个 owner 一个 worker 进程，索引目录按 owner 隔离。"""

    def __init__(self, owner_user_id: object, *, command: str, index_dir: str = ""):
        self.owner_user_id = str(owner_user_id)
        self.command = command
        self.index_dir = index_dir
        self._process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._revision: str | None = None
        self._document_count = 0
        self._estimated_bytes = 0
        self._vector_count = 0
        self._vector_version = ""
        # 瞬态语料（Memory 快照）驻留在 worker 内存里：记录加载时的进程代数与指纹，
        # worker 重启后代数变化会自动重传，不依赖已失效的进程内状态。
        self._transient_revision: str | None = None
        self._transient_generation = -1
        self._process_generation = 0
        # worker 进程启动时从磁盘恢复索引的结局（version_mismatch/corrupt）；
        # None 表示恢复健康或尚无索引文件。重建成功后双向清空。
        self._restore_error: str | None = None
        self.last_search_diagnostics: dict[str, Any] = {}
        self._last_used_at = asyncio.get_running_loop().time()
        self._active_requests = 0

    @property
    def restore_error(self) -> str | None:
        """启动恢复失败类别；供查询诊断显式报告损坏索引并调度重建。"""
        return self._restore_error

    def touch(self) -> None:
        """刷新 worker 空闲 TTL；TTL 不会打断正在执行的请求。"""
        self._last_used_at = asyncio.get_running_loop().time()

    def is_idle(self, now: float | None = None) -> bool:
        current = now if now is not None else asyncio.get_running_loop().time()
        return self._active_requests == 0 and current - self._last_used_at >= SIDE_CAR_IDLE_TTL_SECONDS

    async def replace(
        self,
        documents: list[IndexDocument],
        revision: str | None,
        *,
        vectors: dict[str, list[float]] | None = None,
        vector_version: str = "",
        storage_owner_id: object | None = None,
    ) -> dict:
        # 索引构建不是用户等待的搜索路径，全量 replace 可能远超 500ms 搜索超时。
        payload: dict[str, Any] = {
            "op": "replace",
            "revision": revision or "",
            "documents": [_wire_document(document) for document in documents],
        }
        if vectors is not None:
            payload["vectors"] = vectors
            payload["vector_version"] = vector_version
        if storage_owner_id is not None:
            if str(storage_owner_id) != self.owner_user_id:
                raise ValueError("向量缓存 owner 与 sidecar owner 不一致")
            payload["vector_cache"] = {
                "owner_id": self.owner_user_id,
                "vector_version": str(vector_version or ""),
            }
        result = await self._request(payload, timeout_seconds=BUILD_TIMEOUT_SECONDS)
        response = result.response
        self._revision = response.get("revision")
        self._document_count = int(response.get("document_count") or len(documents))
        self._vector_count = int(response.get("vector_count") or 0)
        self._vector_version = str(response.get("vector_version") or "")
        self._restore_error = None
        return response

    async def build_documents(self, batch: dict[str, list[dict]]) -> list[dict]:
        """让 TS builder 从统一 source batch 生成 canonical 文档；不读取业务数据库。"""
        response = (await self._request({"op": "build_documents", "batch": batch})).response
        return list(response.get("documents") or [])

    async def database_revision(self, owner_user_id: object) -> str | None:
        """让 owner-bound TS worker 读取持久索引 revision；owner 不接受调用参数覆盖。"""
        response = (await self._request({
            "op": "database_revision", "owner_id": str(owner_user_id),
        })).response
        value = response.get("revision")
        return str(value) if value else None

    async def load_index_from_database(
        self, owner_user_id: object, revision: str, vector_version: str = "",
    ) -> dict:
        """在 TS worker 内按 owner 读取 canonical chunk 并建立索引，不回传正文。"""
        response = (await self._request({
            "op": "load_index_from_database",
            "owner_id": str(owner_user_id),
            "revision": str(revision or ""),
            "vector_version": str(vector_version or ""),
        }, timeout_seconds=BUILD_TIMEOUT_SECONDS)).response
        self._revision = str(response.get("revision") or "")
        self._document_count = int(response.get("document_count") or 0)
        self._estimated_bytes = int(response.get("estimated_bytes") or 0)
        self._vector_count = int(response.get("vector_count") or 0)
        self._vector_version = str(response.get("vector_version") or "")
        self._restore_error = None
        return response

    async def sync_index_from_database(
        self, owner_user_id: object, revision: str, vector_version: str = "",
    ) -> dict:
        """增量自同步：worker 按 chunk 表水位只读取变更行并 patch 内存/磁盘索引。

        水位缺失或落后超过墓碑保留视界时 worker 内部回退全量装载（响应带
        fallback_full 标记），语义与全量 load 完全一致。"""
        response = (await self._request({
            "op": "sync_index_from_database",
            "owner_id": str(owner_user_id),
            "revision": str(revision or ""),
            "vector_version": str(vector_version or ""),
        }, timeout_seconds=BUILD_TIMEOUT_SECONDS)).response
        self._revision = str(response.get("revision") or "")
        self._document_count = int(response.get("document_count") or 0)
        self._estimated_bytes = int(response.get("estimated_bytes") or 0)
        self._vector_count = int(response.get("vector_count") or 0)
        self._vector_version = str(response.get("vector_version") or "")
        self._restore_error = None
        return response

    async def load_vectors_from_storage(self, owner_user_id: object, vector_version: str) -> dict:
        """TS worker 从 owner 存储读取向量缓存并按当前索引文档键装载。"""
        response = (await self._request({
            "op": "load_vectors_from_storage",
            "owner_id": str(owner_user_id),
            "vector_version": str(vector_version or ""),
        }, timeout_seconds=BUILD_TIMEOUT_SECONDS)).response
        self._vector_count = int(response.get("vector_count") or 0)
        self._vector_version = str(response.get("vector_version") or "")
        return response

    async def prepare_memory(
        self, owner_user_id: object, scopes: list[Scope], *, source_filter: str,
        snapshot_revision: str = "", snapshot_text: str = "", vector_version: str = "",
        force: bool = False,
    ) -> dict:
        """TS 读取 Memory 文件、scope 状态和缓存向量；Python 只传 ACL 已确认的 scope。"""
        wire_scopes = []
        owner = str(owner_user_id)
        for scope in scopes:
            if str(scope.owner_user_id) != owner:
                raise ValueError("Memory scope owner 与 sidecar owner 不一致")
            if scope.scope_type == "owner":
                wire_scopes.append({"ownerId": owner, "type": "owner", "id": owner})
                continue
            if scope.scope_type not in {"group", "member"}:
                raise ValueError("Memory scope 类型不受 TS Memory Loader 支持")
            wire_scopes.append({
                "ownerId": owner,
                "type": scope.scope_type,
                "id": str(scope.scope_id),
                "platform": str(scope.platform or ""),
                "botId": str(scope.bot_id or ""),
                "groupId": str(scope.group_id or ""),
            })
        response = (await self._request({
            "op": "prepare_memory",
            "owner_id": owner,
            "scopes": wire_scopes,
            "source_filter": str(source_filter or "all"),
            "snapshot_revision": str(snapshot_revision or ""),
            "snapshot_text": str(snapshot_text or ""),
            "vector_version": str(vector_version or ""),
            "force": bool(force),
        }, timeout_seconds=BUILD_TIMEOUT_SECONDS)).response
        self._transient_revision = str(response.get("transient_revision") or "")
        self._transient_generation = self._process_generation
        return response

    async def set_vectors(
        self, vectors: dict[str, list[float]], vector_version: str,
    ) -> None:
        """替换当前持久索引的向量侧车映射；不传输 source document 正文。"""
        await self._request({
            "op": "set_vectors", "vectors": vectors,
            "vector_version": vector_version,
        }, timeout_seconds=BUILD_TIMEOUT_SECONDS)

    async def adapt_records(self, source_type: str, records: list[dict]) -> list[dict]:
        """TS 来源适配器投影：统一 source record → wire 文档；只做投影，不触碰索引。"""
        result = await self._request({
            "op": "adapt", "source_type": source_type, "records": records,
        }, timeout_seconds=BUILD_TIMEOUT_SECONDS)
        return list(result.response.get("documents") or [])

    async def build_and_index(self, batch: dict[str, list[dict]], revision: str) -> dict:
        """在 TS worker 内完成 source projection、分块和索引更新，避免回传完整文档。"""
        return (await self._request({
            "op": "build_and_index", "revision": revision, "batch": batch,
        }, timeout_seconds=BUILD_TIMEOUT_SECONDS)).response

    async def patch(
        self,
        upserts: list[IndexDocument],
        deletes: list[str],
        revision: str | None,
        base_revision: str | None,
        *,
        vectors: dict[str, list[float]] | None = None,
        vector_version: str = "",
        storage_owner_id: object | None = None,
    ) -> dict:
        """只同步发生变化的 chunk，保持 worker 的 revision 原子推进。

        vectors 与 replace 同语义：整表搭载当前持久向量映射，worker 整表覆盖。
        """
        payload: dict[str, Any] = {
            "op": "patch",
            "revision": revision or "",
            "base_revision": base_revision or "",
            "upserts": [_wire_document(document) for document in upserts],
            "deletes": list(deletes),
        }
        if vectors is not None:
            payload["vectors"] = vectors
            payload["vector_version"] = vector_version
        if storage_owner_id is not None:
            if str(storage_owner_id) != self.owner_user_id:
                raise ValueError("向量缓存 owner 与 sidecar owner 不一致")
            payload["vector_cache"] = {
                "owner_id": self.owner_user_id,
                "vector_version": str(vector_version or ""),
            }
        result = await self._request(payload, timeout_seconds=BUILD_TIMEOUT_SECONDS)
        response = result.response
        self._revision = response.get("revision")
        self._document_count = int(response.get("document_count") or 0)
        self._vector_count = int(response.get("vector_count") or 0)
        self._vector_version = str(response.get("vector_version") or "")
        self._restore_error = None
        return response

    async def replace_transient(
        self,
        documents: list[IndexDocument],
        revision: str,
        *,
        vectors: dict[str, list[float]] | None = None,
        vector_version: str = "",
        force: bool = False,
    ) -> None:
        """把 Memory 快照语料装入 worker 的瞬态槽；指纹未变且进程未重启时零 IPC。

        vectors 按 worker 文档键驻留瞬态槽（随语料上传，不随查询重复传输）；
        revision 必须耦合 embedding 模型版本戳，换模型时必然重传。``force=True``
        跳过「指纹未变」短路，用于 revision 不一致重试时不信任进程内残留状态。
        """
        generation = self._process_generation
        if self._process is None or self._process.returncode is not None:
            # 进程已死亡：_ensure_process 重启时会递增代数并清空瞬态状态。
            # 短路判断必须先按新代数失效，否则残留的旧 revision 会误判「已加载」
            # 跳过重传，worker 新进程瞬态槽为空，下一次查询报版本不一致。
            self._transient_revision = None
            generation += 1
        if not force and self._transient_revision == revision and self._transient_generation == generation:
            return
        payload: dict[str, Any] = {
            "op": "replace_transient", "revision": revision,
            "documents": [_wire_document(document) for document in documents],
        }
        if vectors is not None:
            payload["vectors"] = vectors
            payload["vector_version"] = vector_version
        result = await self._request(payload, timeout_seconds=BUILD_TIMEOUT_SECONDS)
        self._transient_revision = str(result.response.get("revision") or revision)
        self._transient_generation = generation

    async def hybrid_fuse(
        self,
        hits: list[RecallResult],
        *,
        query_vector: list[float] | None,
        vector_map: dict[str, list[float]],
        limit: int,
        lexical_weight: float,
        vector_weight: float,
        rrf_k: int,
        vector_version: str,
    ) -> tuple[list[RecallResult], str | None, dict]:
        """Phase 3：把 BM25 与 embedding 的 RRF 融合交给 TS worker 执行。

        hits 即词法候选（顺序即词法名次）；只回传候选命中的向量。返回
        (结果, fallback_reason, 诊断)；语义与 Python ``hybrid_results`` 逐位一致。
        """
        if not query_vector or not vector_map or not any(
                vector_map.get(item.document.chunk_id) for item in hits):
            # 退化输入：无查询向量/空缓存 → 透传；缓存存在但命中均无可用向量 →
            # 纯词法 RRF 重打分。与 Python hybrid_results 逐位一致，也避免
            # 把整份向量表搬进 IPC（此时 vector_scores 必为空，documents 无关）。
            final, fallback = hybrid_results(hits, [], query_vector, vector_map, limit=limit)
            return final, fallback, {
                "fusion": "bm25", "vector_doc_count": 0, "vector_version": vector_version,
            }
        payload_vectors = {
            item.document.chunk_id: vector_map[item.document.chunk_id]
            for item in hits
            if vector_map.get(item.document.chunk_id)
        }
        response = (await self._request({
            "op": "hybrid_fuse",
            "hits": [{"chunk_id": item.document.chunk_id, "score": item.score} for item in hits],
            "query_vector": list(query_vector or []),
            "vectors": payload_vectors,
            "limit": max(1, int(limit)),
            "lexical_weight": lexical_weight,
            "vector_weight": vector_weight,
            "rrf_k": rrf_k,
            "vector_version": vector_version,
        }, timeout_seconds=_timeout_seconds())).response
        results_by_key = {item.document.chunk_id: item for item in hits}
        ordered = []
        for row in response.get("results") or []:
            item = results_by_key.get(str(row.get("chunk_id") or ""))
            if item is not None:
                ordered.append(RecallResult(item.document, float(row.get("score") or 0.0)))
        return ordered, response.get("fallback"), {
            "fusion": str(response.get("fusion") or ""),
            "vector_doc_count": str(int(response.get("vector_doc_count") or 0)),
            "vector_version": str(response.get("vector_version") or ""),
        }

    async def reuse_if_current(self, revision: str | None) -> bool:
        self.touch()
        self._active_requests += 1
        try:
            await self._ensure_process()
            expected = revision or ""
            return bool(
                self.index_dir
                and self._revision == expected
                and (self._document_count > 0 or not expected)
            )
        finally:
            self._active_requests -= 1
            self.touch()

    async def search(
        self,
        query: str,
        *,
        documents: dict[str, IndexDocument],
        source_types: Iterable[str] = (),
        scope: Scope | None = None,
        limit: int = 10,
    ) -> list[RecallResult]:
        results, _timing = await self.search_with_timing(
            query, documents=documents, source_types=source_types, scope=scope, limit=limit,
        )
        return results

    async def search_with_timing(
        self,
        query: str,
        *,
        documents: dict[str, IndexDocument],
        source_types: Iterable[str] = (),
        scope: Scope | None = None,
        limit: int = 10,
    ) -> tuple[list[RecallResult], SidecarRequestTiming]:
        source_type_set = set(source_types)
        result = await self._request({
            "op": "search",
            "revision": self._revision or "",
            # 原文交给 TS worker；索引和查询必须由同一个 TS tokenizer 处理。
            "query": query,
            "limit": max(1, min(int(limit), 50)),
            "source_types": sorted(source_type_set),
            **({"scope": {
                "platform": scope.platform,
                "bot_id": scope.bot_id,
                "group_id": scope.group_id,
                "scope_type": scope.scope_type,
                "scope_id": scope.scope_id,
            }} if scope is not None else {}),
        })
        response = result.response
        self.last_search_diagnostics = dict(response.get("diagnostics") or {})
        results: list[RecallResult] = []
        for item in response.get("results") or []:
            document = documents.get(str(item.get("id")))
            if document is None and isinstance(item.get("document"), dict):
                document = _from_wire_document(item["document"], self.owner_user_id)
            if document is None:
                continue
            if source_type_set and document.source_type not in source_type_set:
                continue
            if scope is not None and not matches_scope(document, scope):
                continue
            results.append(RecallResult(document, float(item.get("score") or 0)))
        return results, result.timing

    async def rank_candidates(
        self, query: str, candidates: list[dict], *, limit: int,
        max_chars: int, max_per_source: int, max_per_parent: int,
        exclude_content_hashes: set[str] | None = None,
        selection_mode: str = "confidence",
        scoring_version: str = "confidence-v4",
        corpus_documents: list[dict] | None = None,
    ) -> tuple[list[dict], dict]:
        """调用 TS 完成来源归一化、confidence 过滤和统一预算。"""
        response = (await self._request({
            "op": "rank_candidates",
            "query": query,
            "candidates": candidates,
            "limit": max(1, int(limit)),
            "max_chars": max(1, int(max_chars)),
            "max_per_source": max(1, int(max_per_source)),
            "max_per_parent": max(1, int(max_per_parent)),
            "exclude_content_hashes": sorted(exclude_content_hashes or set()),
            "selection_mode": selection_mode,
            "scoring_version": scoring_version,
            **({"corpus_documents": corpus_documents} if corpus_documents is not None else {}),
        })).response
        return list(response.get("selected") or []), dict(response.get("stats") or {})

    async def close(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=1)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    async def _request(self, payload: dict, *, timeout_seconds: float | None = None) -> SidecarRequestResult:
        """传输入口（模板方法）：锁/计时/probe 外壳共享，实际连接由三个可覆写点决定。

        - ``_prepare_for_send``：确保传输就绪（基类=spawn/复用子进程并 ping 探活）；
        - ``_transact``：单行请求/单行响应（基类=stdio）；
        - ``_absorb_state``：把响应状态写回 client（基类只回写 revision；
          socket 代理用宿主下发的 state 镜像整体覆盖）。
        SocketSidecarClient 只覆写这三个点 + 三个状态语义方法，所有 payload
        构造与基类共用一份，杜绝双份实现漂移。
        """
        queued_at = asyncio.get_running_loop().time()
        probe_enabled = payload.get("op") == "unified_query"
        from agent.rag.observation import probe_finish, probe_start, probe_update

        if probe_enabled:
            probe_start("sidecar_lock_wait")
        async with self._lock:
            request_started = asyncio.get_running_loop().time()
            queue_wait_ms = int((request_started - queued_at) * 1000)
            if probe_enabled:
                probe_finish("sidecar_lock_wait", queued_at, queue_wait_ms=queue_wait_ms)
                probe_start("sidecar_process_start")
            ensure_started = asyncio.get_running_loop().time()
            self.touch()
            self._active_requests += 1
            try:
                await self._prepare_for_send()
                ensure_process_ms = int((asyncio.get_running_loop().time() - ensure_started) * 1000)
                if probe_enabled:
                    probe_finish("sidecar_process_start", ensure_started,
                                 ensure_process_ms=ensure_process_ms)
                    probe_start("sidecar_worker_response")
                response_started = asyncio.get_running_loop().time()
                response = await self._transact(payload, timeout_seconds=timeout_seconds)
                response_wait_ms = int((asyncio.get_running_loop().time() - response_started) * 1000)
                query_ms = int(
                    (asyncio.get_running_loop().time() - request_started) * 1000
                ) if payload.get("op") in {"search", "batch_search", "unified_query"} else 0
                if probe_enabled:
                    probe_finish("sidecar_worker_response", response_started,
                                 response_wait_ms=response_wait_ms)
                    probe_update(sidecar={
                        "queue_wait_ms": queue_wait_ms,
                        "ensure_process_ms": ensure_process_ms,
                        "response_wait_ms": response_wait_ms,
                        "query_ms": query_ms,
                    })
                response = self._absorb_state(payload, response)
                return SidecarRequestResult(
                    response=response,
                    timing=SidecarRequestTiming(
                        queue_wait_ms=queue_wait_ms, query_ms=query_ms,
                        ensure_process_ms=ensure_process_ms, response_wait_ms=response_wait_ms,
                    ),
                )
            finally:
                self._active_requests -= 1
                self.touch()

    async def _prepare_for_send(self) -> None:
        await self._ensure_process()

    async def _transact(self, payload: dict, *, timeout_seconds: float | None = None) -> dict:
        return await self._request_unlocked(payload, timeout_seconds=timeout_seconds)

    def _absorb_state(self, payload: dict, response: dict) -> dict:
        # 只有持久索引类响应才代表 worker 的 state.revision。replace_transient 回的是
        # 瞬态槽指纹，写进 _revision 会让 reuse_if_current 误判持久索引已同步、把
        # 后续每次查询退化成全量重建（2026-09-11 修）。
        if response.get("revision") is not None and payload.get("op") != "replace_transient":
            self._revision = response.get("revision")
        return response

    async def _ensure_process(self) -> None:
        if self._process is not None and self._process.returncode is None:
            return
        command = _worker_command(self.command, self.index_dir, self.owner_user_id)
        if not command:
            raise TsSidecarUnavailable("TypeScript RAG worker 未配置")
        try:
            worker_env = os.environ.copy()
            worker_env["GUGU_RAG_OWNER_ID"] = self.owner_user_id
            try:
                from app.core.config import get_settings

                runtime_settings = get_settings()
                database_url = str(runtime_settings.db.url)
                if database_url.startswith("postgresql+asyncpg://"):
                    database_url = database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
                worker_env["GUGU_DATABASE_URL"] = database_url
                worker_env["GUGU_STORAGE_BACKEND"] = str(runtime_settings.storage.backend or "local")
                if runtime_settings.storage.backend == "local":
                    worker_env["GUGU_STORAGE_ROOT"] = str(
                        Path(runtime_settings.storage.local_path).expanduser().resolve()
                    )
                elif runtime_settings.storage.backend == "oss":
                    # 凭据只通过 worker 私有环境传递，不进入 argv、JSONL 或日志。
                    worker_env["GUGU_OSS_ACCESS_KEY_ID"] = str(runtime_settings.storage.oss_access_key_id or "")
                    worker_env["GUGU_OSS_ACCESS_KEY_SECRET"] = str(runtime_settings.storage.oss_access_key_secret or "")
                    worker_env["GUGU_OSS_BUCKET"] = str(runtime_settings.storage.oss_bucket or "")
                    worker_env["GUGU_OSS_ENDPOINT"] = str(runtime_settings.storage.oss_endpoint or "")
                    worker_env["GUGU_OSS_PREFIX"] = str(runtime_settings.storage.oss_prefix or "")
            except Exception:
                # 旧查询/排序 op 不依赖数据库环境；TS-owned index op 会显式失败，
                # 不把配置加载错误伪装成空索引。
                pass
            self._process = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=worker_env,
                # 批量查询的 JSONL 响应聚合多来源候选原文，单行远超默认 64KB。
                limit=SIDECAR_STREAM_LIMIT_BYTES,
            )
            # 新进程里瞬态语料为空：递增代数让下次 replace_transient 必然重传。
            self._process_generation += 1
            self._transient_revision = None
            # 原生 Jieba 首次加载词典可能超过查询超时；启动探活使用独立上限，
            # 避免 worker 已启动但被 500ms 查询超时误判为不可用。
            response = await self._request_unlocked({"op": "ping"}, timeout_seconds=5.0)
            self._revision = response.get("revision") or self._revision
            self._document_count = int(response.get("document_count") or 0)
            self._vector_version = str(response.get("vector_version") or "")
            self._restore_error = response.get("restore_error") or None
            _record_worker_restore_probe(response)
        except (OSError, asyncio.TimeoutError, TsSidecarUnavailable) as error:
            await self.close()
            if isinstance(error, TsSidecarUnavailable):
                raise
            raise TsSidecarUnavailable("TypeScript RAG worker 启动失败") from error

    async def _request_unlocked(self, payload: dict, *, timeout_seconds: float | None = None) -> dict:
        assert self._process is not None
        assert self._process.stdin is not None and self._process.stdout is not None
        try:
            self._process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode())
            await self._process.stdin.drain()
            line = await asyncio.wait_for(
                self._process.stdout.readline(),
                timeout=timeout_seconds if timeout_seconds is not None else _timeout_seconds(),
            )
        except (BrokenPipeError, ConnectionError, ValueError, asyncio.TimeoutError,
                RuntimeError) as error:
            # ValueError 是 readline 的流上限保护：半行残留会让后续响应错位。
            # RuntimeError 是 wait_for 取消 readline 后流读取者残留的竞态
            # （readuntil already waiting）。两者都意味着这条连接的响应流已不可信，
            # 必须整条连接关闭重来，不能当作单次失败吞掉。
            await self.close()
            raise TsSidecarUnavailable("TypeScript RAG worker 请求失败") from error
        if not line:
            await self.close()
            raise TsSidecarUnavailable("TypeScript RAG worker 已退出")
        try:
            response = json.loads(line)
        except json.JSONDecodeError as error:
            raise TsSidecarUnavailable("TypeScript RAG worker 返回无效 JSON") from error
        if response.get("status") == "error":
            raise TsSidecarUnavailable(
                str(response.get("message") or response.get("code") or "worker error"),
                code=str(response.get("code") or "") or None,
            )
        return response


RANK_SOCKET_OWNER = "__rank__"


def _sidecar_socket_path() -> str:
    """gugu-rag-sidecar 宿主 socket 配置；空串=未启用，走进程内 spawn。"""
    try:
        from app.core.config import get_settings

        return str(getattr(get_settings().search, "ts_sidecar_socket", "") or "")
    except Exception:
        return ""


def _client_state_mirror(client: "TsSidecarClient") -> dict[str, Any]:
    """从 client 导出跨进程镜像块；宿主下发、代理回填，字段与 client 状态一一对应。"""
    return {
        "revision": client._revision,
        "document_count": int(client._document_count or 0),
        "estimated_bytes": int(client._estimated_bytes or 0),
        "vector_count": int(client._vector_count or 0),
        "vector_version": str(client._vector_version or ""),
        "restore_error": client._restore_error,
        "transient_revision": client._transient_revision,
        "transient_generation": int(client._transient_generation),
        "process_generation": int(client._process_generation),
    }


class SocketSidecarClient(TsSidecarClient):
    """经 gugu-rag-sidecar 宿主共享的常驻 worker 连接。

    与基类共享全部 payload 构造；只把传输换成 unix socket，并让「状态归属权」
    移交宿主：revision/瞬态指纹/进程代数以宿主下发镜像为准，
    ``reuse_if_current`` 与 ``replace_transient`` 的短路判定也在宿主侧执行
    （判定依据是宿主内真实 worker 进程的状态，跨进程读不到才需要走 IPC）。
    """

    def __init__(self, owner_user_id: object, *, socket_path: str,
                 command: str = "", index_dir: str = ""):
        super().__init__(owner_user_id, command=command, index_dir=index_dir)
        self.socket_path = socket_path
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._mirror: dict[str, Any] = {}

    async def _prepare_for_send(self) -> None:
        if self._writer is not None and not self._writer.is_closing():
            return
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self.socket_path, limit=SIDECAR_STREAM_LIMIT_BYTES),
                timeout=5.0,
            )
        except (OSError, asyncio.TimeoutError) as error:
            self._reader = None
            self._writer = None
            raise TsSidecarUnavailable("sidecar 宿主 socket 不可用") from error

    async def _transact(self, payload: dict, *, timeout_seconds: float | None = None) -> dict:
        assert self._writer is not None and self._reader is not None
        timeout = timeout_seconds if timeout_seconds is not None else _timeout_seconds()
        envelope = {
            "v": 1,
            "req_id": uuid.uuid4().hex,
            "owner": self.owner_user_id,
            "timeout_ms": int(max(0.05, timeout) * 1000),
            "payload": payload,
        }
        try:
            self._writer.write((json.dumps(envelope, ensure_ascii=False) + "\n").encode())
            await self._writer.drain()
            line = await asyncio.wait_for(self._reader.readline(), timeout=max(0.05, timeout) + 5.0)
        except (BrokenPipeError, ConnectionError, ValueError, asyncio.TimeoutError,
                RuntimeError) as error:
            # 与基类同一原则：半行残留/竞态会让响应流不可信，整条连接作废。
            await self.close()
            raise TsSidecarUnavailable("sidecar 宿主请求失败") from error
        if not line:
            await self.close()
            raise TsSidecarUnavailable("sidecar 宿主连接已断开")
        try:
            response = json.loads(line)
        except json.JSONDecodeError as error:
            raise TsSidecarUnavailable("sidecar 宿主返回无效 JSON") from error
        if response.get("status") == "error":
            raise TsSidecarUnavailable(
                str(response.get("message") or response.get("code") or "sidecar error"),
                code=str(response.get("code") or "") or None,
            )
        self._mirror = dict(response.get("state") or {})
        return dict(response.get("payload") or {})

    def _absorb_state(self, payload: dict, response: dict) -> dict:
        # 状态归属在宿主：镜像整体覆盖，方法体内的局部回写随后发生，
        # 但它们的取值来自宿主透传的真实 worker 响应字段，与镜像一致。
        state = self._mirror
        self._revision = state.get("revision")
        self._document_count = int(state.get("document_count") or 0)
        self._estimated_bytes = int(state.get("estimated_bytes") or 0)
        self._vector_count = int(state.get("vector_count") or 0)
        self._vector_version = str(state.get("vector_version") or "")
        self._restore_error = state.get("restore_error") or None
        self._transient_revision = state.get("transient_revision")
        self._transient_generation = int(state.get("transient_generation") if
                                         state.get("transient_generation") is not None else -1)
        self._process_generation = int(state.get("process_generation") or 0)
        return response

    async def reuse_if_current(self, revision: str | None) -> bool:
        # 判定依据是宿主内真实 worker 的状态（含 ensure/磁盘恢复），本进程镜像不可信。
        result = await self._request(
            {"op": "reuse_if_current", "revision": revision or ""},
            timeout_seconds=BUILD_TIMEOUT_SECONDS,
        )
        return bool(result.response.get("ok"))

    async def prepare_memory(self, owner_user_id: object, scopes: list[Scope], *, source_filter: str,
                             snapshot_revision: str = "", snapshot_text: str = "",
                             vector_version: str = "", force: bool = False) -> dict:
        response = await super().prepare_memory(
            owner_user_id, scopes, source_filter=source_filter,
            snapshot_revision=snapshot_revision, snapshot_text=snapshot_text,
            vector_version=vector_version, force=force,
        )
        # 基类用本进程 _process_generation 回填瞬态代数；代理进程恒为 0，
        # 必须以宿主镜像为准，否则下次短路口径错位。
        self._transient_generation = int(self._mirror.get("transient_generation") or 0)
        return response

    async def replace_transient(
        self,
        documents: list[IndexDocument],
        revision: str,
        *,
        vectors: dict[str, list[float]] | None = None,
        vector_version: str = "",
        force: bool = False,
    ) -> None:
        # 短路判定在宿主（它才看得到真实进程代数）：本进程不判，把 force 带下去。
        payload: dict[str, Any] = {
            "op": "replace_transient", "revision": revision, "force": bool(force),
            "documents": [_wire_document(document) for document in documents],
        }
        if vectors is not None:
            payload["vectors"] = vectors
            payload["vector_version"] = vector_version
        result = await self._request(payload, timeout_seconds=BUILD_TIMEOUT_SECONDS)
        self._transient_revision = str(result.response.get("revision") or revision)

    async def close(self) -> None:
        writer = self._writer
        self._writer = None
        self._reader = None
        if writer is None:
            return
        try:
            writer.close()
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass


class TsLexicalIndex:
    def __init__(self, documents: list[IndexDocument], client: TsSidecarClient, revision: str | None):
        self.documents = list(documents)
        self.documents_by_id = {_worker_document_key(document): document for document in documents}
        self.client = client
        self.revision = revision

    @property
    def document_count(self) -> int:
        """返回 TS worker 中的实际文档数；冷恢复时 Python 不必保留全量文档。"""
        return self.client._document_count if not self.documents else len(self.documents)

    @property
    def estimated_bytes(self) -> int:
        return self.client._estimated_bytes if not self.documents else 0

    async def batch_search(self, query: str, searches: list[dict], extra_documents: dict[str, IndexDocument] | None = None):
        """一次 IPC 返回逐来源候选，按每项 scope 再次校验。

        searches 项可带 ``corpus: "transient"`` 指向 Memory 快照语料槽；
        BM25 统计在 worker 内按语料槽独立计算，Memory 的候选分数与独立索引完全一致。
        """
        extra_documents = extra_documents or {}
        requests = []
        for position, item in enumerate(searches):
            scope = item.get("scope")
            requests.append({
                "id": str(position), "limit": item.get("limit", 20),
                "source_types": sorted(item.get("source_types", ())),
                **({"corpus": "transient"} if item.get("corpus") == "transient" else {}),
                **({"scope": {key: getattr(scope, key) for key in
                              ("platform", "bot_id", "group_id", "scope_type", "scope_id")}}
                   if scope is not None else {}),
            })
        response = await self.client._request({
            "op": "batch_search", "revision": self.revision or "", "query": query,
            **({"transient_revision": self.client._transient_revision or ""}
               if any(item.get("corpus") == "transient" for item in searches) else {}),
            "searches": requests,
        })
        raw_batches = response.response.get("batches", [])
        if [batch.get("id") for batch in raw_batches] != [item["id"] for item in requests]:
            raise TsSidecarUnavailable("TS 批量查询返回的来源标识不匹配")
        batches = []
        for spec, batch in zip(searches, raw_batches):
            results = []
            for raw in batch.get("results", []):
                document = self.documents_by_id.get(str(raw.get("id")))
                if document is None:
                    document = extra_documents.get(str(raw.get("id")))
                if document is None and isinstance(raw.get("document"), dict):
                    document = _from_wire_document(raw["document"], self.client.owner_user_id)
                if document is None or document.source_type not in spec["source_types"]:
                    continue
                if spec.get("scope") is not None and not matches_scope(document, spec["scope"]):
                    continue
                results.append(RecallResult(document, float(raw.get("score") or 0)))
            batches.append((results, batch.get("diagnostics", {})))
        return batches, response.response.get("document_counts", {}), response.timing

    async def unified_query(
        self,
        query: str,
        *,
        searches: list[dict],
        query_vector: list[float] | None,
        source_order: list[str],
        candidate_limit: int,
        rank_options: dict,
        before_message_id: int | None = None,
        vector_version: str | None = None,
    ) -> dict:
        """Phase 5 统一查询：一次 IPC 完成召回、聚合、水位、Memory 融合与排序。

        返回 worker 响应（selected/stats/fusion/document_counts/source_groups）；
        权限复核与注入组装仍由 Python 收口。vector_version 是 Python 当前生效的
        embedding 模型版本戳，worker 用它校验持久向量表是否同版，不匹配则非
        memory 组降级纯词法。
        """
        requests = []
        for position, item in enumerate(searches):
            scope = item.get("scope")
            requests.append({
                "id": str(position), "limit": candidate_limit,
                "source_types": sorted(item.get("source_types", ())),
                **({"corpus": "transient"} if item.get("corpus") == "transient" else {}),
                **({"scope": {key: getattr(scope, key) for key in
                              ("platform", "bot_id", "group_id", "scope_type", "scope_id")}}
                   if scope is not None else {}),
            })
        payload: dict[str, Any] = {
            "op": "unified_query", "revision": self.revision or "", "query": query,
            "query_vector": list(query_vector or []),
            "before_message_id": before_message_id,
            "source_order": list(source_order),
            "searches": requests,
            "candidate_limit": max(1, int(candidate_limit)),
            "rank": {
                "limit": int(rank_options["limit"]),
                "max_chars": int(rank_options["max_chars"]),
                "max_per_source": int(rank_options["max_per_source"]),
                "max_per_parent": int(rank_options["max_per_parent"]),
                "selection_mode": rank_options.get("selection_mode", "confidence"),
                "exclude_content_hashes": sorted(rank_options.get("exclude_content_hashes") or ()),
            },
        }
        if any(item.get("corpus") == "transient" for item in searches):
            payload["transient_revision"] = self.client._transient_revision or ""
        if vector_version:
            payload["vector_version"] = vector_version
        response = await self.client._request(payload)
        result = dict(response.response)
        result["_sidecar_timing"] = {
            "queue_wait_ms": response.timing.queue_wait_ms,
            "ensure_process_ms": response.timing.ensure_process_ms,
            "response_wait_ms": response.timing.response_wait_ms,
            "query_ms": response.timing.query_ms,
        }
        return result

    async def search(
        self, query: str, *, limit: int = 10, source_types: Iterable[str] = (), scope: Scope | None = None,
    ) -> list[RecallResult]:
        results, _timing = await self.search_with_timing(
            query, limit=limit, source_types=source_types, scope=scope,
        )
        return results

    async def search_with_timing(
        self, query: str, *, limit: int = 10, source_types: Iterable[str] = (), scope: Scope | None = None,
    ) -> tuple[list[RecallResult], SidecarRequestTiming]:
        return await self.client.search_with_timing(
            query, documents=self.documents_by_id, source_types=source_types, scope=scope, limit=limit,
        )


def _wire_document(document: IndexDocument) -> dict[str, Any]:
    text_parts = [document.title]
    if document.summary:
        text_parts.append(document.summary)
    text_parts.append(document.content)
    wire = {
        # worker 内部使用稳定的 chunk slot；版本变化只更新同一 slot 的内容，
        # 避免一个文档改动后把所有未变化 chunk 当成删除再新增。
        "id": _worker_document_key(document),
        # 保留原文，避免 Python 侧预分词导致 TS/Python 两套语义漂移。
        "text": "\n".join(text_parts),
        "source_id": document.source_id,
        "title": document.title,
        "summary": document.summary,
        "content": document.content,
        "source_type": document.source_type,
        "platform": document.scope.platform,
        "bot_id": document.scope.bot_id,
        "group_id": document.scope.group_id,
        "scope_type": document.scope.scope_type,
        "scope_id": document.scope.scope_id or "",
        "document_version": document.version or "",
        "parent_id": document.parent_document_id or "",
        "chunk_index": document.chunk_index,
        "chunk_count": document.chunk_count,
        "updated_at": document.updated_at,
        "metadata": document.metadata,
    }
    if document.source_type == "conversation":
        # 会话标题只用于展示；词法召回与重排只使用当前消息/摘要正文。
        wire["ranking_text"] = document.content
    if document.source_type == "conversation" and document.metadata.get("kind") == "message":
        context_text = document.contextual_content()
        if context_text:
            wire["context_text"] = context_text
    return wire


def _from_wire_document(raw: dict[str, Any], owner_user_id: str) -> IndexDocument | None:
    """从已持久化索引的命中结果恢复业务文档，不读取用户数据库。"""
    try:
        return IndexDocument(
            document_id=str(raw.get("id") or ""),
            source_type=str(raw.get("source_type") or ""),
            source_id=str(raw.get("source_id") or raw.get("id") or ""),
            scope=Scope(
                owner_user_id=owner_user_id,
                platform=str(raw.get("platform") or ""),
                bot_id=str(raw.get("bot_id") or ""),
                group_id=str(raw.get("group_id") or ""),
                scope_type=str(raw.get("scope_type") or "owner"),
                scope_id=str(raw.get("scope_id") or ""),
            ),
            title=str(raw.get("title") or ""),
            summary=str(raw.get("summary") or ""),
            content=str(raw.get("content") or raw.get("text") or ""),
            version=str(raw.get("document_version") or ""),
            chunk_index=int(raw.get("chunk_index") or 0),
            chunk_count=int(raw.get("chunk_count") or 1),
            parent_document_id=str(raw.get("parent_id") or "") or None,
            updated_at=str(raw.get("updated_at") or "") or None,
            metadata=raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {},
        )
    except (TypeError, ValueError):
        return None


def _worker_document_key(document: IndexDocument) -> str:
    """稳定 chunk 槽位；契约统一收口在 agent.rag.delta。"""
    from agent.rag.delta import chunk_slot_key
    return chunk_slot_key(document)


def scope_to_wire(scope: Scope) -> dict:
    """Scope → TS 适配器消费的 wire scope（空值统一为空串，与现网口径一致）。"""
    return {
        "scope_type": scope.scope_type or "owner",
        "scope_id": scope.scope_id or "",
        "platform": scope.platform or "",
        "bot_id": scope.bot_id or "",
        "group_id": scope.group_id or "",
    }


def wire_document_to_persistent(raw: dict[str, Any], owner_user_id: object) -> IndexDocument:
    """TS ``adapt`` wire 文档 → 持久 IndexDocument（写库通道，第③步）。

    与 ``_from_wire_document``（查询命中恢复，宽松）不同：写库通道对结构缺陷
    显式失败，不静默丢弃 chunk。document_id 取 ``parent_id``（单前缀持久口径），
    wire id（``_worker_document_key``）由 parent_id + chunk_index 可完整重建，
    模式切换不改变持久行身份。
    """
    parent = str(raw.get("parent_id") or "")
    if not parent:
        raise ValueError(f"TS 投影 wire 文档缺少 parent_id：{raw.get('id')}")
    content = raw.get("content")
    if content is None:
        raise ValueError(f"TS 投影 wire 文档缺少 content：{raw.get('id')}")
    metadata = raw.get("metadata")
    return IndexDocument(
        document_id=parent,
        source_type=str(raw.get("source_type") or ""),
        source_id=str(raw.get("source_id") or ""),
        scope=Scope(
            owner_user_id=str(owner_user_id),
            platform=str(raw.get("platform") or ""),
            bot_id=str(raw.get("bot_id") or ""),
            group_id=str(raw.get("group_id") or ""),
            scope_type=str(raw.get("scope_type") or "owner"),
            scope_id=str(raw.get("scope_id") or ""),
        ),
        title=str(raw.get("title") or ""),
        summary=str(raw.get("summary") or ""),
        content=str(content),
        version=str(raw.get("document_version") or ""),
        chunk_index=int(raw.get("chunk_index") or 0),
        chunk_count=int(raw.get("chunk_count") or 1),
        parent_document_id=parent,
        updated_at=str(raw.get("updated_at")) if raw.get("updated_at") is not None else None,
        metadata=dict(metadata) if isinstance(metadata, dict) else {},
    )


_lexical_clients: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, TsSidecarClient]] = weakref.WeakKeyDictionary()


def _index_document_digest(document: IndexDocument) -> str:
    """词法索引字段摘要；契约统一收口在 agent.rag.delta。"""
    from agent.rag.delta import document_digest
    return document_digest(document)


async def _probe_sidecar_socket(socket_path: str) -> bool:
    """轻量探活：socket 可连接才走共享宿主，否则回退进程内 spawn。"""
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(socket_path, limit=SIDECAR_STREAM_LIMIT_BYTES),
            timeout=2.0,
        )
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass
        return True
    except (OSError, asyncio.TimeoutError):
        return False


async def get_lexical_client(owner_user_id: object, *, command: str, index_dir: str) -> TsSidecarClient:
    """按 owner 复用常驻 TS worker；索引缓存淘汰不再立即杀掉进程。

    配置了 ``search.ts_sidecar_socket`` 时走共享宿主连接（多个 Python 进程
    共享同一份热索引）；socket 不可用则回退进程内 spawn 并记警告。
    """
    owner_key = str(owner_user_id)
    loop = asyncio.get_running_loop()
    _ensure_sidecar_reaper(loop)
    clients = _lexical_clients.setdefault(loop, {})
    client = clients.get(owner_key)
    if client is None:
        socket_path = _sidecar_socket_path()
        if socket_path and owner_key != RANK_SOCKET_OWNER:
            if await _probe_sidecar_socket(socket_path):
                client = SocketSidecarClient(
                    owner_key, socket_path=socket_path, command=command, index_dir=index_dir,
                )
            else:
                import logging

                logging.getLogger("agent.rag.sidecar").warning(
                    "sidecar socket 不可达，回退进程内 spawn owner=%s", owner_key[:8],
                )
        if client is None:
            client = TsSidecarClient(owner_key, command=command, index_dir=index_dir)
        clients[owner_key] = client
    client.touch()
    return client


_rank_clients: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, TsSidecarClient] = weakref.WeakKeyDictionary()


async def rank_candidates_with_cache(
    owner_user_id: object,
    query: str,
    candidates: list[RecallCandidate],
    *,
    limit: int,
    max_chars: int,
    max_per_source: int,
    max_per_parent: int,
    exclude_content_hashes: set[str] | None = None,
    selection_mode: str = "confidence",
    corpus_documents: list[IndexDocument] | None = None,
) -> tuple[list[tuple[RecallCandidate, str, dict]], dict]:
    """调用 TS 完成完整的候选评分、过滤、去重和预算。"""
    if not candidates:
        return [], {
            "candidate_count": 0, "accepted_count": 0,
            "rejected_duplicate": 0, "rejected_parent": 0,
            "rejected_source": 0, "rejected_similarity": 0,
            "output_chars": 0, "rejected_low_score": 0,
            "rejected_not_preferred": 0, "top_confidence": 0.0,
            "threshold": 0.35, "preferred_threshold": 0.55,
            "selection_mode": selection_mode,
            "scoring_version": _expected_scoring_version(),
        }
    from app.core.config import get_settings

    loop = asyncio.get_running_loop()
    _ensure_sidecar_reaper(loop)
    client = _rank_clients.get(loop)
    if client is None:
        settings = get_settings().search
        socket_path = _sidecar_socket_path()
        if socket_path and await _probe_sidecar_socket(socket_path):
            # 无状态 rank worker 同样托管在宿主上；全进程共享一个 __rank__ 通道。
            client = SocketSidecarClient(
                RANK_SOCKET_OWNER, socket_path=socket_path,
                command=settings.ts_sidecar_command, index_dir="",
            )
        else:
            client = TsSidecarClient(
                f"score:{id(loop)}", command=settings.ts_sidecar_command, index_dir="",
            )
        _rank_clients[loop] = client
    by_id: dict[str, RecallCandidate] = {}
    payload = []
    for index, candidate in enumerate(candidates):
        candidate_id = f"{candidate.source_type}:{candidate.document.chunk_id}:{index}"
        by_id[candidate_id] = candidate
        document = candidate.document
        rank_document = {
            "id": candidate_id,
            # 与持久化 TS 索引保持同一评分文本（标题/摘要/正文），避免独立
            # 候选排序链再次退回到与持久化索引不同的口径。
            "text": "\n".join(part for part in (document.title, document.summary, document.content) if part),
            # 跨轮排除使用 IndexDocument.content_hash；独立 rank 路径也必须
            # 把 canonical 正文传给 TS，不能只传用于 BM25 的拼接 text。
            "content": document.content,
            "source_type": document.source_type,
            "title": document.title,
            "summary": document.summary,
            "scope_type": document.scope.scope_type,
            "scope_id": document.scope.scope_id,
            "platform": document.scope.platform,
            "bot_id": document.scope.bot_id,
            "group_id": document.scope.group_id,
            "document_version": document.version,
            "parent_id": document.parent_document_id or document.document_id,
            "chunk_index": document.chunk_index,
            "chunk_count": document.chunk_count,
            "updated_at": document.updated_at,
            "metadata": document.metadata,
        }
        if document.source_type == "conversation":
            # 与 lexical worker 一致：自动会话标题不参与候选重排。
            rank_document["ranking_text"] = document.content
        if document.source_type == "conversation" and document.metadata.get("kind") == "message":
            context_text = document.contextual_content()
            if context_text:
                rank_document["context_text"] = context_text
        payload.append({
            "id": candidate_id,
            "source_type": candidate.source_type,
            "raw_score": candidate.raw_score,
            "fusion": "hybrid-rrf" if candidate.fused_score else "bm25",
            "fused_score": candidate.fused_score if candidate.fused_score else None,
            "document": rank_document,
        })
    scoring_version = _expected_scoring_version()
    selected, stats = await client.rank_candidates(
        query, payload, limit=limit, max_chars=max_chars,
        max_per_source=max_per_source, max_per_parent=max_per_parent,
        exclude_content_hashes=exclude_content_hashes,
        selection_mode=selection_mode,
        scoring_version=scoring_version,
        corpus_documents=([_wire_document(document) for document in corpus_documents]
                          if corpus_documents is not None else None),
    )
    # 冻结契约：TS 评分版本必须与配置一致；版本漂移说明出现了第二套评分
    # 或新旧实现混跑，显式失败而不是静默接受结果差异。
    version = str(stats.get("scoring_version") or "")
    if version != scoring_version:
        raise TsSidecarUnavailable(
            f"TS 评分器版本与 Python 契约不一致：{version or '缺失'} ≠ {scoring_version}")
    output = []
    for item in selected:
        candidate = by_id.get(str(item.get("id") or ""))
        if candidate is None:
            continue
        output.append((candidate, str(item.get("text") or ""), item))
    return output, stats


async def close_lexical_clients() -> None:
    """应用退出时统一关闭 owner 级常驻 lexical worker。"""
    clients = [client for group in _lexical_clients.values() for client in group.values()]
    _lexical_clients.clear()
    if clients:
        await asyncio.gather(*(client.close() for client in clients), return_exceptions=True)
    await _stop_sidecar_reaper_if_empty()


async def close_rank_clients() -> None:
    """应用退出时关闭共享的 TS 候选排序 worker。"""
    clients = list(_rank_clients.values())
    _rank_clients.clear()
    if clients:
        await asyncio.gather(*(client.close() for client in clients), return_exceptions=True)
    await _stop_sidecar_reaper_if_empty()


_sidecar_reaper_tasks: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Task] = weakref.WeakKeyDictionary()


def _ensure_sidecar_reaper(loop: asyncio.AbstractEventLoop) -> None:
    task = _sidecar_reaper_tasks.get(loop)
    if task is None or task.done():
        _sidecar_reaper_tasks[loop] = loop.create_task(_reap_idle_sidecars(loop))


def _take_idle_sidecars(
    loop: asyncio.AbstractEventLoop, *, now: float | None = None,
) -> list[TsSidecarClient]:
    """从两种注册表中摘除空闲 client，返回交给调用方关闭的实例。"""
    idle_clients: list[TsSidecarClient] = []
    lexical_clients = _lexical_clients.get(loop, {})
    for key, client in list(lexical_clients.items()):
        if not client.is_idle(now):
            continue
        # 只有注册表仍指向同一个实例时才删除，避免并发重建时误删新 client。
        if lexical_clients.get(key) is client:
            lexical_clients.pop(key, None)
            idle_clients.append(client)

    # 排序 worker 是每个 event loop 一个实例，不是 owner -> client 映射。
    rank_client = _rank_clients.get(loop)
    if rank_client is not None and rank_client.is_idle(now):
        if _rank_clients.get(loop) is rank_client:
            _rank_clients.pop(loop, None)
            idle_clients.append(rank_client)
    return idle_clients


async def _reap_idle_sidecars(loop: asyncio.AbstractEventLoop) -> None:
    """回收连续空闲 30 分钟的 worker；不影响活跃请求。"""
    current = asyncio.current_task()
    try:
        while True:
            await asyncio.sleep(SIDE_CAR_REAPER_INTERVAL_SECONDS)
            idle_clients = _take_idle_sidecars(loop)
            if idle_clients:
                await asyncio.gather(*(client.close() for client in idle_clients), return_exceptions=True)
            if not _lexical_clients.get(loop) and not _rank_clients.get(loop):
                return
    finally:
        if _sidecar_reaper_tasks.get(loop) is current:
            _sidecar_reaper_tasks.pop(loop, None)


async def _stop_sidecar_reaper_if_empty() -> None:
    loop = asyncio.get_running_loop()
    if _lexical_clients.get(loop) or _rank_clients.get(loop):
        return
    task = _sidecar_reaper_tasks.pop(loop, None)
    if task is not None and task is not asyncio.current_task():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def _default_artifact() -> Path:
    """打包制品路径：运行环境只消费 bin 下的固定构建物（见 backend/ts/README.md）。"""
    return Path(__file__).resolve().parents[2] / "bin" / "gugu-rag-ts-worker.mjs"


def _resolve_artifact(command: str) -> Path | None:
    """从 worker 启动命令里取制品文件；未配置命令时用打包默认制品。

    命令形如 ``node <artifact> [args...]``，逐个 token 找第一个真实存在的文件，
    这样制品后面再挂参数也能定位；都不存在返回 None。
    """
    parts = shlex.split(command.strip()) if command.strip() else []
    for part in parts:
        candidate = Path(part).expanduser()
        if candidate.is_file():
            return candidate
    fallback = _default_artifact()
    return fallback if fallback.is_file() else None


def worker_artifact_version() -> str | None:
    """读当前 worker 制品的版本戳，供磁盘索引的旧版本清理比对。

    运行时并不逐次校验这个版本（逐次校验的是评分契约 scoring_version），这里只
    用于识别「旧制品写下的、当前 worker 已经会丢弃重建的」索引目录。取不到返回
    None，调用方必须按「未知」处理，不能当成需要删除。
    """
    from app.core.config import get_settings

    configured = str(getattr(get_settings().search, "ts_sidecar_command", "") or "")
    artifact = _resolve_artifact(configured)
    if artifact is None:
        return None
    try:
        # 制品是 esbuild 单文件产物，版本常量在文件头部；只读前几 KB。
        with artifact.open("rb") as handle:
            head = handle.read(8192)
    except OSError:
        return None
    match = _ARTIFACT_VERSION_RE.search(head)
    return match.group(1).decode("utf-8", "replace") if match else None


def _worker_command(command: str, index_dir: str, owner_user_id: str) -> list[str]:
    configured = command.strip()
    if not configured:
        packaged = _default_artifact()
        configured = f"node {shlex.quote(str(packaged))}" if packaged.is_file() else ""
    parts = shlex.split(configured) if configured else []
    if index_dir:
        owner_hash = hashlib.sha256(owner_user_id.encode("utf-8")).hexdigest()[:32]
        parts.append(str(Path(index_dir).expanduser() / owner_hash))
    return parts


def active_index_dirs() -> set[Path]:
    """返回当前进程仍持有的持久化索引目录，供磁盘 GC 避免误删活跃索引。"""
    active: set[Path] = set()
    for clients in _lexical_clients.values():
        for client in clients.values():
            if client._process is not None and client._process.returncode is None and client.index_dir:
                owner_hash = hashlib.sha256(client.owner_user_id.encode("utf-8")).hexdigest()[:32]
                active.add(Path(client.index_dir).expanduser() / owner_hash)
    return active


# 冻结的统一评分契约版本（见 docs/prds/PRD-RAG-7 Phase 2）；与
# ts/workers/rag/src/service.ts 的 scoring_version 必须同步演进。
RANK_SCORING_VERSION = "confidence-v4"


def _expected_scoring_version() -> str:
    """回滚开关：search.ts_rank_scoring_version 决定期望的 TS 评分版本。"""
    from app.core.config import get_settings
    return str(getattr(get_settings().search, "ts_rank_scoring_version", "") or RANK_SCORING_VERSION)


def _timeout_seconds() -> float:
    from app.core.config import get_settings

    value = getattr(get_settings().search, "ts_sidecar_timeout_ms", 5000)
    return max(0.05, min(int(value), 30_000) / 1000)


__all__ = [
    "TsLexicalIndex", "TsSidecarClient", "TsSidecarUnavailable",
    "SocketSidecarClient", "RANK_SOCKET_OWNER",
    "rank_candidates_with_cache",
    "RANK_SCORING_VERSION",
    "SIDE_CAR_IDLE_TTL_SECONDS",
    "BUILD_TIMEOUT_SECONDS",
    "SIDECAR_STREAM_LIMIT_BYTES",
    "get_lexical_client", "close_lexical_clients", "close_rank_clients", "index_dir_for_owner",
    "worker_artifact_version",
]
