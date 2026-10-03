"""Provider 凭据连通性诊断；Admin 与用户 BYOK 共用。

历史上的 Responses 能力探测（probe + TTL 缓存 + 运行时失败回写）随
Chat API 下推理接续的自动协议切换一起移除：continuation 现在只在
显式 api_format=responses 下生效，无需运行前探测。
"""

from types import SimpleNamespace


async def probe_responses_capabilities(ai) -> dict:
    """探测 Responses 原生请求形状；不把 Chat 的接受能力当成 Responses 能力。"""
    import httpx
    from agent import providers
    from agent.providers.standalone import output_budget
    from app.core.credentials import normalize_ascii_api_key

    adapter = providers.adapter_for(ai)
    url = adapter.resolve_base_url(ai).rstrip("/") + "/responses"
    headers = {"Authorization": "Bearer " + normalize_ascii_api_key(ai.api_key or "local")}
    headers.update(adapter.auth_headers(ai))
    payload = {
        "model": ai.model, "input": "请只输出 JSON 对象：{\"ok\":true}。",
        "max_output_tokens": output_budget(ai, 128), "stream": False,
        **adapter.build_responses_reasoning_params(ai),
    }
    probes = {
        "chat": {}, "stream": {"stream": True},
        "tools": {"tools": [{"type": "function", "name": "probe_noop",
            "description": "无副作用测试工具", "parameters": {"type": "object"}}]},
        "json_object": {"text": {"format": {"type": "json_object"}}},
        "json_schema": {"text": {"format": {"type": "json_schema", "name": "probe",
            "schema": {"type": "object", "properties": {"ok": {"type": "boolean"}},
                       "required": ["ok"], "additionalProperties": False}, "strict": True}}},
    }
    result = {}
    async with httpx.AsyncClient(timeout=40.0, follow_redirects=False) as client:
        for name, options in probes.items():
            try:
                async with client.stream("POST", url, headers=headers, json={**payload, **options}) as response:
                    status = response.status_code
                    if name == "stream" and status < 400:
                        async for line in response.aiter_lines():
                            if line.startswith("data:"):
                                break
                result[name] = {"status": "支持" if 200 <= status < 300 else "检测失败",
                                "detail": f"Responses HTTP {status}"}
            except Exception as exc:
                result[name] = {"status": "检测失败", "detail": type(exc).__name__}
    result["reasoning"] = {"status": "未检测", "detail": "推理字段依赖模型配置，不由请求接受结果推断"}
    return result


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
