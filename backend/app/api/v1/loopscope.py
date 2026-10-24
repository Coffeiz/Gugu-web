"""通过 Gugu 用户会话保护 LoopScope 的只读诊断 API。"""

import os
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from app.core.security import get_current_user

router = APIRouter(prefix="/dev/loopscope", tags=["loopscope"])

_SESSION_RUNS = re.compile(r"^sessions/[A-Za-z0-9:_-]+/runs$")
_RUN_RESOURCE = re.compile(r"^runs/[A-Za-z0-9_.:-]+(?:/(?:spans|context|usage))?$")
_HOP_BY_HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"}


def _collector_url(path: str) -> str:
    base = os.getenv("LOOPSCOPE_ENDPOINT", "http://127.0.0.1:4320").rstrip("/")
    if base.endswith("/api"):
        return f"{base}/{path}"
    return f"{base}/api/{path}"


def _allowed_path(path: str) -> bool:
    return path in {"health", "sessions", "reflections", "events"} or bool(
        _SESSION_RUNS.fullmatch(path) or _RUN_RESOURCE.fullmatch(path)
    )


def _response_headers(headers: httpx.Headers) -> dict[str, str]:
    return {
        name: value
        for name, value in headers.items()
        if name.lower() not in _HOP_BY_HOP_HEADERS
        and name.lower() in {"content-type", "cache-control", "last-modified", "etag"}
    }


@router.get("/{path:path}")
async def proxy_loopscope_read(
    path: str,
    request: Request,
    _current_user=Depends(get_current_user),
):
    """复用 Gugu 用户鉴权；只代理 LoopScope 已有的只读查询路径。"""
    if not _allowed_path(path):
        raise HTTPException(status_code=404, detail="LoopScope 路径不存在")

    url = _collector_url(path)
    params = list(request.query_params.multi_items())
    if path == "events":
        client = httpx.AsyncClient(timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0), follow_redirects=False)
        try:
            upstream_request = client.build_request("GET", url, params=params, headers={"Accept": "text/event-stream"})
            upstream = await client.send(upstream_request, stream=True)
        except httpx.RequestError:
            await client.aclose()
            raise HTTPException(status_code=503, detail="LoopScope Collector 暂不可用") from None

        if upstream.status_code >= 400:
            body = await upstream.aread()
            headers = _response_headers(upstream.headers)
            await upstream.aclose()
            await client.aclose()
            return Response(content=body, status_code=upstream.status_code, headers=headers)

        async def stream_events():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()
                await client.aclose()

        headers = _response_headers(upstream.headers)
        headers.setdefault("Cache-Control", "no-cache, no-transform")
        headers.setdefault("X-Accel-Buffering", "no")
        return StreamingResponse(
            stream_events(),
            status_code=upstream.status_code,
            media_type="text/event-stream",
            headers=headers,
        )

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            upstream = await client.get(url, params=params)
    except httpx.RequestError:
        raise HTTPException(status_code=503, detail="LoopScope Collector 暂不可用") from None

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_response_headers(upstream.headers),
    )
