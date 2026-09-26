"""Agent 对外错误描述。

错误分类、上游安全标签和用户可见文案只在这里生成一次。Web 使用结构化
``message_key``，IM 使用同一份 ``text``；上游响应正文永远不进入出站载荷。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


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


def describe_llm_error(error: BaseException, *, attempts: int = 0) -> LLMErrorPresentation:
    """按统一口径生成 LLM 失败描述。"""
    from agent.providers.errors import (
        is_provider_http_error,
        upstream_busy_status,
        upstream_status_tag,
    )

    attempts = max(0, int(attempts or 0))
    provider_error = is_provider_http_error(error)
    tag = upstream_status_tag(error) if provider_error else ""
    params = {"tag": tag, "attempts": attempts}
    retried = f"已自动重试 {attempts} 次"

    if is_network_error(error):
        return LLMErrorPresentation(
            code="network_error",
            message_key="chatUi.networkError",
            message_params=params,
            text="咕咕网络不太好 📡 可以再发一遍吗？",
        )
    if upstream_busy_status(error):
        suffix = f"，{retried}仍未恢复" if attempts else ""
        return LLMErrorPresentation(
            code="provider_busy",
            message_key="chatUi.providerBusyExhausted",
            message_params=params,
            text=f"模型服务过载（上游 {tag}）{suffix}，请稍后再试 🙏",
        )
    if provider_error:
        suffix = f"，{retried}" if attempts else ""
        return LLMErrorPresentation(
            code="provider_unavailable",
            message_key="chatUi.providerUnavailable",
            message_params=params,
            text=f"模型服务暂时不可用（上游 {tag}）{suffix}，请稍后重试。",
        )
    return LLMErrorPresentation(
        code="generic_error",
        message_key="chatUi.genericError",
        message_params=params,
        text="咕咕开小差了 😵‍💫 麻烦再说一遍好吗？",
    )
