"""合并 Tool/Skill 两个细粒度 registry，生成快照。"""

from __future__ import annotations

from dataclasses import replace
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
        tool_snapshot = tool_registry.snapshot()
        diagnostics = list(tools.diagnostics(tool_names))
        diagnostics.extend(skills_meta.diagnostics(skill_names))
        for item in skill_items:
            missing = [name for name in item.related_tools if name not in known_tools and tool_snapshot.get(name) is None]
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

    @classmethod
    async def from_registries_for_user(cls, db, owner_id: object, *,
                                       tool_names: list[str] | None = None,
                                       skill_names: list[str] | None = None,
                                       skill_metadata: tuple[CapabilityMeta, ...] | None = None):
        """合并 builtin 与用户 Skill metadata；正文仍按需加载。

        ``skill_metadata`` 用于复用会话 snapshot。传入时不查询数据库，保证用户
        编辑 Skill 不会改写当前会话已经注入的目录；正文仍由 ``use_skill`` 实时读取。
        """
        base = cls.from_registries(tool_names=tool_names, skill_names=skill_names)
        user_items = (
            tuple(skill_metadata)
            if skill_metadata is not None
            else await SkillCapabilityRegistry().user_metadata(db, owner_id)
        )
        tool_snapshot = tool_registry.snapshot()
        authorized_tools = set(tool_names) if tool_names is not None else set(tool_snapshot._tools)
        # 先用全局 registry 判断关联名是否真实存在，再单独按本轮授权集收窄；
        # 历史 Skill 关联到后来关闭的工具时，不能把整个会话构建打成 500。
        known_tools = set(tool_snapshot._tools)
        for item in user_items:
            missing = [name for name in item.related_tools if name not in known_tools]
            if missing:
                raise CapabilityReferenceError(
                    f"Skill {item.name} 关联了未知工具：{', '.join(missing)}"
                )
        if skill_names is not None:
            allowed = set(skill_names)
            user_items = tuple(item for item in user_items if item.name in allowed)
        # Skill metadata 可以继续展示，但关联工具必须按本轮授权集收窄，不能因为
        # Skill 正文或旧数据库记录把工具权限重新扩大。
        user_items = tuple(
            replace(item, related_tools=tuple(name for name in item.related_tools if name in authorized_tools))
            for item in user_items
        )
        return cls(tuple(base._tools.values()), tuple(base._skills.values()) + user_items,
                   base._diagnostics)

    def short_catalog(self, snapshot: CapabilitySnapshot) -> list[dict]:
        return [
            {"kind": item.kind, "name": item.name, "description_short": item.description_short,
             "category": item.category}
            for item in snapshot.catalog if item.enabled and (item.kind == "skill" or item.name in snapshot.tools)
        ]
