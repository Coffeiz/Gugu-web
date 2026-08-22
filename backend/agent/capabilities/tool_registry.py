"""现有 Tool registry 的 Capability adapter。

执行仍走 ``agent.tools.base.registry``；本模块只读取 metadata，避免出现第二套 dispatch。
"""

from __future__ import annotations

from agent.tools.base import SkillRegistry, Tool
from .errors import CapabilityRegistrationError
from .models import CapabilityMeta


def _short_description(tool: Tool) -> str:
    """读取工具注册时提供的短描述。

    注册制迁移已经完成，运行时不再根据 label 或工具名猜测能力文案；
    缺失描述应在构建能力快照时暴露，避免目录和社区 metadata 静默漂移。
    """
    value = (getattr(tool, "description_short", None) or "").strip()
    if not value:
        raise CapabilityRegistrationError(f"工具 {tool.name} 缺少 description_short")
    return value


class ToolCapabilityRegistry:
    def __init__(self, tools: SkillRegistry):
        self.tools = tools

    def metadata(self, names: list[str] | None = None) -> tuple[CapabilityMeta, ...]:
        wanted = list(self.tools._tools) if names is None else list(names)
        out: list[CapabilityMeta] = []
        for name in wanted:
            tool = self.tools.get(name)
            if tool is None:
                raise CapabilityRegistrationError(f"未知工具：{name}")
            short = _short_description(tool)
            if not short or len(short) > 100:
                raise CapabilityRegistrationError(f"工具 {name} 的短描述必须是 1-100 个字符")
            out.append(CapabilityMeta(
                name=name,
                kind="tool",
                description_short=short,
                category=getattr(tool, "category", "") or self._category(name),
                permissions=tuple(getattr(tool, "permissions", ()) or ()),
                platforms=tuple(getattr(tool, "platforms", ()) or ()),
                related_skills=tuple(getattr(tool, "related_skills", ()) or ()),
                source=getattr(tool, "source", "builtin") or "builtin",
                enabled=True,
            ))
        return tuple(out)

    def _category(self, name: str) -> str:
        """复用现有 BaseSkill 分组作为迁移期类别，不复制工具名称清单。"""
        for group, names in self.tools._skills.items():
            if name in names:
                return group
        return ""

    def diagnostics(self, names: list[str] | None = None) -> tuple[str, ...]:
        wanted = list(self.tools._tools) if names is None else list(names)
        return tuple(
            f"工具 {name} 缺少 description_short"
            for name in wanted
            if self.tools.get(name) is not None
            and not (getattr(self.tools.get(name), "description_short", None) or "").strip()
        )
