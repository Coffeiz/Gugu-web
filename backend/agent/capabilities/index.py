"""合并 Tool/Skill 两个细粒度 registry，生成快照。"""

from __future__ import annotations

from types import MappingProxyType

from agent.tools import registry as tool_registry
from .models import CapabilityMeta, CapabilitySnapshot
from .skill_registry import SkillCapabilityRegistry
from .tool_registry import ToolCapabilityRegistry
from .errors import CapabilityReferenceError


class CapabilityIndex:
    def __init__(self, tool_meta: tuple[CapabilityMeta, ...], skill_meta: tuple[CapabilityMeta, ...], diagnostics=()):
        self._tools = {item.name: item for item in tool_meta}
        self._skills = {item.name: item for item in skill_meta}
        self._diagnostics = tuple(diagnostics)
        self._generation = 0

    @classmethod
    def from_registries(cls, *, tool_names: list[str] | None = None, skill_names: list[str] | None = None):
        tools = ToolCapabilityRegistry(tool_registry)
        skills_meta = SkillCapabilityRegistry()
        tool_items = tools.metadata(tool_names)
        skill_items = skills_meta.metadata(skill_names)
        known_tools = set(item.name for item in tool_items)
        diagnostics = list(tools.diagnostics(tool_names))
        diagnostics.extend(skills_meta.diagnostics(skill_names))
        for item in skill_items:
            missing = [name for name in item.related_tools if name not in known_tools and tool_registry.get(name) is None]
            if missing:
                raise CapabilityReferenceError(f"Skill {item.name} 关联了未知工具：{', '.join(missing)}")
        return cls(tool_items, skill_items, diagnostics)

    def snapshot(self, authorized_names: list[str] | None = None) -> CapabilitySnapshot:
        allowed = set(authorized_names) if authorized_names is not None else set(self._tools)
        tools = {name: item for name, item in self._tools.items() if name in allowed and item.enabled}
        self._generation += 1
        return CapabilitySnapshot(
            generation=self._generation,
            tools=MappingProxyType(tools),
            skills=MappingProxyType(dict(self._skills)),
            diagnostics=self._diagnostics,
        )

    def short_catalog(self, snapshot: CapabilitySnapshot) -> list[dict]:
        return [
            {"kind": item.kind, "name": item.name, "description_short": item.description_short,
             "category": item.category}
            for item in snapshot.catalog if item.enabled and (item.kind == "skill" or item.name in snapshot.tools)
        ]
