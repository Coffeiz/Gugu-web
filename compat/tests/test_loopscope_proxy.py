"""LoopScope只读代理的Python直接行为对照，合成Collector且不连接真实服务。"""
import asyncio

import httpx
from fastapi import HTTPException
from starlette.requests import Request

from app.api.v1 import loopscope as api


def test_proxy_keeps_repeated_query_and_safe_headers_without_forwarding_credentials(monkeypatch):
    seen = []
    async def collector(request):
        seen.append(request)
        return httpx.Response(302 if request.url.path.endswith("health") else 200,
                              content=b'{"ok":true}', headers={"content-type": "application/json", "etag": "synthetic-etag", "x-private": "private", "location": "/forbidden"})
    original = httpx.AsyncClient
    monkeypatch.setattr(api.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(collector), **kwargs))
    monkeypatch.setenv("LOOPSCOPE_ENDPOINT", "http://collector.example.test")
    request = Request({"type": "http", "query_string": b"tag=a&tag=b", "headers": [(b"authorization", b"synthetic-user-token")]})
    async def scenario():
        result = await api.proxy_loopscope_read("sessions", request, object())
        assert result.status_code == 200
        assert result.body == b'{"ok":true}'
        assert result.headers["etag"] == "synthetic-etag"
        assert "x-private" not in result.headers
        assert list(seen[0].url.params.multi_items()) == [("tag", "a"), ("tag", "b")]
        assert "authorization" not in seen[0].headers
        assert "cookie" not in seen[0].headers
        assert (await api.proxy_loopscope_read("health", request, object())).status_code == 302
        assert len(seen) == 2
        try:
            await api.proxy_loopscope_read("private", request, object())
            assert False, "非白名单路径必须拒绝"
        except HTTPException as exc:
            assert exc.status_code == 404
    asyncio.run(scenario())
