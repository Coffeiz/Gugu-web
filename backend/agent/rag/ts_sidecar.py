"""TypeScript RAG worker 的异步 JSONL 客户端。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
import weakref
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from agent.rag.models import IndexDocument, RecallResult, Scope
from agent.rag.scope import matches_scope


class TsSidecarUnavailable(RuntimeError):
    """TS worker 未配置、启动失败或协议请求失败。"""


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

    async def replace(self, documents: list[IndexDocument], revision: str | None) -> None:
        response = await self._request({
            "op": "replace",
            "revision": revision or "",
            "documents": [_wire_document(document) for document in documents],
        })
        self._revision = response.get("revision")
        self._document_count = int(response.get("document_count") or len(documents))

    async def patch(
        self,
        upserts: list[IndexDocument],
        deletes: list[str],
        revision: str | None,
        base_revision: str | None,
    ) -> None:
        """只同步发生变化的 chunk，保持 worker 的 revision 原子推进。"""
        response = await self._request({
            "op": "patch",
            "revision": revision or "",
            "base_revision": base_revision or "",
            "upserts": [_wire_document(document) for document in upserts],
            "deletes": list(deletes),
        })
        self._revision = response.get("revision")
        self._document_count = int(response.get("document_count") or 0)

    async def reuse_if_current(self, revision: str | None) -> bool:
        await self._ensure_process()
        expected = revision or ""
        return bool(
            self.index_dir
            and self._revision == expected
            and (self._document_count > 0 or not expected)
        )

    async def search(
        self,
        query: str,
        *,
        documents: dict[str, IndexDocument],
        source_types: Iterable[str] = (),
        scope: Scope | None = None,
        limit: int = 10,
    ) -> list[RecallResult]:
        source_type_set = set(source_types)
        response = await self._request({
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
        results: list[RecallResult] = []
        for item in response.get("results") or []:
            document = documents.get(str(item.get("id")))
            if document is None:
                continue
            if source_type_set and document.source_type not in source_type_set:
                continue
            if scope is not None and not matches_scope(document, scope):
                continue
            results.append(RecallResult(document, float(item.get("score") or 0)))
        return results

    async def score_filter(self, query: str, candidates: list[dict], *, limit: int) -> tuple[list[dict], dict]:
        response = await self._request({
            "op": "score_filter",
            "query": query,
            "limit": max(1, int(limit)),
            "candidates": candidates,
        })
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

    async def _request(self, payload: dict) -> dict:
        async with self._lock:
            await self._ensure_process()
            return await self._request_unlocked(payload)

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

    async def search(
        self, query: str, *, limit: int = 10, source_types: Iterable[str] = (), scope: Scope | None = None,
    ) -> list[RecallResult]:
        return await self.client.search(
            query, documents=self.documents_by_id, source_types=source_types, scope=scope, limit=limit,
        )


def _wire_document(document: IndexDocument) -> dict[str, str]:
    return {
        # worker 内部使用稳定的 chunk slot；版本变化只更新同一 slot 的内容，
        # 避免一个文档改动后把所有未变化 chunk 当成删除再新增。
        "id": _worker_document_key(document),
        # 保留原文，避免 Python 侧预分词导致 TS/Python 两套语义漂移。
        "text": "\n".join((document.title, document.summary, document.content)),
        "source_type": document.source_type,
        "platform": document.scope.platform,
        "bot_id": document.scope.bot_id,
        "group_id": document.scope.group_id,
        "scope_type": document.scope.scope_type,
        "scope_id": document.scope.scope_id or "",
        "document_version": document.version or "",
    }


def _worker_document_key(document: IndexDocument) -> str:
    parent = document.parent_document_id or document.document_id
    return f"{document.source_type}:{parent}:{document.chunk_index}"


_score_clients: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, TsSidecarClient] = weakref.WeakKeyDictionary()


async def score_candidates_with_cache(
    owner_user_id: object,
    query: str,
    candidates: list[Any],
    *,
    limit: int,
) -> tuple[list[Any], dict]:
    """用复用的 TS worker 完成 confidence/filter，返回更新后的候选。"""

    from dataclasses import replace
    from app.core.config import get_settings

    if not candidates:
        return [], {
            "accepted_count": 0,
            "rejected_low_score": 0,
            "rejected_not_preferred": 0,
            "top_confidence": 0.0,
            "threshold": 0.35,
            "preferred_threshold": 0.55,
            "scoring_version": "confidence-v1",
        }
    # score_filter 不持有 owner-specific index；按 event loop 共享一个 worker，
    # 避免每个用户永久保留一个 Node 子进程。
    loop = asyncio.get_running_loop()
    client = _score_clients.get(loop)
    if client is None:
        settings = get_settings().search
        client = TsSidecarClient(
            f"score:{id(loop)}",
            command=settings.ts_sidecar_command,
            index_dir="",
        )
        _score_clients[loop] = client
    payload = []
    by_id = {}
    for index, candidate in enumerate(candidates):
        candidate_id = f"{candidate.source_type}:{candidate.document.chunk_id}:{index}"
        by_id[candidate_id] = candidate
        payload.append({
            "id": candidate_id,
            "source_type": candidate.source_type,
            "title": candidate.document.title,
            "summary": candidate.document.summary,
            "content": candidate.document.content,
            "confidence": candidate.document.metadata.get("confidence"),
            "normalized_score": candidate.normalized_score,
            "fused_score": candidate.fused_score,
        })
    selected, stats = await client.score_filter(query, payload, limit=limit)
    updated = []
    for item in selected:
        candidate = by_id.get(str(item.get("id")))
        if candidate is not None:
            updated.append(replace(
                candidate,
                confidence=float(item.get("confidence") or 0),
                source_quality=float(item.get("source_quality") or 0),
            ))
    return updated, stats


async def close_score_clients() -> None:
    """关闭 score_filter 共享 worker，供应用和 worker shutdown 调用。"""
    clients = list(_score_clients.values())
    _score_clients.clear()
    if clients:
        await asyncio.gather(*(client.close() for client in clients), return_exceptions=True)


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


def _timeout_seconds() -> float:
    from app.core.config import get_settings

    value = getattr(get_settings().search, "ts_sidecar_timeout_ms", 500)
    return max(0.05, min(int(value), 30_000) / 1000)


__all__ = [
    "TsLexicalIndex", "TsSidecarClient", "TsSidecarUnavailable",
    "score_candidates_with_cache", "close_score_clients",
]
