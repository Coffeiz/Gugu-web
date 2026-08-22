"""Capability RAG 结果适配层。

不实现 BM25/Embedding。RAG-1 接入后，召回结果只用于调整授权工具的推荐顺序，
不能缩小工具集合或替代权限校验。
"""

from __future__ import annotations

from typing import Protocol, Sequence

from .models import CapabilitySnapshot, SelectedCapabilities


class CapabilitySelector(Protocol):
    def select(self, query: str, snapshot: CapabilitySnapshot, limit: int = 12) -> SelectedCapabilities: ...


class RegistryCapabilitySelector:
    """把推荐结果适配为“推荐优先、授权全集保留”的选择结果。

    ``candidate_names`` 不是可见性过滤器。未知或未授权的名字会被忽略，所有已授权工具
    仍会保留；召回结果只决定顺序，避免 RAG 漏召回时丢失可用能力。
    """

    def __init__(self, candidate_names: Sequence[str] | None = None, *, shadow: bool = True):
        self.candidate_names = tuple(candidate_names) if candidate_names is not None else None
        self.shadow = shadow

    def select(self, query: str, snapshot: CapabilitySnapshot, limit: int = 12) -> SelectedCapabilities:
        authorized = tuple(snapshot.tools)
        if self.candidate_names is None:
            names = authorized
            shadow = True
        else:
            allowed = set(authorized)
            recommended = tuple(name for name in self.candidate_names if name in allowed)
            recommended_set = set(recommended)
            names = recommended + tuple(name for name in authorized if name not in recommended_set)
            shadow = self.shadow
        return SelectedCapabilities(tuple(names), shadow=shadow)
