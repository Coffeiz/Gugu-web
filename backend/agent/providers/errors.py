"""Provider 错误来源判断。

判断上游 HTTP/流协议错误，并识别已经验证的不可重试输入拒绝。
不复制供应商错误码全集，不通过异常正文的模糊匹配决定重试。
"""
from __future__ import annotations

from collections.abc import Iterator
import json
import re
from urllib.parse import urlsplit


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


def diagnostic_metadata(error: BaseException) -> dict[str, object]:
    """提取失败请求的无正文诊断元数据，不读取或记录认证头和请求内容。"""
    metadata: dict[str, object] = {
        "exception_chain": [],
        "http_status": None,
        "response_status": None,
        "request_host": None,
        "request_body_bytes": None,
        "context_bytes": None,
        "context_text_bytes": None,
        "message_count": None,
        "tool_count": None,
        "upstream_error_type": None,
        "upstream_error_code": None,
    }
    chain = list(_exception_chain(error))
    metadata["exception_chain"] = [type(item).__name__ for item in chain[:8]]

    for current in chain:
        response = getattr(current, "response", None)
        status = getattr(current, "status_code", None)
        response_status = getattr(response, "status_code", None)
        if metadata["http_status"] is None and isinstance(status, int):
            metadata["http_status"] = status
        if metadata["response_status"] is None and isinstance(response_status, int):
            metadata["response_status"] = response_status

        request = getattr(response, "request", None) or getattr(current, "request", None)
        if request is not None:
            if metadata["request_host"] is None:
                try:
                    host = urlsplit(str(request.url)).hostname
                    if host:
                        metadata["request_host"] = host[:253]
                except (AttributeError, TypeError, ValueError):
                    pass
            try:
                content = request.content
            except Exception:
                content = None
            if isinstance(content, str):
                content = content.encode("utf-8", errors="replace")
            if isinstance(content, (bytes, bytearray)):
                metadata["request_body_bytes"] = len(content)
                payload = None
                if len(content) <= 8 * 1024 * 1024:
                    try:
                        payload = json.loads(content)
                    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, TypeError):
                        pass
                if isinstance(payload, dict):
                    messages = payload.get("messages")
                    if isinstance(messages, list):
                        metadata["message_count"] = len(messages)
                    tools = payload.get("tools")
                    if isinstance(tools, list):
                        metadata["tool_count"] = len(tools)
                    context = {
                        key: payload[key]
                        for key in ("system", "messages", "input", "instructions")
                        if key in payload
                    }
                    if context:
                        try:
                            metadata["context_bytes"] = len(
                                json.dumps(context, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                            )
                            metadata["context_text_bytes"] = _context_text_bytes(context)
                        except (RecursionError, TypeError, ValueError):
                            pass

        body = getattr(current, "body", None)
        if isinstance(body, dict):
            error_body = body.get("error")
            if isinstance(error_body, dict):
                error_type = error_body.get("type")
                if isinstance(error_type, str):
                    metadata["upstream_error_type"] = re.sub(r"[^A-Za-z0-9_.-]", "", error_type)[:80]
                candidates = (error_body.get("code"), error_body.get("error_code"))
                code = next((str(value) for value in candidates
                             if isinstance(value, (int, str)) and re.fullmatch(r"\d{3,5}", str(value))), None)
                message = error_body.get("message")
                if code is None and isinstance(message, str):
                    match = re.search(r"\((\d{3,5})\)\s*$", message)
                    code = match.group(1) if match else None
                if code is not None:
                    metadata["upstream_error_code"] = code
            base_resp = body.get("base_resp")
            if metadata["upstream_error_code"] is None and isinstance(base_resp, dict):
                code = base_resp.get("status_code")
                if isinstance(code, (int, str)) and re.fullmatch(r"\d{3,5}", str(code)):
                    metadata["upstream_error_code"] = str(code)

    return metadata


def _context_text_bytes(value: object) -> int:
    """统计 provider 上下文里的文本字节数，不返回文本内容。"""
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    if isinstance(value, list):
        return sum(_context_text_bytes(item) for item in value)
    if isinstance(value, dict):
        return sum(
            _context_text_bytes(value[key])
            for key in ("text", "content", "system", "messages", "input", "instructions")
            if key in value
        )
    return 0


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
