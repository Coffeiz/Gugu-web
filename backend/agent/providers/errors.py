"""Provider 错误来源判断。

这里只判断异常是否带有上游 HTTP 响应，不解释供应商返回的具体错误码，
避免把 provider 的业务错误映射成一套脆弱的本地错误枚举。
"""
from __future__ import annotations

from collections.abc import Iterator


def _exception_chain(error: BaseException) -> Iterator[BaseException]:
    """遍历 cause/context 链，兼容 RetryableError 等包装异常。"""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def is_provider_http_error(error: BaseException) -> bool:
    """判断异常链中是否存在 provider 返回的 HTTP 错误。"""
    for current in _exception_chain(error):
        status_code = getattr(current, "status_code", None)
        if isinstance(status_code, int) and 400 <= status_code <= 599:
            return True
        response = getattr(current, "response", None)
        response_status = getattr(response, "status_code", None)
        if isinstance(response_status, int) and 400 <= response_status <= 599:
            return True
    return False
