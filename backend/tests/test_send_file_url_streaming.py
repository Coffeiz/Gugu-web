"""send_file(url) 网络图片下载的 streaming 限流回归测试。

覆盖 PR #10 复审提出的 P1 DoS 面：旧实现用 httpx.get() 把整个响应读进内存后才检查
15MB 上限，群成员给一个 2GB 的 URL 会先把 2GB 全读进 RAM。新实现用 streaming +
累计限流，读取到上限附近就中止，不消费完整响应。
"""
import asyncio
import json

import httpx
import pytest

from agent.tools import files as im_files

# 与 files.py 保持一致
MAX_BYTES = im_files._SEND_URL_MAX_BYTES
CHUNK = 1024 * 1024   # 1MB


def _fake_build_pinned_request(client, method, url):
    """绕过真实 DNS 解析/IP pinning，测试只关心 streaming 限流逻辑本身。"""
    return client.build_request(method, url), None


class _FakeResp:
    """流式响应：连续吐 chunk，记录被消费的字节数。

    模拟真实 httpx 生命周期：client 关闭（__aexit__）后 response 的连接随之关闭，
    此时再 aiter_bytes() 会抛 ReadError——用于断言 body 必须在 AsyncClient 生命周期内消费。
    """

    def __init__(self, total_bytes: int, content_type: str = "image/jpeg"):
        self.status_code = 200
        self.headers = {"content-type": content_type}
        self._total = total_bytes
        self.consumed = 0
        self.closed = False
        self.client_closed = False

    async def aiter_bytes(self):
        if self.client_closed:
            raise httpx.ReadError("stream closed: client exited before body consumed")
        while self.consumed < self._total:
            n = min(CHUNK, self._total - self.consumed)
            self.consumed += n
            yield b"\x00" * n

    async def aclose(self):
        self.closed = True


class _FakeClient:
    def __init__(self, resp):
        self._resp = resp

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        # 模拟真实 AsyncClient：退出时关闭 transport，response 连接随之失效。
        self._resp.client_closed = True
        return False

    def build_request(self, method, url):
        return {"method": method, "url": url}

    async def send(self, request, stream=False):
        return self._resp


def _run(url: str, resp: _FakeResp):
    """在独立事件循环里跑 _send_file_from_url，返回 (结果, resp)。"""
    async def _inner():
        return await im_files._send_file_from_url("user-1", url, "测试图")

    result = asyncio.run(_inner())
    return result, resp


@pytest.mark.parametrize("total_bytes", [
    MAX_BYTES + CHUNK * 2,      # 略超上限（响应明显大于上限）
    MAX_BYTES * 2,              # 2 倍
    MAX_BYTES * 100,            # 100 倍（模拟 2GB 级 DoS）
])
def test_streaming_aborts_near_limit_not_full_body(monkeypatch, total_bytes):
    """chunked 响应连续吐 >15MB：读取到上限附近就中止，不消费完整响应。"""
    monkeypatch.setattr(im_files, "_build_pinned_request", _fake_build_pinned_request)
    resp = _FakeResp(total_bytes)
    client = _FakeClient(resp)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client)

    result, resp = _run("https://example.com/big.jpg", resp)

    # 返回「图片过大」错误
    assert isinstance(result, str)
    payload = json.loads(result)
    assert "图片过大" in payload["error"]
    # 消费的字节数在上限附近（超过 MAX 触发超限，但最多多一个 chunk），而不是把整个响应读完
    assert MAX_BYTES < resp.consumed <= MAX_BYTES + CHUNK
    assert resp.consumed < total_bytes, "不应消费完整响应（DoS 面）"


def test_streaming_accepts_under_limit(monkeypatch):
    """小于上限的图片正常下载成功。"""
    monkeypatch.setattr(im_files, "_build_pinned_request", _fake_build_pinned_request)
    resp = _FakeResp(CHUNK)   # 1MB
    client = _FakeClient(resp)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client)

    result, resp = _run("https://example.com/small.jpg", resp)

    assert isinstance(result, dict)
    assert result.get("ok") is True
    assert resp.consumed == CHUNK


def test_content_length_over_limit_rejected_before_read(monkeypatch):
    """Content-Length 声明就超限：不读 body 直接拒绝。"""
    monkeypatch.setattr(im_files, "_build_pinned_request", _fake_build_pinned_request)
    resp = _FakeResp(0)   # body 为空，但声明 Content-Length 超限
    resp.headers["content-length"] = str(MAX_BYTES * 2)
    client = _FakeClient(resp)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client)

    result, resp = _run("https://example.com/declared-big.jpg", resp)

    assert isinstance(result, str)
    payload = json.loads(result)
    assert "图片过大" in payload["error"]
    assert resp.consumed == 0, "Content-Length 超限不应读 body"


def test_send_file_disables_keepalive_to_prevent_cross_hop_tls_reuse(monkeypatch):
    """PR13 复审发现的问题：pin 到 IP 后，重定向多跳可能解析到同一个 IP（CDN 场景），
    httpcore 按 origin 复用连接池；但 sni_hostname 只在新建 TLS 连接时生效，复用连接
    不会重新握手，会出现"握手验证了 A 的证书，之后却拿这条连接发 Host: B"的 TLS
    hostname 隔离缺口。最简单的堵法是禁用 keep-alive，逼每一跳都新建连接/握手。"""
    monkeypatch.setattr(im_files, "_build_pinned_request", _fake_build_pinned_request)
    resp = _FakeResp(CHUNK)
    client = _FakeClient(resp)
    captured_kwargs = {}

    def fake_async_client(**kwargs):
        captured_kwargs.update(kwargs)
        return client

    monkeypatch.setattr(httpx, "AsyncClient", fake_async_client)

    _run("https://example.com/small.jpg", resp)

    limits = captured_kwargs.get("limits")
    assert limits is not None
    assert limits.max_keepalive_connections == 0


def test_build_pinned_request_host_header_keeps_non_default_port(monkeypatch):
    """非默认端口（如 :8443）的 Host 头必须带端口，否则部分虚拟主机/CDN 会路由错误
    （PR13 复审发现：之前只用 parsed.hostname，端口信息被丢掉了）。"""
    import socket

    from agent.tools.files import _build_pinned_request

    def safe_result(*_args, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", safe_result)

    captured = {}

    class _FakeClientForHost:
        def build_request(self, method, url, headers=None, extensions=None):
            captured["url"] = url
            captured["headers"] = headers
            return "request-object"

    req, error = _build_pinned_request(_FakeClientForHost(), "GET", "https://example.com:8443/a.png")
    assert error is None
    assert captured["headers"]["Host"] == "example.com:8443"
    assert "93.184.216.34:8443" in captured["url"]


def test_build_pinned_request_wraps_literal_ipv6_host_in_brackets(monkeypatch):
    """URL 本身就是字面 IPv6 地址（如 https://[2606:4700:4700::1111]/a.png）时，
    Host 头必须给 IPv6 地址加方括号——parsed.hostname 返回的是不带括号的裸地址，
    直接拼进 Host 头会因为地址内部的冒号被误当成端口分隔符而格式不合法
    （PR13 复审发现的 P3）。"""
    import socket

    from agent.tools.files import _build_pinned_request

    def safe_result(*_args, **_kwargs):
        return [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700:4700::1111", 0, 0, 0))]

    monkeypatch.setattr(socket, "getaddrinfo", safe_result)

    captured = {}

    class _FakeClientForHost:
        def build_request(self, method, url, headers=None, extensions=None):
            captured["url"] = url
            captured["headers"] = headers
            return "request-object"

    req, error = _build_pinned_request(
        _FakeClientForHost(), "GET", "https://[2606:4700:4700::1111]/a.png"
    )
    assert error is None
    assert captured["headers"]["Host"] == "[2606:4700:4700::1111]"


def test_build_pinned_request_wraps_literal_ipv6_host_with_port(monkeypatch):
    """字面 IPv6 地址 + 非默认端口同时出现时，Host 头应该是「[地址]:端口」。"""
    import socket

    from agent.tools.files import _build_pinned_request

    def safe_result(*_args, **_kwargs):
        return [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700:4700::1111", 0, 0, 0))]

    monkeypatch.setattr(socket, "getaddrinfo", safe_result)

    captured = {}

    class _FakeClientForHost:
        def build_request(self, method, url, headers=None, extensions=None):
            captured["headers"] = headers
            return "request-object"

    req, error = _build_pinned_request(
        _FakeClientForHost(), "GET", "https://[2606:4700:4700::1111]:8443/a.png"
    )
    assert error is None
    assert captured["headers"]["Host"] == "[2606:4700:4700::1111]:8443"
