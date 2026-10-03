import pytest

from agent.providers.errors import is_provider_http_error


class ProviderError(Exception):
    def __init__(self, status_code: int):
        self.status_code = status_code


def test_provider_http_error_detects_status_code():
    assert is_provider_http_error(ProviderError(400)) is True
    assert is_provider_http_error(ProviderError(503)) is True


def test_provider_http_error_detects_wrapped_provider_error():
    wrapped = RuntimeError("重试失败")
    wrapped.__cause__ = ProviderError(400)
    assert is_provider_http_error(wrapped) is True


@pytest.mark.parametrize(
    ("status_code", "expected"),
    [(399, False), (400, True), (599, True), (600, False)],
)
def test_provider_http_error_accepts_only_http_error_status_range(status_code, expected):
    """分类边界是 HTTP 4xx/5xx，不应把相邻状态范围误判为上游错误。"""
    assert is_provider_http_error(ProviderError(status_code)) is expected


def test_provider_http_error_reads_status_from_response_object():
    error = RuntimeError("上游请求失败")
    error.response = type("Response", (), {"status_code": 429})()

    assert is_provider_http_error(error) is True


def test_provider_http_error_does_not_classify_internal_error():
    assert is_provider_http_error(RuntimeError("内部组装失败")) is False
