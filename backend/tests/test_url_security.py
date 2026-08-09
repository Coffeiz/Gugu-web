import ipaddress

import pytest

from app.core.url_security import is_blocked_ip, resolve_pinned_ip, url_is_safe


def test_url_security_rejects_local_and_metadata_addresses():
    assert url_is_safe("http://127.0.0.1/file")
    assert url_is_safe("http://169.254.169.254/latest/meta-data")


def test_url_security_rejects_non_http_schemes():
    assert url_is_safe("file:///etc/passwd") == "只支持 http/https 链接"


def test_url_security_rejects_ipv4_mapped_ipv6():
    assert is_blocked_ip(ipaddress.ip_address("::ffff:127.0.0.1"))


def test_url_security_rejects_cgnat_shared_address_space():
    """code review 发现的真实漏洞：100.64.0.0/10（CGNAT/共享地址空间）is_private
    是 False，旧的枚举写法（is_private/is_loopback/...）完全不会拦截它；运营商
    CGNAT、部分 overlay/私有组网都可能用这一段，必须拦。改用 `not is_global` 后
    天然覆盖，不需要专门枚举这个特例。"""
    assert is_blocked_ip(ipaddress.ip_address("100.64.0.1"))
    assert is_blocked_ip(ipaddress.ip_address("100.100.100.1"))   # 段内任意地址


def test_url_security_rejects_ipv4_mapped_cgnat():
    """IPv4-mapped IPv6 形式的 CGNAT 地址同样要拦——is_blocked_ip 先解开
    ipv4_mapped 再判断 is_global，两层例外叠加时也不能漏。"""
    assert is_blocked_ip(ipaddress.ip_address("::ffff:100.64.0.1"))


def test_url_security_allows_public_ip():
    """确认改用 not is_global 后没有误伤正常公网地址（回归对照用例）。"""
    assert not is_blocked_ip(ipaddress.ip_address("93.184.216.34"))


def test_url_security_rejects_mixed_dns_results(monkeypatch):
    import socket

    def mixed_results(*_args, **_kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0)),
        ]

    monkeypatch.setattr(socket, "getaddrinfo", mixed_results)
    assert url_is_safe("https://rebind.example")


def test_resolve_pinned_ip_returns_safe_ip(monkeypatch):
    import socket

    def safe_result(*_args, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", safe_result)
    ip, error = resolve_pinned_ip("https://example.com/img.jpg")
    assert error is None
    assert ip == "93.184.216.34"


def test_resolve_pinned_ip_rejects_blocked_address(monkeypatch):
    import socket

    def blocked_result(*_args, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", blocked_result)
    ip, error = resolve_pinned_ip("https://evil.example/img.jpg")
    assert ip is None
    assert "内网" in error


def test_resolve_pinned_ip_rejects_mixed_dns_results(monkeypatch):
    """DNS rebinding 场景之一：域名同时解析出公网+内网 IP，整体拒绝（不猜会连到哪个）。"""
    import socket

    def mixed_results(*_args, **_kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0)),
        ]

    monkeypatch.setattr(socket, "getaddrinfo", mixed_results)
    ip, error = resolve_pinned_ip("https://rebind.example/img.jpg")
    assert ip is None
    assert error is not None


@pytest.mark.asyncio
async def test_web_pinned_backend_uses_resolved_ip(monkeypatch):
    from agent.tools.web import _PinnedAsyncNetworkBackend

    calls = {}

    class _Backend:
        async def connect_tcp(self, host, port, **kwargs):
            calls["host"] = host
            calls["port"] = port
            return "stream"

        async def connect_unix_socket(self, *args, **kwargs):
            raise AssertionError("不应连接 Unix socket")

        async def sleep(self, seconds):
            return None

    backend = _PinnedAsyncNetworkBackend("93.184.216.34")
    backend._backend = _Backend()
    result = await backend.connect_tcp("rebind.example", 443)
    assert result == "stream"
    assert calls == {"host": "93.184.216.34", "port": 443}


def test_build_pinned_request_connects_to_resolved_ip_not_hostname(monkeypatch):
    """关键回归：真正发起连接的 URL 必须是校验时解析到的 IP，而不是重新交给 httpx 用
    域名自己再 resolve 一次——否则 DNS rebinding 窗口依然存在（校验一次、连接再解析一次）。"""
    import socket

    from agent.tools.files import _build_pinned_request

    def safe_result(*_args, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", safe_result)

    captured = {}

    class _FakeClient:
        def build_request(self, method, url, headers=None, extensions=None):
            captured["method"] = method
            captured["url"] = url
            captured["headers"] = headers
            captured["extensions"] = extensions
            return "request-object"

    req, error = _build_pinned_request(_FakeClient(), "GET", "https://rebind.example/img.jpg")
    assert error is None
    assert req == "request-object"
    # 实际请求打到解析出的 IP，不是域名——域名只留在 Host 头和 SNI 里保证证书校验/路由正确。
    assert "93.184.216.34" in captured["url"]
    assert "rebind.example" not in captured["url"]
    assert captured["headers"]["Host"] == "rebind.example"
    assert captured["extensions"]["sni_hostname"] == "rebind.example"


def test_build_pinned_request_propagates_block_reason(monkeypatch):
    import socket

    from agent.tools.files import _build_pinned_request

    def blocked_result(*_args, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", blocked_result)
    req, error = _build_pinned_request(object(), "GET", "https://evil.example/img.jpg")
    assert req is None
    assert "内网" in error
