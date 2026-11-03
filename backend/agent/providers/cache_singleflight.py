"""按 Provider 稳定缓存前缀合并后台反思请求。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Awaitable, Callable, TypeVar

_LOCK_PREFIX = "agent:provider-cache-singleflight:v1:"
_LEASE_SECONDS = 90
_HEARTBEAT_SECONDS = 30
_WAIT_SECONDS = 360
_Result = TypeVar("_Result")


def _probe_fingerprint(probe: dict[str, Any] | None) -> str:
    direct = probe.get("cache_key_fingerprint") if isinstance(probe, dict) else None
    if isinstance(direct, str) and direct:
        return direct
    wire = probe.get("wire_prefix") if isinstance(probe, dict) else None
    fingerprint = wire.get("digest") if isinstance(wire, dict) else None
    anchors = wire.get("anchor_paths") if isinstance(wire, dict) else None
    if not isinstance(fingerprint, str) or not fingerprint or not anchors:
        return ""
    return fingerprint


def stable_request_fingerprint(payload: Any) -> str:
    """对调用方已剔除动态尾消息的请求前缀计算确定性指纹。"""
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def provider_branch_fingerprint(
    request: dict[str, Any], *, stable_row_count: int, rows_key: str = "messages",
) -> str | None:
    """对最终请求的稳定历史行与其它 Provider 参数生成协调指纹。"""
    rows = request.get(rows_key)
    if stable_row_count <= 0 or not isinstance(rows, list):
        return None
    return stable_request_fingerprint({
        **{key: value for key, value in request.items() if key != rows_key},
        "stable_rows_key": rows_key,
        "stable_rows": rows[:stable_row_count],
    })


def provider_branch_cache_supported(adapter: Any, ai: Any) -> bool:
    """仅对当前模型明确支持主动或显式前缀缓存的协议启用协调。"""
    model = getattr(ai, "model", "") or ""
    return bool(
        adapter.supports_active_cache(model)
        or adapter.supports_explicit_cache(model)
    )


def responses_branch_fingerprint(
    request: dict[str, Any], *, stable_history_count: int, cache_supported: bool,
) -> str | None:
    """响应式分支按稳定历史与请求参数生成指纹，剔除末尾动态任务。"""
    if stable_history_count <= 0 or not cache_supported:
        return None
    return stable_request_fingerprint({
        **{key: value for key, value in request.items() if key != "input"},
        "stable_input": request.get("input", [])[:-1],
    })


async def _renew_lease(lock, probe: dict[str, Any] | None) -> None:
    while True:
        await asyncio.sleep(_HEARTBEAT_SECONDS)
        try:
            renewed = await lock.extend(_LEASE_SECONDS, replace_ttl=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            renewed = False
        if not renewed:
            if isinstance(probe, dict):
                probe["singleflight_lease_lost"] = True
            return
        if isinstance(probe, dict):
            probe["singleflight_lease_renewals"] = int(
                probe.get("singleflight_lease_renewals", 0) or 0
            ) + 1


@asynccontextmanager
async def cache_prefix_singleflight(
    probe: dict[str, Any] | None,
    *,
    enabled: bool,
    namespace: str = "unknown",
) -> AsyncIterator[None]:
    """按最终请求中的稳定缓存前缀协调；Redis 故障时不阻断模型请求。"""
    prefix_fingerprint = _probe_fingerprint(probe)
    fingerprint = (
        hashlib.sha256(f"{namespace}:{prefix_fingerprint}".encode("utf-8")).hexdigest()
        if prefix_fingerprint else ""
    )
    if isinstance(probe, dict):
        probe["cache_key_fingerprint"] = fingerprint or None
    if not enabled or not fingerprint:
        if isinstance(probe, dict):
            probe["singleflight_state"] = "disabled" if not enabled else "no_cache_anchor"
            probe["singleflight_wait_ms"] = 0.0
        yield
        return

    started = time.monotonic()
    lock = None
    heartbeat = None
    acquired = False
    try:
        from app.core import redis as redis_core

        lock_key = _LOCK_PREFIX + hashlib.sha256(fingerprint.encode("ascii")).hexdigest()
        lock = redis_core.get_redis().lock(
            lock_key,
            timeout=_LEASE_SECONDS,
            thread_local=False,
        )
        acquired = await lock.acquire(blocking=True, blocking_timeout=_WAIT_SECONDS)
    except asyncio.CancelledError:
        raise
    except Exception:
        if isinstance(probe, dict):
            probe["singleflight_state"] = "redis_unavailable"
            probe["singleflight_wait_ms"] = round((time.monotonic() - started) * 1000, 3)
        yield
        return

    if not acquired:
        if isinstance(probe, dict):
            probe["singleflight_state"] = "wait_timeout"
            probe["singleflight_wait_ms"] = round((time.monotonic() - started) * 1000, 3)
        yield
        return

    if isinstance(probe, dict):
        probe["singleflight_state"] = "acquired"
        probe["singleflight_wait_ms"] = round((time.monotonic() - started) * 1000, 3)
        probe["singleflight_lease_renewals"] = 0
        probe["singleflight_lease_lost"] = False
    heartbeat = asyncio.create_task(_renew_lease(lock, probe))
    try:
        yield
    finally:
        heartbeat.cancel()
        try:
            await heartbeat
        except asyncio.CancelledError:
            pass
        try:
            await lock.release()
        except asyncio.CancelledError:
            raise
        except Exception:
            # 锁由 Redis 租约兜底过期；释放异常不能覆盖 Provider 的结果或错误。
            pass


async def run_provider_request(
    request_factory: Callable[[], Awaitable[_Result]],
    probe: dict[str, Any] | None,
    *,
    enabled: bool,
    namespace: str,
) -> _Result:
    """在缓存前缀锁的生命周期内调用 Provider。"""
    try:
        async with cache_prefix_singleflight(
            probe, enabled=enabled, namespace=namespace,
        ):
            return await request_factory()
    except asyncio.CancelledError as exc:
        from agent.providers.cache_probe import fail_request_probe

        fail_request_probe(probe, exc)
        raise


async def run_provider_branch_request(
    request_factory: Callable[[], Awaitable[_Result]],
    request: dict[str, Any],
    probe: dict[str, Any] | None,
    *,
    stable_row_count: int,
    cache_supported: bool,
    namespace: str,
) -> _Result:
    """按最终请求中的稳定历史行生成指纹并发送分支请求。"""
    fingerprint = (
        provider_branch_fingerprint(request, stable_row_count=stable_row_count)
        if cache_supported else None
    )
    if probe is not None and fingerprint:
        probe["cache_key_fingerprint"] = fingerprint
    try:
        return await run_provider_request(
            request_factory, probe,
            enabled=bool(fingerprint), namespace=namespace,
        )
    except Exception as exc:
        from agent.providers.cache_probe import fail_request_probe

        fail_request_probe(probe, exc)
        raise


async def run_responses_branch_request(
    request_factory: Callable[[], Awaitable[_Result]],
    request: dict[str, Any],
    probe: dict[str, Any] | None,
    *,
    stable_history_count: int,
    cache_supported: bool,
    namespace: str,
) -> _Result:
    """Responses 分支用稳定历史（去除动态任务尾项）生成协调指纹并发送。"""
    fingerprint = responses_branch_fingerprint(
        request,
        stable_history_count=stable_history_count,
        cache_supported=cache_supported,
    )
    if probe is not None and fingerprint:
        probe["cache_key_fingerprint"] = fingerprint
    return await run_provider_request(
        request_factory, probe,
        enabled=bool(fingerprint), namespace=namespace,
    )


__all__ = [
    "cache_prefix_singleflight", "provider_branch_cache_supported",
    "provider_branch_fingerprint",
    "responses_branch_fingerprint",
    "run_provider_branch_request", "run_provider_request",
    "run_responses_branch_request",
    "stable_request_fingerprint",
]
