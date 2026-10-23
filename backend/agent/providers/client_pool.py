"""主 Agent run 共享 Provider SDK 客户端及其有界生命周期。"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Hashable, Iterator
import asyncio
import contextvars
import hashlib
import json
import os


RUN_IDLE_CLOSE_SECONDS = 90.0
ACTIVE_CONNECTION_IDLE_SECONDS = 10 * 60.0


@dataclass(eq=False)
class _RunScope:
    entries: set[tuple[asyncio.AbstractEventLoop, Hashable]] = field(default_factory=set)


@dataclass
class _Entry:
    client: Any
    active_scopes: set[_RunScope] = field(default_factory=set)
    close_handle: asyncio.TimerHandle | None = None


class ProviderClientPool:
    """按事件循环和配置复用 SDK client；run 完成后延迟回收。"""

    def __init__(self, idle_close_seconds: float = RUN_IDLE_CLOSE_SECONDS) -> None:
        self._idle_close_seconds = idle_close_seconds
        self._entries: dict[tuple[asyncio.AbstractEventLoop, Hashable], _Entry] = {}
        self._scope: contextvars.ContextVar[_RunScope | None] = contextvars.ContextVar(
            "provider_client_run_scope", default=None,
        )

    def new_run_scope(self) -> _RunScope:
        return _RunScope()

    @contextmanager
    def activate(self, scope: _RunScope) -> Iterator[None]:
        token = self._scope.set(scope)
        try:
            yield
        finally:
            self._scope.reset(token)

    def finish_run_scope(self, scope: _RunScope) -> None:
        for key in scope.entries:
            entry = self._entries.get(key)
            if entry is None:
                continue
            entry.active_scopes.discard(scope)
            if not entry.active_scopes:
                self._schedule_close(key, entry)

    def get_or_create(
        self,
        key: Hashable,
        factory: Callable[[], Any],
        *,
        outside_scope_factory: Callable[[], Any] | None = None,
    ) -> Any:
        scope = self._scope.get()
        if scope is None:
            return (outside_scope_factory or factory)()
        loop = asyncio.get_running_loop()
        pool_key = (loop, key)
        entry = self._entries.get(pool_key)
        is_closed = getattr(entry.client, "is_closed", False) if entry is not None else True
        if callable(is_closed):
            is_closed = is_closed()
        if entry is None or is_closed:
            entry = _Entry(client=factory())
            self._entries[pool_key] = entry
        if entry.close_handle is not None:
            entry.close_handle.cancel()
            entry.close_handle = None
        if pool_key not in scope.entries:
            scope.entries.add(pool_key)
            entry.active_scopes.add(scope)
        return entry.client

    def get_sdk_client(self, key: Hashable, timeout: Any, factory: Callable[[Any], Any]) -> Any:
        """为 run 池化 SDK client；非 run 调用仍由 SDK 管理自己的短期传输。"""
        def create_managed_client():
            import httpx2

            http_client = httpx2.AsyncClient(
                timeout=timeout,
                limits=httpx2.Limits(keepalive_expiry=ACTIVE_CONNECTION_IDLE_SECONDS),
            )
            return factory(http_client)

        return self.get_or_create(
            key,
            create_managed_client,
            outside_scope_factory=lambda: factory(None),
        )

    def _schedule_close(self, key: tuple[asyncio.AbstractEventLoop, Hashable], entry: _Entry) -> None:
        if entry.close_handle is not None:
            entry.close_handle.cancel()
        loop = key[0]
        if loop.is_closed():
            return
        entry.close_handle = loop.call_later(
            self._idle_close_seconds,
            self._close_if_idle,
            key,
            entry,
        )

    def _close_if_idle(self, key: tuple[asyncio.AbstractEventLoop, Hashable], entry: _Entry) -> None:
        if self._entries.get(key) is not entry or entry.active_scopes:
            return
        self._entries.pop(key, None)
        entry.close_handle = None
        loop = key[0]
        if loop.is_closed():
            return
        task = loop.create_task(entry.client.close())
        task.add_done_callback(_consume_close_result)


def _consume_close_result(task: asyncio.Task) -> None:
    try:
        task.result()
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("agent.providers.client_pool.close", exc)


def config_key(kind: str, *, base_url: str, api_key: str, headers: dict[str, str], timeout: Any) -> str:
    """生成不暴露密钥的配置键，避免不同 BYOK 配置共享认证状态。"""
    timeout_value = timeout
    if not isinstance(timeout, (int, float, str, type(None))):
        timeout_value = {
            name: getattr(timeout, name, None)
            for name in ("connect", "read", "write", "pool")
        }
    raw = json.dumps(
        [
            kind,
            base_url,
            api_key,
            sorted(headers.items()),
            timeout_value,
            {
                name: os.environ.get(name)
                for name in (
                    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                    "SSL_CERT_FILE", "SSL_CERT_DIR",
                )
            },
        ],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


provider_client_pool = ProviderClientPool()
