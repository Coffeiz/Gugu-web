"""Profile 基类：定义一个对话场景的技能集、prompt 模板与能力开关。

Profile 组合的是 **skill**（如 "files" / "projects"），具体工具名由 registry
从 skill 派生（`tool_names` 属性），避免在 profile 里手抄一份扁平工具清单、
与 skill 声明双重维护。
"""
from __future__ import annotations


class BaseProfile:
    name: str = "base"
    # 启用的 skill 名（对应各 BaseSkill.name）
    skills: list[str] = []
    prompt_file: str = "default.md"
    memory_enabled: bool = False
    mcp_enabled: bool = False

    @property
    def tool_names(self) -> list[str]:
        """由启用的 skills 派生出有序、去重的工具名列表。"""
        from agent.skills import registry
        return registry.tools_of(self.skills)
