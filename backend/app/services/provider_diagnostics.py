"""Provider 凭据连通性诊断；Admin 与用户 BYOK 共用。"""

from types import SimpleNamespace


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
