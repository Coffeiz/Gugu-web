from __future__ import annotations

import json
import ssl
from types import SimpleNamespace

import httpcore
import httpx
import pytest

from app.core import safe_egress
from app.core.config import SafeEgressSettings
from app.api.v1 import safe_egress_admin


def test_proxy_url_requires_a_separate_auth_field():
    assert safe_egress.validate_proxy_url("http://proxy.example:3128/") == "http://proxy.example:3128"
    with pytest.raises(ValueError, match="不能包含账号密码"):
        safe_egress.validate_proxy_url("http://user:secret@proxy.example:3128")
    with pytest.raises(ValueError, match="不能包含路径"):
        safe_egress.validate_proxy_url("http://proxy.example:3128/path")


@pytest.mark.asyncio
async def test_client_classifies_tls_certificate_failures_separately(monkeypatch):
    async def resolve(_self, _url):
        return "93.184.216.34", None

    class FailingStream:
        async def __aenter__(self):
            try:
                raise ssl.SSLCertVerificationError("certificate rejected")
            except ssl.SSLError as cause:
                request = httpx.Request("GET", "https://example.net")
                raise httpx.ConnectError("connection failed", request=request) from cause

        async def __aexit__(self, *_args):
            return False

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        def stream(self, *_args, **_kwargs):
            return FailingStream()

    monkeypatch.setattr(safe_egress.SafeEgressClient, "resolve", resolve)
    monkeypatch.setattr(safe_egress.httpx, "AsyncClient", FakeClient)
    client = safe_egress.SafeEgressClient(SafeEgressSettings())

    with pytest.raises(safe_egress.SafeEgressError) as caught:
        async with client.stream("https://example.net", timeout=5.0):
            pass

    assert caught.value.code == "tls_verification_failed"
    assert "certificate rejected" not in caught.value.message


@pytest.mark.asyncio
async def test_proxy_resolution_rejects_any_non_public_dns_answer(monkeypatch):
    async def fake_query(host: str, record_type: str, proxy: httpcore.Proxy):
        if record_type == "A":
            return [
                {"type": 5, "data": "edge.example.net."},
                {"type": 1, "data": "203.0.113.10"},
            ]
        return [{"type": 28, "data": "2606:4700:4700::1111"}]

    monkeypatch.setattr(safe_egress, "_query_doh", fake_query)
    proxy = httpcore.Proxy("http://proxy.example:3128")
    with pytest.raises(safe_egress.SafeEgressError) as caught:
        await safe_egress._resolve_public_ip("example.net", proxy)
    assert caught.value.code == "non_public_destination"


@pytest.mark.asyncio
async def test_enabled_proxy_doh_failure_does_not_fall_back_to_system_dns(monkeypatch):
    async def fail_doh(*_args, **_kwargs):
        raise safe_egress.SafeEgressError("resolver_unavailable", "安全 DNS 查询失败（经代理）")

    def unexpected_system_dns(*_args, **_kwargs):
        raise AssertionError("system DNS fallback must not run when proxy mode is enabled")

    monkeypatch.setattr(safe_egress, "_query_doh", fail_doh)
    monkeypatch.setattr(safe_egress.socket, "getaddrinfo", unexpected_system_dns)
    client = safe_egress.SafeEgressClient(SafeEgressSettings(enabled=True, proxy_url="http://proxy.example:3128"))
    with pytest.raises(safe_egress.SafeEgressError) as caught:
        await client.resolve("https://example.net")
    assert caught.value.code == "resolver_unavailable"


@pytest.mark.asyncio
async def test_proxy_connect_uses_pinned_ip_and_tls_uses_original_hostname(monkeypatch):
    calls = []

    class FakeStream:
        def __init__(self):
            self.hostname = None

        async def start_tls(self, *, ssl_context, server_hostname, timeout):
            self.hostname = server_hostname
            return self

        def get_extra_info(self, key):
            if key == "ssl_object":
                return self
            return None

        def selected_alpn_protocol(self):
            return "http/1.1"

    class FakeConnection:
        def __init__(self):
            self.stream = FakeStream()

        async def handle_async_request(self, request):
            calls.append(request)
            if request.method == b"CONNECT":
                return httpcore.Response(200, extensions={"network_stream": self.stream})
            return httpcore.Response(200)

        async def aclose(self):
            return None

    class FakeHTTP11Connection:
        def __init__(self, *, origin, stream, keepalive_expiry):
            self.origin = origin
            self.stream = stream

        async def handle_async_request(self, request):
            calls.append(request)
            return httpcore.Response(200)

    monkeypatch.setattr("httpcore._async.http11.AsyncHTTP11Connection", FakeHTTP11Connection)

    proxy = httpcore.Proxy("http://proxy.example:3128")
    connection = safe_egress._PinnedProxyTunnel(
        pinned_ip="93.184.216.34",
        proxy_origin=proxy.url.origin,
        proxy_headers=proxy.headers,
        proxy_ssl_context=proxy.ssl_context,
        remote_origin=httpcore.Origin(b"https", b"example.net", 443),
        ssl_context=None,
        keepalive_expiry=None,
        http1=True,
        http2=False,
    )
    connection._connection = FakeConnection()
    request = httpcore.Request(
        b"GET",
        httpcore.URL(scheme=b"https", host=b"example.net", port=443, target=b"/"),
        extensions={"timeout": {"connect": 1}},
    )
    await connection.handle_async_request(request)
    connect_request = calls[0]
    assert connect_request.method == b"CONNECT"
    assert connect_request.url.target == b"93.184.216.34:443"
    assert connection._connection.stream.hostname == "example.net"
    assert calls[1].url.host == b"example.net"


@pytest.mark.asyncio
async def test_ipv6_connect_authority_is_bracketed_and_keeps_tls_name(monkeypatch):
    calls = []

    class FakeStream:
        hostname = None

        async def start_tls(self, *, ssl_context, server_hostname, timeout):
            self.hostname = server_hostname
            return self

        def get_extra_info(self, key):
            return self if key == "ssl_object" else None

        def selected_alpn_protocol(self):
            return "http/1.1"

    class FakeConnection:
        def __init__(self):
            self.stream = FakeStream()

        async def handle_async_request(self, request):
            calls.append(request)
            return httpcore.Response(200, extensions={"network_stream": self.stream}) if request.method == b"CONNECT" else httpcore.Response(200)

        async def aclose(self):
            return None

    class FakeHTTP11Connection:
        def __init__(self, *, origin, stream, keepalive_expiry):
            self.origin = origin
            self.stream = stream

        async def handle_async_request(self, request):
            calls.append(request)
            return httpcore.Response(200)

    monkeypatch.setattr("httpcore._async.http11.AsyncHTTP11Connection", FakeHTTP11Connection)

    proxy = httpcore.Proxy("http://proxy.example:3128")
    connection = safe_egress._PinnedProxyTunnel(
        pinned_ip="2606:4700:4700::1111", proxy_origin=proxy.url.origin,
        proxy_headers=proxy.headers, proxy_ssl_context=proxy.ssl_context,
        remote_origin=httpcore.Origin(b"https", b"example.net", 443),
        ssl_context=None, keepalive_expiry=None, http1=True, http2=False,
    )
    connection._connection = FakeConnection()
    request = httpcore.Request(b"GET", httpcore.URL(scheme=b"https", host=b"example.net", port=443, target=b"/"))
    await connection.handle_async_request(request)
    assert calls[0].url.target == b"[2606:4700:4700::1111]:443"
    assert connection._connection.stream.hostname == "example.net"


@pytest.mark.asyncio
async def test_admin_read_does_not_return_proxy_auth_secret(monkeypatch):
    secret = "gcm1:must-not-be-returned"
    monkeypatch.setattr(
        safe_egress_admin,
        "get_settings",
        lambda: SimpleNamespace(safe_egress=SafeEgressSettings(
            enabled=True, proxy_url="http://proxy.example:3128", proxy_auth_secret=secret,
        )),
    )
    result = await safe_egress_admin.get_safe_egress_config()
    assert result == {
        "enabled": True,
        "proxy_url": "http://proxy.example:3128",
        "has_auth": True,
    }
    assert secret not in repr(result)


@pytest.mark.asyncio
async def test_admin_patch_preserves_unsent_password_and_encrypts_updated_auth(monkeypatch):
    monkeypatch.setattr(
        safe_egress_admin,
        "get_settings",
        lambda: SimpleNamespace(safe_egress=SafeEgressSettings(
            enabled=True, proxy_url="http://proxy.example:3128",
        )),
    )
    monkeypatch.setattr(safe_egress_admin, "_current_auth", lambda: ("old-user", "old-password"))
    captured = {}

    def encrypt(username, password):
        captured["auth"] = (username, password)
        return "encrypted-auth"

    async def save_override(patch):
        captured["patch"] = patch

    monkeypatch.setattr(safe_egress_admin, "_encrypted_auth", encrypt)
    monkeypatch.setattr(safe_egress_admin, "save_override", save_override)
    result = await safe_egress_admin.patch_safe_egress_config(
        safe_egress_admin.SafeEgressPatch(proxy_password="new-password"),
    )
    assert captured["auth"] == ("old-user", "new-password")
    assert captured["patch"]["safe_egress"]["proxy_auth_secret"] == "encrypted-auth"
    assert "new-password" not in repr(captured["patch"])
    assert result["has_auth"] is True


def test_safe_egress_override_loads_as_a_validated_settings_model(tmp_path, monkeypatch):
    from app.core import config

    override_file = tmp_path / "config.override.json"
    override_file.write_text(json.dumps({
        "safe_egress": {
            "enabled": True,
            "proxy_url": "http://proxy.example:3128",
            "proxy_auth_secret": "gcm1:opaque",
        },
    }), encoding="utf-8")
    monkeypatch.setattr(config, "OVERRIDE_FILE", override_file)
    settings = config.AppSettings().apply_override()
    assert isinstance(settings.safe_egress, SafeEgressSettings)
    assert settings.safe_egress.enabled is True
    assert settings.safe_egress.proxy_url == "http://proxy.example:3128"
    assert settings.safe_egress.proxy_auth_secret == "gcm1:opaque"


def test_generic_config_patch_cannot_persist_proxy_auth_in_plaintext(monkeypatch):
    from app.core import config, crypto

    monkeypatch.setattr(crypto, "encrypt_secret", lambda _value: "gcm1:opaque-ciphertext")
    prepared = config._protect_safe_egress_secret({
        "safe_egress": {"enabled": True, "proxy_auth_secret": "user:password"},
    })
    assert prepared["safe_egress"]["proxy_auth_secret"] == "gcm1:opaque-ciphertext"
    assert "user:password" not in repr(prepared)


def test_masked_proxy_auth_from_generic_config_patch_preserves_existing_secret():
    from app.core.config import _protect_safe_egress_secret

    prepared = _protect_safe_egress_secret({
        "safe_egress": {"enabled": True, "proxy_auth_secret": "****"},
    })
    assert prepared == {"safe_egress": {"enabled": True}}
