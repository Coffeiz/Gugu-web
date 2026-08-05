import ipaddress

from app.core.url_security import is_blocked_ip, url_is_safe


def test_url_security_rejects_local_and_metadata_addresses():
    assert url_is_safe("http://127.0.0.1/file")
    assert url_is_safe("http://169.254.169.254/latest/meta-data")


def test_url_security_rejects_non_http_schemes():
    assert url_is_safe("file:///etc/passwd") == "只支持 http/https 链接"


def test_url_security_rejects_ipv4_mapped_ipv6():
    assert is_blocked_ip(ipaddress.ip_address("::ffff:127.0.0.1"))


def test_url_security_rejects_mixed_dns_results(monkeypatch):
    import socket

    def mixed_results(*_args, **_kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0)),
        ]

    monkeypatch.setattr(socket, "getaddrinfo", mixed_results)
    assert url_is_safe("https://rebind.example")
