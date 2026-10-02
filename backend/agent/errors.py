"""Agent 对外错误描述。

错误分类、上游安全标签和用户可见文案只在这里生成一次。Web 使用结构化
``message_key``，IM 使用同一份 ``text``；上游响应正文永远不进入出站载荷。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from typing import Any

from agent.providers.minimax import minimax_error_details
from app.core.redaction import diag_log


@dataclass(frozen=True)
class LLMErrorPresentation:
    """一次 LLM 失败的跨渠道描述。"""

    code: str
    message_key: str
    message_params: dict[str, Any] = field(default_factory=dict)
    text: str = ""

    def as_event(self) -> dict[str, Any]:
        """转换为 Web SSE/genstream 和核心事件都能消费的错误事件。"""
        params = dict(self.message_params)
        return {
            "type": "error",
            "error_code": self.code,
            "message": self.text,
            "detail": self.text,
            "message_key": self.message_key,
            "message_params": params,
        }

    @classmethod
    def from_event(cls, event: dict[str, Any]) -> "LLMErrorPresentation":
        """从核心错误事件恢复元数据，供 IM/其它 adapter 保留结构化信息。"""
        params = event.get("message_params")
        return cls(
            code=str(event.get("error_code") or "generic_error"),
            message_key=str(event.get("message_key") or "chatUi.genericError"),
            message_params=dict(params) if isinstance(params, dict) else {},
            text=str(event.get("message") or event.get("detail") or "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"),
        )


def is_network_error(error: BaseException) -> bool:
    """识别连接/超时类错误，不读取或返回上游响应正文。"""
    if isinstance(error, (ConnectionError, TimeoutError)):
        return True
    blob = f"{type(error).__module__}.{type(error).__name__} {error}".lower()
    return any(k in blob for k in (
        "timeout", "connect", "network", "ssl", "econnreset", "read operation",
    ))


def describe_llm_error(
    error: BaseException,
    *,
    attempts: int = 0,
    diagnostic_context: str = "agent.errors.describe_llm_error",
) -> LLMErrorPresentation:
    """按统一口径生成 LLM 失败描述。"""
    from agent.providers.errors import (
        is_provider_http_error,
        upstream_status_code,
        upstream_status_tag,
    )

    attempts = max(0, int(attempts or 0))
    provider_error = is_provider_http_error(error)
    tag = upstream_status_tag(error) if provider_error else ""
    status_code = upstream_status_code(error) if provider_error else None
    params = {"tag": tag, "attempts": attempts}
    retried = f"已自动重试 {attempts} 次"

    minimax_details = minimax_error_details(error)
    if provider_error and minimax_details is not None:
        diagnostic_id = secrets.token_hex(8).upper()
        error_type = minimax_details.error_type or "-"
        diag_log(
            f"{diagnostic_context} provider=minimax status={status_code} "
            f"error_code={minimax_details.code} error_type={error_type} "
            f"request_id={minimax_details.request_id or '-'} diagnostic_id={diagnostic_id}",
            error,
        )
        request_id = minimax_details.request_id or "-"
        return LLMErrorPresentation(
            code="provider_minimax_error",
            message_key="chatUi.minimaxProviderError",
            message_params={
                **params,
                "minimax_code": minimax_details.code,
                "minimax_error_type": error_type,
                "minimax_description_key": minimax_details.description_key,
                "diagnostic_id": diagnostic_id,
                "minimax_request_id": request_id,
            },
            text=(f"MiniMax 请求失败（上游 {tag}，错误码 {minimax_details.code} / "
                  f"{error_type}："
                  f"{minimax_details.summary}）。诊断编号 {diagnostic_id}；"
                  f"MiniMax 请求 ID：{request_id}"),
        )

    if is_network_error(error):
        return LLMErrorPresentation(
            code="network_error",
            message_key="chatUi.networkError",
            message_params=params,
            text="咕咕网络不太好 📡 可以再发一遍吗？",
        )
    if status_code == 429:
        suffix = f"，{retried}仍未恢复" if attempts else ""
        return LLMErrorPresentation(
            code="provider_rate_limited",
            message_key="chatUi.providerRateLimitedExhausted" if attempts else "chatUi.providerRateLimited",
            message_params=params,
            text=f"模型供应商触发请求限流（上游 {tag}）{suffix}。请稍后重试；若持续出现，请检查供应商限额。",
        )
    if status_code == 529:
        suffix = f"，{retried}仍未恢复" if attempts else ""
        return LLMErrorPresentation(
            code="provider_busy",
            message_key="chatUi.providerBusyExhausted" if attempts else "chatUi.providerBusy",
            message_params=params,
            text=f"模型服务过载（上游 {tag}）{suffix}，请稍后再试 🙏",
        )
    if status_code is not None and 400 <= status_code < 500:
        if status_code in (401, 403):
            message = f"模型供应商鉴权失败（上游 {tag}）。请检查 API Key 和模型访问权限。"
            message_key = "chatUi.providerAuthFailed"
        else:
            message = f"模型供应商拒绝了请求（上游 {tag}）。请检查模型名称、接口格式和请求参数。"
            message_key = "chatUi.providerRejected"
        return LLMErrorPresentation(
            code="provider_rejected",
            message_key=message_key,
            message_params=params,
            text=message,
        )
    if provider_error:
        suffix = f"，{retried}" if attempts else ""
        return LLMErrorPresentation(
            code="provider_unavailable",
            message_key="chatUi.providerUnavailableExhausted" if attempts else "chatUi.providerUnavailable",
            message_params=params,
            text=f"上游模型服务返回错误（{tag}）{suffix}。这是供应商服务端错误，请稍后重试。",
        )
    diagnostic_id = secrets.token_hex(8).upper()
    diag_log(f"{diagnostic_context} diagnostic_id={diagnostic_id}", error)
    return LLMErrorPresentation(
        code="internal_error",
        message_key="chatUi.internalError",
        message_params={"diagnostic_id": diagnostic_id},
        text=f"请求处理失败，未识别到上游 HTTP 错误（诊断编号 {diagnostic_id}），可用编号排查服务日志。",
    )
