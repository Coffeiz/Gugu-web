"""默认 Profile：Web 对话场景。

tools = 项目 / 日历 / 文件 / 客户 / 回收站 / 聚合 / 记忆 / 搜索 / 对话 / 定时任务
        + web（http_get）+ meta（use_skill），工具名由 registry 派生（见 BaseProfile.tool_names）。
skills = 启用的 prompt skills（按需 use_skill 拉正文）：weather + 从 skills.md 抽出的
        situational 剧本（项目规划 / 定时任务 / 接入IM），skills.md 只留主动触发短指针。
prompt 模板 default.md，记忆开启。
"""
from agent.profiles.base import BaseProfile


class DefaultProfile(BaseProfile):
    name = "default"
    tools = ["projects", "calendar", "files", "clients", "trash", "overview", "memory", "search", "conversations", "scheduled_tasks", "web", "meta"]
    skills = ["weather", "project-planning", "scheduled-tasks", "im-bind"]
    prompt_file = "default.md"
    memory_enabled = True
    mcp_enabled = False
