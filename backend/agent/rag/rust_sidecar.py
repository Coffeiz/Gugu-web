"""Rust/Tantivy 词法索引 sidecar 的异步客户端。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
from collections.abc import Iterable
from pathlib import Path

from agent.rag.models import IndexDocument, RecallResult, Scope
from agent.rag.scope import matches_scope
from agent.rag.tokenizer import tokenize


class RustSidecarUnavailable(RuntimeError):
    """sidecar 未启用、启动失败或协议请求失败。"""


def _tokenized_document(document: IndexDocument) -> str:
    text = "\n".join((document.title, document.summary, document.content))
    return " ".join(tokenize(text))


class RustSidecarClient:
    """一个 owner 对应一个 sidecar 进程，避免不同 owner 共享索引状态。"""

    def __init__(self, owner_user_id: object, *, command: str, index_dir: str = ""):
        self.owner_user_id = str(owner_user_id)
        self.command = command
        self.index_dir = index_dir
        self._process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._revision: str | None = None
        self._document_count = 0

    async def replace(self, documents: list[IndexDocument], revision: str | None) -> None:
        if not documents:
            # sidecar 仍需要清空旧索引，空 replace 不能被跳过。
            pass
        response = await self._request({
            "op": "replace",
            "revision": revision or "",
            "documents": [
                {
                    "id": document.chunk_id,
                    "text": _tokenized_document(document),
                    "owner_user_id": self.owner_user_id,
                    "source_type": document.source_type,
                    "scope_type": document.scope.scope_type,
                    "scope_id": document.scope.scope_id or "",
                    "document_version": document.version or "",
                }
                for document in documents
            ],
        })
        self._revision = response.get("revision")
        self._document_count = int(response.get("document_count") or len(documents))

    async def reuse_if_current(self, revision: str | None) -> bool:
        """连接持久化 sidecar，并在磁盘索引 revision 一致时复用它。

        sidecar 进程本身会在启动时从 index_dir 恢复 Tantivy 索引。此前 Python
        每次创建客户端都会无条件 replace，导致 worker 重启后又完整重建一次。
        内存模式没有可复用的持久化目录，始终返回 False。
        """
        await self._ensure_process()
        expected = revision or ""
        # 新建的空磁盘目录 revision 也是空字符串，不能误判为可复用；
        # 空数据集本身可以复用空索引。
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
            "query": " ".join(tokenize(query)),
            "limit": max(1, min(int(limit), 50)),
            "owner_user_id": self.owner_user_id,
            "source_types": sorted(source_type_set),
            "scope_type": scope.scope_type if scope is not None else None,
            "scope_id": scope.scope_id if scope is not None and scope.scope_id else None,
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
            assert self._process is not None
            assert self._process.stdin is not None
            assert self._process.stdout is not None
            try:
                self._process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode())
                await self._process.stdin.drain()
                timeout = _timeout_seconds()
                line = await asyncio.wait_for(self._process.stdout.readline(), timeout=timeout)
            except (BrokenPipeError, ConnectionError, asyncio.TimeoutError) as error:
                await self.close()
                raise RustSidecarUnavailable("Rust lexical sidecar 请求失败") from error
            if not line:
                await self.close()
                raise RustSidecarUnavailable("Rust lexical sidecar 已退出")
            try:
                response = json.loads(line)
            except json.JSONDecodeError as error:
                raise RustSidecarUnavailable("Rust lexical sidecar 返回了无效 JSON") from error
            if response.get("status") == "error":
                raise RustSidecarUnavailable(str(response.get("message") or response.get("code") or "sidecar error"))
            return response

    async def _ensure_process(self) -> None:
        if self._process is not None and self._process.returncode is None:
            return
        command = _sidecar_command(self.command, self.index_dir, self.owner_user_id)
        if not command:
            raise RustSidecarUnavailable("Rust lexical sidecar 未配置")
        try:
            self._process = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=os.environ.copy(),
            )
            response = await self._request_unlocked({"op": "ping"})
            self._revision = response.get("revision") or self._revision
            self._document_count = int(response.get("document_count") or 0)
        except (OSError, asyncio.TimeoutError, RustSidecarUnavailable) as error:
            await self.close()
            if isinstance(error, RustSidecarUnavailable):
                raise
            raise RustSidecarUnavailable("Rust lexical sidecar 启动失败") from error

    async def _request_unlocked(self, payload: dict) -> dict:
        assert self._process is not None and self._process.stdin is not None and self._process.stdout is not None
        self._process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode())
        await self._process.stdin.drain()
        line = await asyncio.wait_for(self._process.stdout.readline(), timeout=_timeout_seconds())
        if not line:
            raise RustSidecarUnavailable("Rust lexical sidecar 已退出")
        response = json.loads(line)
        if response.get("status") == "error":
            raise RustSidecarUnavailable(str(response.get("message") or response.get("code") or "sidecar error"))
        return response


class RustLexicalIndex:
    """Python 侧的轻量句柄，正文映射仍由 Python 持有。"""

    def __init__(self, documents: list[IndexDocument], client: RustSidecarClient, revision: str | None):
        self.documents = list(documents)
        self.documents_by_id = {document.chunk_id: document for document in documents}
        self.client = client
        self.revision = revision

    async def search(
        self, query: str, *, limit: int = 10, source_types: Iterable[str] = (), scope: Scope | None = None,
    ) -> list[RecallResult]:
        return await self.client.search(
            query, documents=self.documents_by_id, source_types=source_types,
            scope=scope, limit=limit,
        )


def _sidecar_command(command: str, index_dir: str, owner_user_id: str = "") -> list[str]:
    configured = command.strip()
    if not configured:
        packaged = Path(__file__).resolve().parents[2] / "bin" / "gugu-rag-sidecar"
        configured = str(packaged) if packaged.is_file() else ""
    parts = shlex.split(configured) if configured else []
    if not parts:
        return []
    if index_dir:
        # 配置项是索引根目录；每个 owner 使用独立子目录，避免 sidecar 进程
        # 之间互相打开或覆盖 Tantivy 索引。
        owner_hash = hashlib.sha256(owner_user_id.encode("utf-8")).hexdigest()[:32]
        parts.append(str(Path(index_dir).expanduser() / owner_hash) if owner_hash else str(Path(index_dir).expanduser()))
    return parts


def _timeout_seconds() -> float:
    from app.core.config import get_settings

    value = getattr(get_settings().search, "rust_sidecar_timeout_ms", 500)
    return max(0.05, min(int(value), 30_000) / 1000)


__all__ = [
    "RustLexicalIndex", "RustSidecarClient", "RustSidecarUnavailable",
]
