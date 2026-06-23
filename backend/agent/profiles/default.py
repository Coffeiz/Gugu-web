"""默认 Profile：Web 对话场景。

技能集 = 项目 / 日历 / 文件 / 客户 / 回收站 / 聚合 六个 skill，工具名由
registry 从 skill 派生（见 BaseProfile.tool_names）。prompt 模板 default.md，
记忆暂关（Phase 2 开启）。
"""
from agent.profiles.base import BaseProfile


class DefaultProfile(BaseProfile):
    name = "default"
    skills = ["projects", "calendar", "files", "clients", "trash", "overview", "memory", "search", "conversations"]
    prompt_file = "default.md"
    memory_enabled = True
    mcp_enabled = False
