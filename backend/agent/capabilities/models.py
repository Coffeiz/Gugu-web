"""Capability Registry 的不可变数据模型。

这里不复制 Tool handler、JSON Schema 或 Skill 正文；这些仍由现有 registry/loader 负责。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Mapping


@dataclass(frozen=True)
class CapabilityMeta:
    name: str
    kind: Literal["tool", "skill"]
    description_short: str
    category: str = ""
    permissions: tuple[str, ...] = ()
    platforms: tuple[str, ...] = ()
    related_tools: tuple[str, ...] = ()
    related_skills: tuple[str, ...] = ()
    source: str = "builtin"
    enabled: bool = True


@dataclass(frozen=True)
class SelectedCapabilities:
    """本轮候选结果；只保存工具名，不把 Schema 拼进普通 Prompt。"""

    tool_names: tuple[str, ...]
    reasons: Mapping[str, str] = field(default_factory=dict)
    scores: Mapping[str, float] = field(default_factory=dict)
    shadow: bool = False


@dataclass(frozen=True)
class CapabilitySnapshot:
    generation: int
    tools: Mapping[str, CapabilityMeta]
    skills: Mapping[str, CapabilityMeta]
    diagnostics: tuple[str, ...] = ()

    @property
    def catalog(self) -> tuple[CapabilityMeta, ...]:
        return tuple(self.tools.values()) + tuple(self.skills.values())
