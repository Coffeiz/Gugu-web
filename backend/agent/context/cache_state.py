"""Provider 前缀缓存的显式状态与一次性计划。"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CacheState:
    """跨同一 run 续轮使用的缓存身份，不依附于消息列表下标。"""

    provider: str = ""
    api_format: str = ""
    model: str = ""
    strategy: str = "multi"
    baseline_digest: str = ""
    latest_digest: str = ""
    revision: int = 0

    def compatible_with(self, *, provider: str, api_format: str, model: str,
                        strategy: str) -> bool:
        return (
            not self.revision
            or (
                self.provider == provider
                and self.api_format == api_format
                and self.model == model
                and self.strategy == strategy
            )
        )


@dataclass(frozen=True)
class CachePlan:
    """一次 provider 请求的缓存边界与请求完成后的下一状态。"""

    stable_limit: int
    anchor_indices: tuple[int, ...]
    baseline_digest: str
    latest_digest: str
    next_state: CacheState
