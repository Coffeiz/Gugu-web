"""Skill 基类与全局 registry。

一个工具只声明一次（name / description / input_schema），由基类派生
Anthropic 与 OpenAI 两种 schema，消除手写两份的重复。core 通过 registry
统一分发执行，替代原 agent.py 里的 `_exec_tool` if/elif。
"""
from __future__ import annotations

import json
from typing import Any


class Tool:
    """单个工具的声明 + 执行入口。"""

    def __init__(self, name: str, description: str, input_schema: dict,
                 handler, label: str | None = None, destructive: bool = False):
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self.handler = handler          # async (db, user_id, args) -> dict | list
        self.label = label or name
        self.destructive = destructive  # 不可逆操作，handler 内走 confirm.gate

    def to_anthropic(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }

    def to_openai(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.input_schema,
            },
        }


class BaseSkill:
    """领域技能基类：聚合一组 Tool。

    子类在 `tools` 列表里声明工具，实例化后调用 `register()` 自注册。
    """

    name: str = ""
    tools: list[Tool] = []

    def register(self) -> "BaseSkill":
        registry.add_skill(self.name, [t.name for t in self.tools])
        for tool in self.tools:
            registry.add(tool)
        return self


class SkillRegistry:
    """全局工具注册表，按工具名索引。"""

    def __init__(self):
        self._tools: dict[str, Tool] = {}
        self._skills: dict[str, list[str]] = {}  # skill 名 → 有序工具名

    def add(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def add_skill(self, name: str, tool_names: list[str]) -> None:
        """记录一个 skill 包含的工具（按声明顺序），供 profile 按 skill 组合。"""
        self._skills[name] = list(tool_names)

    def tools_of(self, skill_names: list[str]) -> list[str]:
        """把若干 skill 展开为有序、去重的工具名列表（profile.tool_names 据此派生）。"""
        out: list[str] = []
        seen: set[str] = set()
        for s in skill_names:
            for t in self._skills.get(s, []):
                if t not in seen:
                    seen.add(t)
                    out.append(t)
        return out

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def labels(self) -> dict[str, str]:
        return {name: t.label for name, t in self._tools.items()}

    def anthropic_schemas(self, names: list[str]) -> list[dict]:
        return [self._tools[n].to_anthropic() for n in names if n in self._tools]

    def openai_schemas(self, names: list[str]) -> list[dict]:
        return [self._tools[n].to_openai() for n in names if n in self._tools]

    async def dispatch(self, user_id, name: str, args: dict) -> str:
        """执行工具，统一返回 JSON 字符串（与原 _exec_tool 输出格式一致）。

        与原实现一致：每次工具调用自开一个数据库会话。
        """
        tool = self._tools.get(name)
        if tool is None:
            return json.dumps({"error": f"未知工具: {name}"})

        import app.db.session as _sess
        if _sess._engine is None:
            _sess._build_engine()

        async with _sess._SessionLocal() as db:
            result: Any = await tool.handler(db, user_id, args)
        if isinstance(result, str):
            return result
        return json.dumps(result, ensure_ascii=False)


registry = SkillRegistry()
