"""Provider 错误来源判断。

判断上游 HTTP/流协议错误，并识别已经验证的不可重试输入拒绝。
不复制供应商错误码全集，不通过异常正文的模糊匹配决定重试。
"""
from __future__ import annotations

from collections.abc import Iterator


class ProviderInputRejected(RuntimeError):
    """上游明确拒绝输入；异常仅携带固定标签，不包含请求或响应正文。"""

    def __init__(self):
        super().__init__("input_sensitive")


class ResponsesStreamError(RuntimeError):
    """Responses 已建立连接后返回失败事件；消息只携带白名单诊断字段。"""


def is_responses_stream_error(error: BaseException) -> bool:
    """按异常类型识别上游失败事件，兼容主循环包装，避免误判内部异常。"""
    return any(isinstance(current, ResponsesStreamError) for current in _exception_chain(error))


def is_provider_input_rejected(error: BaseException) -> bool:
    """识别 MiniMax 兼容协议已验证的 1026 响应，包括被包装的 SDK 异常。"""
    for current in _exception_chain(error):
        body = getattr(current, "body", None)
        if not isinstance(body, dict):
            continue
        detail = body.get("error")
        if (isinstance(detail, dict)
                and detail.get("message") == "input new_sensitive (1026)"
                and is_provider_http_error(current)):
            return True
    return False


def _exception_chain(error: BaseException) -> Iterator[BaseException]:
    """遍历 cause/context 链，兼容 RetryableError 等包装异常。"""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def anthropic_stream_protocol_details(error: BaseException) -> dict[str, str | int] | None:
    """识别 SDK 累积事件时引用不存在的内容块，只提取类型与索引。

    SDK 当前会把这个协议错误抛成 IndexError。通过实际失败帧及其结构确认来源，
    避免把应用代码的 IndexError 或其他 SDK 编程错误误认成可恢复的上游坏流。
    """
    for current in _exception_chain(error):
        if not isinstance(current, IndexError):
            continue
        trace = current.__traceback__
        while trace is not None:
            frame = trace.tb_frame
            if (frame.f_globals.get("__name__") == "anthropic.lib.streaming._messages"
                    and frame.f_code.co_name == "accumulate_event"):
                event = frame.f_locals.get("event")
                snapshot = frame.f_locals.get("current_snapshot")
                event_type = getattr(event, "type", None)
                index = getattr(event, "index", None)
                content = getattr(snapshot, "content", None)
                if (event_type in {"content_block_stop", "content_block_delta"}
                        and type(index) is int and isinstance(content, list)
                        and not 0 <= index < len(content)):
                    return {"event_type": event_type, "index": index, "block_count": len(content)}
            trace = trace.tb_next
    return None


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


def upstream_status_code(error: BaseException) -> int | None:
    """返回异常链中第一个上游 HTTP 状态码。"""
    for current in _exception_chain(error):
        status_code = getattr(current, "status_code", None)
        if isinstance(status_code, int):
            return status_code
        response = getattr(current, "response", None)
        response_status = getattr(response, "status_code", None)
        if isinstance(response_status, int):
            return response_status
    return None


def openai_transient_error(exc: BaseException) -> bool:
    """OpenAI 兼容链路的瞬时错误判定（与 app/core/retry.py 的统一节奏配套）。

    标准 429/超时/网络/5xx 之外，非标准状态码（如 MiniMax 的 529 过载）会落进
    通用 APIStatusError，按状态码 ≥500 认定瞬时。
    """
    import openai
    import httpx

    if isinstance(exc, (openai.RateLimitError, openai.APITimeoutError,
                        openai.APIConnectionError, openai.InternalServerError,
                        httpx.TimeoutException, httpx.NetworkError,
                        httpx.RemoteProtocolError)):
        return True
    return (isinstance(exc, openai.APIStatusError)
            and int(getattr(exc, "status_code", 0) or 0) >= 500)


def openai_error_kind(exc: BaseException) -> str:
    """脱敏类别标签：随 retry 事件给前端状态行显示，不带上游正文。"""
    import openai
    import httpx

    if isinstance(exc, openai.RateLimitError):
        return "rate_limited"
    status_code = getattr(exc, "status_code", None)
    if isinstance(status_code, int) and status_code == 529:
        return "overloaded"
    if isinstance(exc, (openai.APITimeoutError, httpx.TimeoutException)):
        return "timeout"
    if isinstance(exc, (openai.APIConnectionError, httpx.NetworkError,
                        httpx.RemoteProtocolError)):
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
