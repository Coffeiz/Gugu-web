"""TypeScript RAG worker 的异步 JSONL 客户端。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
import weakref
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent.rag.models import IndexDocument, RecallCandidate, RecallResult, Scope
from agent.rag.scope import matches_scope


class TsSidecarUnavailable(RuntimeError):
    """TS worker 未配置、启动失败或协议请求失败。"""


@dataclass(frozen=True)
class SidecarRequestTiming:
    """一次 sidecar 请求自己的计时，不挂在共享 owner client 上。"""

    queue_wait_ms: int = 0
    query_ms: int = 0


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
SIDE_CAR_REAPER_INTERVAL_SECONDS = 60


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
        self.last_search_diagnostics: dict[str, Any] = {}
        self._last_used_at = asyncio.get_running_loop().time()
        self._active_requests = 0

    def touch(self) -> None:
        """刷新 worker 空闲 TTL；TTL 不会打断正在执行的请求。"""
        self._last_used_at = asyncio.get_running_loop().time()

    def is_idle(self, now: float | None = None) -> bool:
        current = now if now is not None else asyncio.get_running_loop().time()
        return self._active_requests == 0 and current - self._last_used_at >= SIDE_CAR_IDLE_TTL_SECONDS

    async def replace(self, documents: list[IndexDocument], revision: str | None) -> None:
        result = await self._request({
            "op": "replace",
            "revision": revision or "",
            "documents": [_wire_document(document) for document in documents],
        })
        response = result.response
        self._revision = response.get("revision")
        self._document_count = int(response.get("document_count") or len(documents))

    async def build_documents(self, batch: dict[str, list[dict]]) -> list[dict]:
        """让 TS builder 从统一 source batch 生成 canonical 文档；不读取业务数据库。"""
        response = (await self._request({"op": "build_documents", "batch": batch})).response
        return list(response.get("documents") or [])

    async def build_and_index(self, batch: dict[str, list[dict]], revision: str) -> dict:
        """在 TS worker 内完成 source projection、分块和索引更新，避免回传完整文档。"""
        return (await self._request({
            "op": "build_and_index", "revision": revision, "batch": batch,
        })).response

    async def patch(
        self,
        upserts: list[IndexDocument],
        deletes: list[str],
        revision: str | None,
        base_revision: str | None,
    ) -> None:
        """只同步发生变化的 chunk，保持 worker 的 revision 原子推进。"""
        result = await self._request({
            "op": "patch",
            "revision": revision or "",
            "base_revision": base_revision or "",
            "upserts": [_wire_document(document) for document in upserts],
            "deletes": list(deletes),
        })
        response = result.response
        self._revision = response.get("revision")
        self._document_count = int(response.get("document_count") or 0)

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

    async def _request(self, payload: dict) -> SidecarRequestResult:
        queued_at = asyncio.get_running_loop().time()
        async with self._lock:
            request_started = asyncio.get_running_loop().time()
            queue_wait_ms = int((request_started - queued_at) * 1000)
            self.touch()
            self._active_requests += 1
            try:
                await self._ensure_process()
                response = await self._request_unlocked(payload)
                query_ms = int(
                    (asyncio.get_running_loop().time() - request_started) * 1000
                ) if payload.get("op") == "search" else 0
                return SidecarRequestResult(
                    response=response,
                    timing=SidecarRequestTiming(queue_wait_ms=queue_wait_ms, query_ms=query_ms),
                )
            finally:
                self._active_requests -= 1
                self.touch()

    async def _ensure_process(self) -> None:
        if self._process is not None and self._process.returncode is None:
            return
        command = _worker_command(self.command, self.index_dir, self.owner_user_id)
        if not command:
            raise TsSidecarUnavailable("TypeScript RAG worker 未配置")
        try:
            self._process = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=os.environ.copy(),
            )
            # 原生 Jieba 首次加载词典可能超过查询超时；启动探活使用独立上限，
            # 避免 worker 已启动但被 500ms 查询超时误判为不可用。
            response = await self._request_unlocked({"op": "ping"}, timeout_seconds=5.0)
            self._revision = response.get("revision") or self._revision
            self._document_count = int(response.get("document_count") or 0)
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
        except (BrokenPipeError, ConnectionError, asyncio.TimeoutError) as error:
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
            raise TsSidecarUnavailable(str(response.get("message") or response.get("code") or "worker error"))
        if response.get("revision") is not None:
            self._revision = response.get("revision")
        return response


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
    return {
        # worker 内部使用稳定的 chunk slot；版本变化只更新同一 slot 的内容，
        # 避免一个文档改动后把所有未变化 chunk 当成删除再新增。
        "id": _worker_document_key(document),
        # 保留原文，避免 Python 侧预分词导致 TS/Python 两套语义漂移。
        "text": "\n".join((document.title, document.summary, document.content)),
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
    parent = document.parent_document_id or document.document_id
    return f"{document.source_type}:{parent}:{document.chunk_index}"


_lexical_clients: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, TsSidecarClient]] = weakref.WeakKeyDictionary()


def _index_document_digest(document: IndexDocument) -> str:
    """只计算影响词法索引的字段，版本变化不应触发无意义 upsert。"""
    payload = "\x1f".join((
        _worker_document_key(document),
        document.source_type,
        document.title,
        document.summary,
        document.content,
    ))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


async def get_lexical_client(owner_user_id: object, *, command: str, index_dir: str) -> TsSidecarClient:
    """按 owner 复用常驻 TS worker；索引缓存淘汰不再立即杀掉进程。"""
    owner_key = str(owner_user_id)
    loop = asyncio.get_running_loop()
    _ensure_sidecar_reaper(loop)
    clients = _lexical_clients.setdefault(loop, {})
    client = clients.get(owner_key)
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
            "scoring_version": "confidence-v1",
        }
    from app.core.config import get_settings

    loop = asyncio.get_running_loop()
    _ensure_sidecar_reaper(loop)
    client = _rank_clients.get(loop)
    if client is None:
        settings = get_settings().search
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
        payload.append({
            "id": candidate_id,
            "source_type": candidate.source_type,
            "raw_score": candidate.raw_score,
            "rank": candidate.rank,
            "fusion": "hybrid-rrf" if candidate.fused_score else "bm25",
            "fused_score": candidate.fused_score if candidate.fused_score else None,
            "document": {
                "id": candidate_id,
                "text": document.content,
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
            },
        })
    selected, stats = await client.rank_candidates(
        query, payload, limit=limit, max_chars=max_chars,
        max_per_source=max_per_source, max_per_parent=max_per_parent,
        exclude_content_hashes=exclude_content_hashes,
    )
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


def _worker_command(command: str, index_dir: str, owner_user_id: str) -> list[str]:
    configured = command.strip()
    if not configured:
        packaged = Path(__file__).resolve().parents[2] / "bin" / "gugu-rag-ts-worker.mjs"
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


def _timeout_seconds() -> float:
    from app.core.config import get_settings

    value = getattr(get_settings().search, "ts_sidecar_timeout_ms", 500)
    return max(0.05, min(int(value), 30_000) / 1000)


__all__ = [
    "TsLexicalIndex", "TsSidecarClient", "TsSidecarUnavailable",
    "rank_candidates_with_cache",
    "SIDE_CAR_IDLE_TTL_SECONDS",
    "get_lexical_client", "close_lexical_clients", "close_rank_clients", "index_dir_for_owner",
]
