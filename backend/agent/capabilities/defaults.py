"""系统能力默认集合。

系统工具和内置 Prompt Skill 由各自的注册表统一提供，不再通过运行时配置
重复维护一份场景白名单。用户 Skill 仍由用户 Skill 注册表的 enabled 和归属
控制；权限与确认继续在运行时执行层判断。
"""

from __future__ import annotations


DEFAULT_PROMPT_NAME = "default"
SYSTEM_MEMORY_ENABLED = True
NON_RESIDENT_TOOL_NAMES = frozenset({"create_skill", "update_skill", "delete_skill"})


def all_system_tool_names() -> list[str]:
    """返回默认常驻的系统工具名，保持注册顺序。

    Skill 生命周期工具仍在 Registry 和能力目录中可发现，但按既定协议只通过
    固定 Adapter 按需获取 Schema，不进入 Provider 的常驻工具 Schema。
    """
    from agent.tools import registry

    return [name for name in registry.all_tool_names() if name not in NON_RESIDENT_TOOL_NAMES]
