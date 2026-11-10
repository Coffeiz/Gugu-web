"""Web 共享数据门面沿用请求事务与用户外键，保留联系人 ORM 兼容。"""
from sqlalchemy import select

from gugu_core.application.clients import ClientNotFound
from gugu_core.data.models import LocalClient

from app.models import Client, Project
from app.services.clients import get_client, list_clients, update_client
from app.services.core_data import core_data

import pytest


async def test_web_shared_data_rolls_back_project_and_contact_together(db, user_a):
    data = core_data(db, user_a.id)
    await data.projects.create({"name": "请求项目"})
    await data.clients.create({"name": "请求联系人"})
    await db.rollback()
    assert (await db.execute(select(Project))).scalars().all() == []
    assert (await db.execute(select(Client))).scalars().all() == []


async def test_web_contact_compatibility_uses_shared_storage_and_owner(db, user_a, user_b):
    data = core_data(db, user_a.id)
    created = await data.clients.create({"name": "小北", "notes": "初始资料"})
    await db.commit()
    contact = await get_client(db, user_a.id, created.id)
    assert contact is not None
    await update_client(db, contact, {"notes": "Web 更新资料"})
    await db.commit()
    assert (await data.clients.list())[0].notes == "Web 更新资料"
    assert [row.id for row in await list_clients(db, user_a.id)] == [created.id]
    assert await list_clients(db, user_b.id) == []
    with pytest.raises(ClientNotFound):
        await core_data(db, user_b.id).clients.delete(created.id)
    assert (await get_client(db, user_a.id, created.id)).notes == "Web 更新资料"


def test_web_client_preserves_schema_and_host_only_user_foreign_key():
    def columns(model):
        return {column.name: (str(column.type), column.nullable) for column in model.__table__.columns}

    assert columns(Client) == columns(LocalClient)
    assert {foreign_key.target_fullname for foreign_key in Client.__table__.c.user_id.foreign_keys} == {"users.id"}
    assert not LocalClient.__table__.c.user_id.foreign_keys
