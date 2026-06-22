"""技能（工具）层。

各领域 skill 在导入时自注册到全局 registry，Profile 按需组合。
"""
from agent.skills.base import BaseSkill, registry
from agent.skills.projects import ProjectsSkill
from agent.skills.calendar import CalendarSkill
from agent.skills.files import FilesSkill
from agent.skills.clients import ClientsSkill
from agent.skills.overview import OverviewSkill
from agent.skills.trash import TrashSkill
from agent.skills.memory import MemorySkill
from agent.skills.search import SearchSkill

__all__ = [
    "BaseSkill", "registry",
    "ProjectsSkill", "CalendarSkill", "FilesSkill", "ClientsSkill",
    "OverviewSkill", "TrashSkill", "MemorySkill", "SearchSkill",
]
