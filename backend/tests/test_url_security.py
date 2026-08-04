from app.core.url_security import url_is_safe


def test_url_security_rejects_local_and_metadata_addresses():
    assert url_is_safe("http://127.0.0.1/file")
    assert url_is_safe("http://169.254.169.254/latest/meta-data")


def test_url_security_rejects_non_http_schemes():
    assert url_is_safe("file:///etc/passwd") == "只支持 http/https 链接"
