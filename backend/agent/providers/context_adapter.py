"""Canonical Request 到 provider wire history 的小型适配协议。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent.context.canonical_request import CanonicalRequest
from agent.context.canonical_context import HistoryEnvelope


@dataclass(frozen=True)
class ProviderRequest:
    """适配器输出的请求骨架；缓存和调用参数仍由现有 driver 负责。"""

    messages: tuple[dict[str, Any], ...]
    provider: str
    api_format: str
    model: str
    canonical_digest: str
    wire_digest: str


class ContextAdapter:
    """Provider adapter 的统一 Context 出口。"""

    def __init__(self, provider_adapter: Any):
        self.provider_adapter = provider_adapter

    def render(self, request: CanonicalRequest, messages) -> ProviderRequest:
        from agent.context.canonical_context import digest
        rendered = tuple(self.provider_adapter.render_history(messages))
        return ProviderRequest(
            messages=rendered,
            provider=request.provider,
            api_format=request.api_format,
            model=request.model,
            canonical_digest=request.canonical_digest,
            wire_digest=digest(rendered),
        )

    def render_envelopes(self, request: CanonicalRequest,
                         envelopes: tuple[HistoryEnvelope, ...]) -> ProviderRequest:
        """把内存 envelope 交给具体 provider 的 wire renderer。"""
        rendered = tuple(self.render_envelope(envelope) for envelope in envelopes)
        from agent.context.canonical_context import digest
        return ProviderRequest(
            messages=rendered,
            provider=request.provider,
            api_format=request.api_format,
            model=request.model,
            canonical_digest=request.canonical_digest,
            wire_digest=digest(rendered),
        )

    def render_envelope(self, envelope: HistoryEnvelope) -> dict[str, Any]:
        raise NotImplementedError
