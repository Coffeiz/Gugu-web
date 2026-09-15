"""Provider 凭据连通性诊断；Admin 与用户 BYOK 共用。"""

import asyncio
import hashlib
import time
from types import SimpleNamespace


_RESPONSES_PROBE_TTL_SECONDS = 10 * 60
_responses_probe_cache: dict[str, tuple[float, dict]] = {}
_responses_probe_tasks: dict[str, asyncio.Task] = {}


def _responses_probe_key(*, provider: str, base_url: str, model: str,
                         api_key: str) -> str:
    """能力与目的地/模型/凭据相关，不把 API Key 原文放进缓存键或日志。"""
    key_fingerprint = hashlib.sha256((api_key or "").encode("utf-8")).hexdigest()
    raw = "\x1f".join((provider or "", (base_url or "").rstrip("/"), model or "", key_fingerprint))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def _probe_responses_once(*, provider: str, api_key: str, base_url: str,
                                model: str) -> dict:
    """用最小 Responses 请求探测协议；不返回上游响应正文。"""
    import httpx
    from agent import providers

    config = SimpleNamespace(provider=provider, base_url=(base_url or "").rstrip("/"),
                             api_key=api_key, model=model or "", api_format="responses")
    adapter = providers.adapter_for(config)
    try:
        request = adapter.diagnostic_request(config)
        # 探测只确认 Responses 端点和模型可用，不创建可供后续续接的 response chain。
        # 正式续接请求仍由 OpenAIResponsesDriver 按 store 配置处理。
        request["payload"] = {**request["payload"], "store": False}
        resolved = adapter.resolve_base_url(config)
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=3.0, read=8.0, write=3.0, pool=3.0),
            follow_redirects=False,
        ) as client:
            response = await client.post(f"{resolved}{request['path']}",
                                         headers=request["headers"], json=request["payload"])
        ok = 200 <= response.status_code < 400
        return {"ok": ok, "status": response.status_code,
                "detail": "" if ok else f"上游返回 HTTP {response.status_code}"}
    except Exception:
        return {"ok": False, "status": 0, "detail": "无法连接 Responses 接口"}


async def probe_responses_capability(*, provider: str, api_key: str, base_url: str,
                                     model: str) -> dict:
    """探测一次 Responses 能力并短期缓存结果，避免并发首请求重复探测。"""
    key = _responses_probe_key(
        provider=provider, base_url=base_url, model=model, api_key=api_key,
    )
    now = time.monotonic()
    for stale_key, (checked_at, _) in list(_responses_probe_cache.items()):
        # 成功结果定期刷新；失败结果在当前配置指纹下保持，避免每轮对话重复打
        # 一个已知不支持的端点。改地址、模型或凭据会自然产生新指纹。
        if now - checked_at >= _RESPONSES_PROBE_TTL_SECONDS \
                and _responses_probe_cache[stale_key][1].get("ok"):
            _responses_probe_cache.pop(stale_key, None)
    cached = _responses_probe_cache.get(key)
    if cached:
        if not cached[1].get("ok") or now - cached[0] < _RESPONSES_PROBE_TTL_SECONDS:
            return dict(cached[1])
        _responses_probe_cache.pop(key, None)

    task = _responses_probe_tasks.get(key)
    if task is None:
        task = asyncio.create_task(_probe_responses_once(
            provider=provider, api_key=api_key, base_url=base_url, model=model,
        ))
        _responses_probe_tasks[key] = task
    try:
        result = await asyncio.shield(task)
        _responses_probe_cache[key] = (time.monotonic(), dict(result))
        return dict(result)
    finally:
        if task.done() and _responses_probe_tasks.get(key) is task:
            _responses_probe_tasks.pop(key, None)


async def test_provider_credential(*, provider: str, api_key: str, base_url: str,
                                   model: str, api_format: str = "") -> dict:
    """发送一次最小无副作用请求，返回统一诊断结果，不返回密钥或响应正文。"""
    import httpx
    from agent import providers

    config = SimpleNamespace(provider=provider, base_url=(base_url or "").rstrip("/"),
                             api_key=api_key, model=model or "", api_format=api_format or "")
    adapter = providers.adapter_for(config)
    declared = providers.capability_snapshot(config)
    try:
        request = adapter.diagnostic_request(config)
        resolved = adapter.resolve_base_url(config)
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            response = await client.post(f"{resolved}{request['path']}",
                                         headers=request["headers"], json=request["payload"])
        ok = 200 <= response.status_code < 400
        return {"ok": ok, "status": response.status_code,
                "detail": "" if ok else f"上游返回 HTTP {response.status_code}",
                "declared_capabilities": declared}
    except Exception:
        return {"ok": False, "status": 0, "detail": "无法连接 Provider，请检查地址、模型和密钥",
                "declared_capabilities": declared}
