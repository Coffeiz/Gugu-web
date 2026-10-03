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
    area_revision: int | None = None
    area_digest: str = ""
    area_entry_count: int = 0
    area_prefix_digest: str = ""
    projection_entry_count: int = 0
    projection_prefix_digest: str = ""

    def to_session_anchor(self) -> dict[str, str] | None:
        """仅返回跨 run 稳定锚点元数据，不持久化消息正文或列表下标。"""
        if not self.baseline_digest or not self.provider or not self.api_format or not self.model:
            return None
        return {
            "provider": self.provider,
            "api_format": self.api_format,
            "model": self.model,
            "strategy": self.strategy,
            "baseline_digest": self.baseline_digest,
        }

    @classmethod
    def from_session_anchor(
        cls, value, *, provider: str, api_format: str, model: str, strategy: str,
    ) -> "CacheState":
        """恢复同模型的稳定锚点；历史或配置不匹配时由 planner 重新选取。"""
        if not isinstance(value, dict) or any((
            value.get("provider") != provider,
            value.get("api_format") != api_format,
            value.get("model") != model,
            value.get("strategy") != strategy,
            not isinstance(value.get("baseline_digest"), str),
            not value.get("baseline_digest"),
        )):
            return cls()
        return cls(
            provider=provider,
            api_format=api_format,
            model=model,
            strategy=strategy,
            baseline_digest=value["baseline_digest"],
            revision=1,
        )

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
