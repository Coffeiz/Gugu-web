"""Web 的共享数据装配；鉴权后传入用户 ID，保留原有请求事务。"""
from gugu_core.application.context import DataContext
from gugu_core.data.unit_of_work import DataModels, bind_services

from app.core.tz import now_utc
from app.models import Client, Project

WEB_DATA_MODELS = DataModels(project=Project, client=Client)


def core_data(db, user_id):
    return bind_services(db, DataContext(user_id), models=WEB_DATA_MODELS, clock=now_utc)
