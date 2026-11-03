"""经 gugu-rag-sidecar 调用的常驻 Cython RAG 生命周期。"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from agent.rag.models import RecallResult, Scope
from agent.rag.ts_sidecar import (
    SIDECAR_STREAM_LIMIT_BYTES,
    TsSidecarUnavailable,
    _from_wire_document,
    _wire_document,
)

CYTHON_BUILD_TIMEOUT_SECONDS = 120.0


def _wire_value(value: Any) -> Any:
    if isinstance(value, Scope):
        return {
            name: getattr(value, name)
            for name in ("owner_user_id", "platform", "bot_id", "group_id", "scope_type", "scope_id")
        }
    if isinstance(value, dict):
        return {str(key): _wire_value(item) for key, item in value.items()}
    if isinstance(value, (set, frozenset)):
        return [_wire_value(item) for item in sorted(value, key=str)]
    if isinstance(value, (list, tuple)):
        return [_wire_value(item) for item in value]
    return value


async def _socket_request(
    socket_path: str, owner: str, payload: dict[str, Any], *, timeout: float,
    fast_fail: bool = False,
) -> dict[str, Any]:
    envelope = {
        "v": 1,
        "req_id": uuid.uuid4().hex,
        "owner": owner,
        "timeout_ms": max(50, int(timeout * 1000)),
        "payload": payload,
    }
    connect_timeout = min(5.0, timeout) if fast_fail else 5.0
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(socket_path, limit=SIDECAR_STREAM_LIMIT_BYTES),
            timeout=connect_timeout,
        )
    except (OSError, asyncio.TimeoutError) as error:
        raise CythonSidecarUnavailable("Cython RAG sidecar socket 不可用") from error
    try:
        writer.write((json.dumps(envelope, ensure_ascii=False) + "\n").encode())
        await writer.drain()
        response_timeout = timeout if fast_fail else timeout + 5.0
        line = await asyncio.wait_for(reader.readline(), timeout=response_timeout)
        if not line:
            raise CythonSidecarUnavailable("Cython RAG sidecar 连接已断开")
        response = json.loads(line)
    except (OSError, ValueError, asyncio.TimeoutError, json.JSONDecodeError) as error:
        raise CythonSidecarUnavailable("Cython RAG sidecar 请求失败") from error
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass
    if response.get("status") == "error":
        raise CythonSidecarUnavailable(
            str(response.get("message") or "Cython RAG worker error"),
            code=str(response.get("code") or "") or None,
        )
    result = response.get("payload")
    if not isinstance(result, dict):
        raise CythonSidecarUnavailable("Cython RAG sidecar 返回结构无效")
    return result


class CythonSidecarUnavailable(TsSidecarUnavailable):
    """常驻 Cython RAG worker 不可用或 RPC 失败。"""

    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        self.code = code


class CythonSidecarLifecycle:
    """实现 CythonRagLifecycle 的远程调用面，索引状态由 sidecar 单进程持有。"""

    def __init__(self, owner_user_id: object, cache_scope: str, socket_path: str):
        self.owner_user_id = str(owner_user_id)
        self.cache_scope = str(cache_scope)
        self.socket_path = socket_path
        self.revision = ""
        self.document_count = 0
        self.estimated_bytes = 0
        self.vector_count = 0
        self.vector_version = ""
        self._last_watermark: dict[str, Any] | None = None
        # 只用于让统一查询器并行启动 Python 侧的 query embedding；真实引擎驻留在 sidecar。
        self.engine = self

    @property
    def documents_by_id(self) -> dict[str, Any]:
        # 统一查询结果携带 worker 投影文档，调用方通过 wire document 回连。
        return {}

    @property
    def client(self) -> "CythonSidecarLifecycle":
        return self

    async def _request(
        self, payload: dict[str, Any], *, timeout: float = 30.0,
        fast_fail: bool = False,
    ) -> dict[str, Any]:
        return await _socket_request(
            self.socket_path, self.owner_user_id,
            {**payload, "cache_scope": self.cache_scope}, timeout=timeout,
            fast_fail=fast_fail,
        )

    def _absorb(self, response: dict[str, Any]) -> dict[str, Any]:
        self.revision = str(response.get("revision") or self.revision)
        self.document_count = int(response.get("document_count") or 0)
        self.estimated_bytes = int(response.get("estimated_bytes") or 0)
        self.vector_count = int(response.get("vector_count") or 0)
        self.vector_version = str(response.get("vector_version") or "")
        self._last_watermark = response.get("watermark")
        return response

    async def load_index_from_snapshot_or_database(
        self, _db, owner_user_id: object, _index_dir, *,
        vector_version: str = "", revision: str | None = None,
    ) -> dict[str, Any]:
        if str(owner_user_id) != self.owner_user_id:
            raise ValueError("Cython RAG 生命周期 owner 不匹配")
        response = await self._request({
            "op": "cython_acquire",
            "revision": revision,
            "vector_version": vector_version,
        }, timeout=CYTHON_BUILD_TIMEOUT_SECONDS)
        return self._absorb(response)

    async def try_acquire_cached(
        self, *, revision: str, vector_version: str,
    ) -> dict[str, Any] | None:
        """只复用 sidecar 已驻留且版本匹配的索引，不创建或恢复冷索引。"""
        response = await self._request({
            "op": "cython_try_acquire",
            "revision": revision,
            "vector_version": vector_version,
        }, timeout=0.25, fast_fail=True)
        if response.get("ready") is not True:
            return None
        return self._absorb(response)

    async def prepare_memory(
        self, owner_user_id: object, scopes, *, source_filter: str = "all",
        snapshot_revision: str = "", snapshot_text: str = "", vector_version: str = "",
    ) -> dict[str, Any]:
        if str(owner_user_id) != self.owner_user_id:
            raise ValueError("Cython RAG Memory owner 不匹配")
        response = await self._request({
            "op": "cython_prepare_memory",
            "revision": self.revision,
            "scopes": _wire_value(list(scopes)),
            "source_filter": source_filter,
            "snapshot_revision": snapshot_revision,
            "snapshot_text": snapshot_text,
            "vector_version": vector_version,
        }, timeout=CYTHON_BUILD_TIMEOUT_SECONDS)
        return response

    async def unified_query(self, query: str, **options) -> dict[str, Any]:
        remote_options = dict(options)
        if remote_options.get("precomputed_query_embedding") is not None:
            # 本地已完成 embedding 时，worker 只需这个标记走统一 embedding 分支；
            # 不把包含认证配置的 query_embedding 快照通过 IPC 再传一份。
            remote_options["query_embedding"] = {"precomputed": True}
        return await self._request({
            "op": "cython_unified_query",
            "revision": str(remote_options.get("revision") or self.revision),
            "vector_version": str(remote_options.get("vector_version") or self.vector_version),
            "query": query,
            "options": _wire_value(remote_options),
        })

    async def flush_snapshot_persistence(self) -> dict[str, Any]:
        return await self._request({"op": "cython_flush_snapshot"})


class CythonSidecarTransientIndex:
    """把小型 transient 文档集交给同一常驻 worker 缓存并查询。"""

    def __init__(self, owner_user_id: object, documents, revision: str, socket_path: str):
        self.owner_user_id = str(owner_user_id)
        self.documents = list(documents)
        self.revision = str(revision)
        self.socket_path = socket_path

    async def search_with_timing(
        self, query: str, *, limit: int = 10, source_types=(), scope: Scope | None = None,
    ):
        payload = {
            "op": "cython_transient_search",
            "revision": self.revision,
            "query": query,
            "limit": int(limit),
            "source_types": sorted(map(str, source_types)),
            "scope": _wire_value(scope) if scope is not None else None,
            "documents": [{
                **_wire_document(document),
                "owner_user_id": document.scope.owner_user_id,
            } for document in self.documents],
        }
        response = await _socket_request(
            self.socket_path, self.owner_user_id, payload, timeout=30.0,
        )
        self.cache_hit = bool(response.get("cache_hit"))
        results = []
        for row in response.get("results") or ():
            if not isinstance(row, dict) or not isinstance(row.get("document"), dict):
                continue
            document = _from_wire_document(row["document"], self.owner_user_id)
            if document is not None:
                results.append(RecallResult(document, float(row.get("score") or 0)))
        return results, response.get("timing") or {}


__all__ = [
    "CythonSidecarLifecycle", "CythonSidecarTransientIndex", "CythonSidecarUnavailable",
]
