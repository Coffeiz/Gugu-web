"""安全出站 HTTP：SSRF 校验、显式代理和已校验 IP 连接钉扎。"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
import ssl
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import httpcore
import httpx
from httpcore._async.http_proxy import AsyncTunnelHTTPConnection, merge_headers
from httpcore._exceptions import ProxyError
from httpcore._models import Request as CoreRequest, URL
from httpcore._ssl import default_ssl_context
from httpcore._trace import Trace
from httpcore._async.http_proxy import logger as httpcore_logger

from app.core.config import SafeEgressSettings, get_settings
from app.core.url_security import is_blocked_ip

DOH_URL = "https://cloudflare-dns.com/dns-query"


class SafeEgressError(RuntimeError):
    """无敏感值的安全出站错误。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def validate_proxy_url(value: str) -> str:
    """验证代理地址并规范化；认证信息必须通过独立加密字段传递。"""
    raw = (value or "").strip()
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("代理地址格式无效") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("代理地址必须是 HTTP 或 HTTPS URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("代理地址不能包含账号密码，请使用独立认证字段")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("代理地址不能包含路径、查询参数或片段")
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("代理端口无效")
    host = parsed.hostname
    if any(ord(char) < 33 or ord(char) == 127 for char in host):
        raise ValueError("代理主机名无效")
    return raw.rstrip("/")


def _proxy_auth(settings: SafeEgressSettings) -> tuple[str, str] | None:
    token = settings.proxy_auth_secret
    if not token:
        return None
    from app.core.crypto import decrypt_secret

    try:
        value = json.loads(decrypt_secret(token))
    except (TypeError, ValueError, json.JSONDecodeError):
        raise SafeEgressError("proxy_config_invalid", "代理认证配置不可读取，请重新保存")
    username = value.get("username", "") if isinstance(value, dict) else ""
    password = value.get("password", "") if isinstance(value, dict) else ""
    if not isinstance(username, str) or not isinstance(password, str):
        raise SafeEgressError("proxy_config_invalid", "代理认证配置无效，请重新保存")
    return (username, password) if username or password else None


def _caused_by_tls_error(error: BaseException) -> bool:
    """判断传输异常链是否包含 TLS 握手或证书验证错误。"""
    pending = [error]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, ssl.SSLError):
            return True
        if current.__cause__ is not None:
            pending.append(current.__cause__)
        if current.__context__ is not None:
            pending.append(current.__context__)
    return False


def _httpcore_proxy(settings: SafeEgressSettings) -> httpcore.Proxy:
    url = validate_proxy_url(settings.proxy_url)
    auth = _proxy_auth(settings)
    return httpcore.Proxy(
        url=url,
        auth=(auth[0].encode("utf-8"), auth[1].encode("utf-8")) if auth else None,
    )


def build_httpx_proxy(settings: SafeEgressSettings) -> httpx.Proxy:
    """把管理员配置的代理转换为 HTTPX 代理，复用已加密的认证信息。"""
    return _to_httpx_proxy(_httpcore_proxy(settings))


def _to_httpx_proxy(proxy: httpcore.Proxy) -> httpx.Proxy:
    scheme = proxy.url.scheme.decode("ascii")
    host = proxy.url.host.decode("ascii")
    if b":" in proxy.url.host and not host.startswith("["):
        host = f"[{host}]"
    url = f"{scheme}://{host}:{proxy.url.port}"
    auth = (
        (proxy.auth[0].decode("utf-8"), proxy.auth[1].decode("utf-8"))
        if proxy.auth else None
    )
    return httpx.Proxy(url, auth=auth, headers=proxy.headers, ssl_context=proxy.ssl_context)


async def _query_doh(host: str, record_type: str, proxy: httpcore.Proxy) -> list[dict]:
    """经显式代理查询受控 DoH；不使用环境代理，也不回退系统 DNS。"""
    try:
        configured_proxy = _to_httpx_proxy(proxy)
        async with httpx.AsyncClient(
            proxy=configured_proxy,
            trust_env=False,
            timeout=httpx.Timeout(10.0),
            follow_redirects=False,
            headers={"accept": "application/dns-json"},
        ) as client:
            response = await client.get(DOH_URL, params={"name": host, "type": record_type})
            response.raise_for_status()
            payload = response.json()
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 407:
            raise SafeEgressError("proxy_unavailable", "代理认证失败（HTTP 407）") from exc
        raise SafeEgressError("resolver_unavailable", "安全 DNS 服务返回错误状态") from exc
    except (httpx.ProxyError, httpx.ConnectError) as exc:
        raise SafeEgressError("proxy_unavailable", "代理连接失败或代理拒绝建立隧道") from exc
    except Exception as exc:
        raise SafeEgressError("resolver_unavailable", "安全 DNS 查询失败（经代理）") from exc
    if not isinstance(payload, dict) or payload.get("Status") != 0:
        return []
    answer = payload.get("Answer", [])
    return answer if isinstance(answer, list) else []


def _normalize_host(host: str) -> str:
    try:
        return host.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise SafeEgressError("invalid_url", "URL 主机名无效") from exc


async def _resolve_public_ip(host: str, proxy: httpcore.Proxy | None) -> str:
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if is_blocked_ip(literal):
            raise SafeEgressError("non_public_destination", "目标地址不是公网地址，已拒绝请求")
        return str(literal)

    normalized = _normalize_host(host)
    if proxy is None:
        addresses = await _resolve_system_dns(normalized)
    else:
        addresses = await _resolve_proxy_doh(normalized, proxy)
    return addresses[0]


async def _resolve_system_dns(host: str) -> list[str]:
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except Exception as exc:
        raise SafeEgressError("resolver_unavailable", "域名解析失败") from exc
    addresses = []
    for info in infos:
        try:
            value = info[4][0]
        except (IndexError, TypeError):
            continue
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            continue
        if is_blocked_ip(address):
            raise SafeEgressError("non_public_destination", "域名解析包含非公网地址，已拒绝请求")
        addresses.append(str(address))
    if not addresses:
        raise SafeEgressError("resolver_unavailable", "域名解析失败")
    return addresses


async def _resolve_proxy_doh(host: str, proxy: httpcore.Proxy) -> list[str]:
    answers = await asyncio.gather(
        _query_doh(host, "A", proxy),
        _query_doh(host, "AAAA", proxy),
    )
    addresses: list[str] = []
    cname_targets: set[str] = set()
    for records in answers:
        found_addresses, found_cnames = _parse_doh_records(records)
        addresses.extend(found_addresses)
        cname_targets.update(found_cnames)
    if not addresses:
        raise SafeEgressError("resolver_unavailable", "安全 DNS 未返回公网地址")
    # 拒绝明显的循环 CNAME/异常链；DoH 响应通常含递归解析后的全链记录。
    if host in cname_targets:
        raise SafeEgressError("resolver_unavailable", "安全 DNS 返回了循环别名")
    return addresses


def _parse_doh_records(records: list[dict]) -> tuple[list[str], set[str]]:
    addresses: list[str] = []
    cname_targets: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            continue
        value = record.get("data")
        kind = record.get("type")
        if kind in (1, 28) and isinstance(value, str):
            try:
                address = ipaddress.ip_address(value)
            except ValueError as exc:
                raise SafeEgressError("resolver_unavailable", "安全 DNS 返回了无效地址") from exc
            if is_blocked_ip(address):
                raise SafeEgressError("non_public_destination", "域名解析包含非公网地址，已拒绝请求")
            addresses.append(str(address))
        elif kind == 5 and isinstance(value, str):
            cname_targets.add(_normalize_host(value))
    return addresses, cname_targets


class _PinnedProxyTunnel(AsyncTunnelHTTPConnection):
    """httpcore 代理隧道连接：CONNECT 使用 IP，TLS/HTTP 使用原始域名。"""

    def __init__(self, *, pinned_ip: str, **kwargs):
        super().__init__(**kwargs)
        self._pinned_ip = pinned_ip.encode("ascii")

    async def handle_async_request(self, request: httpcore.Request) -> httpcore.Response:
        # 维持 httpcore 的 tunnel 生命周期，只把 CONNECT 目标替换为已校验 IP；
        # 与上游实现不同，TLS SNI 和后续 HTTP origin 始终使用原始 URL hostname。
        from httpcore._async.http11 import AsyncHTTP11Connection

        # This method mirrors the pinned httpcore tunnel lifecycle while changing only
        # the CONNECT authority; the request-origin hostname remains intact.
        timeouts = request.extensions.get("timeout", {})
        timeout = timeouts.get("connect", None)
        async with self._connect_lock:
            if not self._connected:
                target_host = self._pinned_ip
                if b":" in target_host and not target_host.startswith(b"["):
                    target_host = b"[" + target_host + b"]"
                target = b"%b:%d" % (target_host, self._remote_origin.port)
                connect_url = URL(
                    scheme=self._proxy_origin.scheme,
                    host=self._proxy_origin.host,
                    port=self._proxy_origin.port,
                    target=target,
                )
                connect_headers = merge_headers(
                    [(b"Host", target), (b"Accept", b"*/*")], self._proxy_headers
                )
                connect_request = CoreRequest(
                    method=b"CONNECT", url=connect_url, headers=connect_headers,
                    extensions=request.extensions,
                )
                connect_response = await self._connection.handle_async_request(connect_request)
                if connect_response.status < 200 or connect_response.status > 299:
                    reason = connect_response.extensions.get("reason_phrase", b"").decode("ascii", errors="ignore")
                    await self._connection.aclose()
                    raise ProxyError(f"{connect_response.status} {reason}")
                stream = connect_response.extensions["network_stream"]
                if self._remote_origin.scheme == b"https":
                    ssl_context = self._ssl_context or default_ssl_context()
                    alpn = ["http/1.1", "h2"] if self._http2 else ["http/1.1"]
                    ssl_context.set_alpn_protocols(alpn)
                    async with Trace("start_tls", httpcore_logger, request, {"server_hostname": self._remote_origin.host.decode("ascii")}):
                        stream = await stream.start_tls(
                            ssl_context=ssl_context,
                            server_hostname=self._remote_origin.host.decode("ascii"),
                            timeout=timeout,
                        )
                    ssl_object = stream.get_extra_info("ssl_object")
                    use_h2 = ssl_object is not None and ssl_object.selected_alpn_protocol() == "h2"
                else:
                    use_h2 = False
                if use_h2 or (self._http2 and not self._http1):
                    from httpcore._async.http2 import AsyncHTTP2Connection

                    self._connection = AsyncHTTP2Connection(origin=self._remote_origin, stream=stream, keepalive_expiry=self._keepalive_expiry)
                else:
                    self._connection = AsyncHTTP11Connection(origin=self._remote_origin, stream=stream, keepalive_expiry=self._keepalive_expiry)
                self._connected = True
        return await self._connection.handle_async_request(request)


class _PinnedProxyPool(httpcore.AsyncConnectionPool):
    def __init__(self, *, pinned_ip: str, proxy: httpcore.Proxy, **kwargs):
        self._pinned_ip = pinned_ip
        super().__init__(proxy=proxy, **kwargs)

    def create_connection(self, origin: httpcore.Origin) -> httpcore.AsyncConnectionInterface:
        if self._proxy is None:
            return super().create_connection(origin)
        return _PinnedProxyTunnel(
            pinned_ip=self._pinned_ip,
            proxy_origin=self._proxy.url.origin,
            proxy_headers=self._proxy.headers,
            proxy_ssl_context=self._proxy.ssl_context,
            remote_origin=origin,
            ssl_context=self._ssl_context,
            keepalive_expiry=self._keepalive_expiry,
            http1=self._http1,
            http2=self._http2,
            network_backend=self._network_backend,
            socket_options=self._socket_options,
        )


class _PinnedProxyTransport(httpx.AsyncHTTPTransport):
    def __init__(self, *, pinned_ip: str, proxy: httpcore.Proxy):
        super().__init__(trust_env=False, http2=True)
        previous = self._pool
        self._pool = _PinnedProxyPool(
            pinned_ip=pinned_ip,
            proxy=proxy,
            ssl_context=previous._ssl_context,
            max_connections=previous._max_connections,
            max_keepalive_connections=previous._max_keepalive_connections,
            keepalive_expiry=previous._keepalive_expiry,
            http1=previous._http1,
            http2=previous._http2,
            retries=0,
            network_backend=previous._network_backend,
            socket_options=previous._socket_options,
        )


class SafeEgressClient:
    """用途受限的 GET client；代理和 SSRF 策略由服务端配置决定。"""

    def __init__(self, settings: SafeEgressSettings | None = None):
        self.settings = settings or get_settings().safe_egress.model_copy(deep=True)

    async def resolve(self, url: str) -> tuple[str, httpcore.Proxy | None]:
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError as exc:
            raise SafeEgressError("invalid_url", "URL 格式无效") from exc
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise SafeEgressError("invalid_url", "只支持包含主机名的 HTTP 或 HTTPS URL")
        if parsed.username is not None or parsed.password is not None:
            raise SafeEgressError("invalid_url", "URL 不能包含账号密码")
        if port is not None and not 1 <= port <= 65535:
            raise SafeEgressError("invalid_url", "URL 端口无效")
        proxy = _httpcore_proxy(self.settings) if self.settings.enabled else None
        address = await _resolve_public_ip(parsed.hostname, proxy)
        return address, proxy

    @asynccontextmanager
    async def stream(
        self,
        url: str,
        *,
        timeout: float | httpx.Timeout,
        headers: dict[str, str] | None = None,
    ):
        address, proxy = await self.resolve(url)
        if proxy is None:
            from app.core.pinned_http import PinnedHTTPTransport

            transport = PinnedHTTPTransport(address)
        else:
            transport = _PinnedProxyTransport(pinned_ip=address, proxy=proxy)
        async with httpx.AsyncClient(
            timeout=timeout if isinstance(timeout, httpx.Timeout) else httpx.Timeout(timeout),
            follow_redirects=False,
            transport=transport,
        ) as client:
            try:
                async with client.stream("GET", url, headers=headers or {}) as response:
                    yield response
            except Exception as exc:
                if _caused_by_tls_error(exc):
                    raise SafeEgressError(
                        "tls_verification_failed",
                        "目标站点 TLS 握手或证书验证失败，已拒绝连接",
                    ) from exc
                raise
