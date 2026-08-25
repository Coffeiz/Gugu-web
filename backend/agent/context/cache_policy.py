"""Provider 缓存能力的统一描述，不改变已有缓存策略。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ProviderCacheCapabilities:
    automatic_prefix_cache: bool
    explicit_cache_control: bool
    single_history_anchor: bool
    granularity_tokens: int | None = None


def cache_capabilities(adapter: Any, model: str = "") -> ProviderCacheCapabilities:
    return ProviderCacheCapabilities(
        automatic_prefix_cache=bool(adapter.supports_active_cache(model)),
        explicit_cache_control=bool(adapter.supports_explicit_cache(model)),
        single_history_anchor=bool(adapter.uses_single_history_cache_anchor(model)),
        granularity_tokens=getattr(adapter, "cache_granularity_tokens", None),
    )

