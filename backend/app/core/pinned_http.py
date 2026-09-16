"""IP 钉扎 HTTP 传输：配合 url_security.resolve_pinned_ip() 防 DNS rebinding。

从 agent/tools/web.py 上提为共享模块（MCP 客户端等也需要同样的
「校验过的 IP 即连接目标」语义），行为与原实现完全一致：
httpcore 仍然收到原始 hostname，HTTPS 证书校验和 SNI 不变；只有 socket
建连目标被替换为已校验的 IP。
"""
from __future__ import annotations

import httpcore
import httpx


class PinnedAsyncNetworkBackend(httpcore.AsyncNetworkBackend):
    """把 TCP 连接固定到已通过 URL 安全检查的 IP。"""

    def __init__(self, ip: str):
        from httpcore._backends.auto import AutoBackend

        self._ip = ip
        self._backend = AutoBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        return await self._backend.connect_tcp(
            self._ip,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        return await self._backend.connect_unix_socket(
            path, timeout=timeout, socket_options=socket_options
        )

    async def sleep(self, seconds):
        return await self._backend.sleep(seconds)


class PinnedHTTPTransport(httpx.AsyncHTTPTransport):
    """httpx transport：保留 hostname 的 HTTP 语义，固定 socket 目的 IP。"""

    def __init__(self, ip: str):
        super().__init__(trust_env=False)
        previous = self._pool
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=previous._ssl_context,
            max_connections=previous._max_connections,
            max_keepalive_connections=previous._max_keepalive_connections,
            keepalive_expiry=previous._keepalive_expiry,
            http1=previous._http1,
            http2=previous._http2,
            retries=previous._retries,
            network_backend=PinnedAsyncNetworkBackend(ip),
            socket_options=previous._socket_options,
        )
