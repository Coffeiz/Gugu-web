"""数据用例门面；调用方看不到连接、ORM 或端侧执行能力。"""
from dataclasses import dataclass

from gugu_core.application.clients import ClientService
from gugu_core.application.projects import ProjectService


@dataclass(frozen=True)
class DataServices:
    projects: ProjectService
    clients: ClientService
