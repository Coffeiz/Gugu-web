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


def upstream_status_tag(error: BaseException) -> str:
    """脱敏技术标签：异常链里第一个带上游 HTTP 状态的异常 → 「状态码 类型名」。

    只暴露状态码与 SDK 异常类名（如 "529 OverloadedError"），不带上游响应
    正文、URL 或 provider 名——正文在 diag_log，标签随用户可见文案/前端
    message_params 走。找不到状态码时退回最外层异常类型名。
    """
    for current in _exception_chain(error):
        status_code = getattr(current, "status_code", None)
        if isinstance(status_code, int):
            return f"{status_code} {type(current).__name__}"
        response = getattr(current, "response", None)
        response_status = getattr(response, "status_code", None)
        if isinstance(response_status, int):
            return f"{response_status} {type(current).__name__}"
    return type(error).__name__
