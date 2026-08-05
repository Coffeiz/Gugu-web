"""工具层（函数调用工具）。

各领域工具集在导入时自注册到全局 registry，Profile 按需组合。
（注：prompt skills 在隔壁 `agent/skills/`，是带触发条件的「剧本」，跑在这些工具之上。）
"""
from agent.tools.base import BaseSkill, registry
from agent.tools.projects import ProjectsSkill
from agent.tools.calendar import CalendarSkill
from agent.tools.files import FilesSkill
from agent.tools.clients import ClientsSkill
from agent.tools.overview import OverviewSkill
from agent.tools.trash import TrashSkill
from agent.tools.memory import MemorySkill
from agent.tools.search import SearchSkill
from agent.tools.global_search import GlobalSearchSkill
from agent.tools.group_context import GroupContextSkill
from agent.tools.mind import MindSkill
from agent.tools.conversations import ConversationsSkill
from agent.tools.im import IMSkill
from agent.tools.scheduled_tasks import ScheduledTasksSkill
from agent.tools.web import WebSkill
from agent.tools.meta import MetaSkill

__all__ = [
    "BaseSkill", "registry",
    "ProjectsSkill", "CalendarSkill", "FilesSkill", "ClientsSkill",
    "OverviewSkill", "TrashSkill", "MemorySkill", "SearchSkill",
    "GlobalSearchSkill",
    "MindSkill",
    "ConversationsSkill", "IMSkill", "ScheduledTasksSkill",
    "WebSkill", "MetaSkill",
]
