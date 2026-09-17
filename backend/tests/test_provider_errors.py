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


def test_provider_http_error_does_not_classify_internal_error():
    assert is_provider_http_error(RuntimeError("内部组装失败")) is False
