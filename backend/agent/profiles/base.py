"""Profile 基类：定义一个对话场景的工具集、prompt skills、prompt 模板与能力开关。

- `tools`：启用的**工具集**名（如 "files" / "projects"），具体工具名由 registry 派生
  （`tool_names` 属性），避免在 profile 里手抄扁平工具清单、与工具声明双重维护。
- `skills`：启用的 **prompt skills**（`agent/skills/*.md` 的 slug，如 "weather"），
  builder 注入其索引，模型用 use_skill 按需拉正文。
"""
from __future__ import annotations


class BaseProfile:
    name: str = "base"
    # 启用的工具集名（对应各 BaseSkill.name）
    tools: list[str] = []
    # 启用的 prompt skills（agent/skills/*.md 的 slug）
    skills: list[str] = []
    prompt_file: str = "default.md"
    memory_enabled: bool = False
    mcp_enabled: bool = False

    @property
    def tool_names(self) -> list[str]:
        """由启用的工具集派生出有序、去重的工具名列表。"""
        from agent.tools import registry
        return registry.tools_of(self.tools)
