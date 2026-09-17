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


def openai_transient_error(exc: BaseException) -> bool:
    """OpenAI 兼容链路的瞬时错误判定（与 app/core/retry.py 的统一节奏配套）。

    标准 429/超时/网络/5xx 之外，非标准状态码（如 MiniMax 的 529 过载）会落进
    通用 APIStatusError，按状态码 ≥500 认定瞬时。
    """
    import openai

    if isinstance(exc, (openai.RateLimitError, openai.APITimeoutError,
                        openai.APIConnectionError, openai.InternalServerError)):
        return True
    return (isinstance(exc, openai.APIStatusError)
            and int(getattr(exc, "status_code", 0) or 0) >= 500)


def openai_error_kind(exc: BaseException) -> str:
    """脱敏类别标签：随 retry 事件给前端状态行显示，不带上游正文。"""
    import openai

    if isinstance(exc, openai.RateLimitError):
        return "rate_limited"
    status_code = getattr(exc, "status_code", None)
    if isinstance(status_code, int) and status_code == 529:
        return "overloaded"
    if isinstance(exc, openai.APITimeoutError):
        return "timeout"
    if isinstance(exc, openai.APIConnectionError):
        return "network"
    if isinstance(exc, openai.InternalServerError):
        return "server_error"
    if isinstance(status_code, int):
        return f"http_{status_code}"
    return type(exc).__name__.lower()


def upstream_busy_status(error: BaseException) -> bool:
    """异常链里是否出现「provider 忙碌」状态（429 限流 / 529 过载）。

    按状态码判定、与具体 SDK 解耦：anthropic 与 openai 两条链路的限流/过载
    异常都带 status_code，用一套口径统一忙碌文案的归类。
    """
    busy_codes = {429, 529}
    for current in _exception_chain(error):
        status_code = getattr(current, "status_code", None)
        if isinstance(status_code, int) and status_code in busy_codes:
            return True
    return False
