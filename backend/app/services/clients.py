"""联系人 Web 兼容入口；数据实现由 Core 维护，提交权留给宿主。"""
from gugu_core.data.clients import SqlClientRepository
from gugu_core.domain.clients import prepare_client_fields

from app.core.ownership import get_owned
from app.models import Client
from app.services.core_data import core_data


def _repository(db, user_id):
    return SqlClientRepository(db, user_id, model=Client)


async def list_clients(db, user_id):
    return await _repository(db, user_id).list_rows()


async def create_client(db, user_id, *, commit=False, **fields):
    client = await _repository(db, user_id).create_row(prepare_client_fields(fields, creating=True))
    if commit:
        await db.commit()
    await db.refresh(client)
    return client


async def find_clients_by_name(db, user_id, name):
    return await _repository(db, user_id).find_rows(name)


async def get_client(db, user_id, client_id):
    return await get_owned(db, Client, client_id, user_id)


async def update_client(db, client, fields, *, commit=False):
    await core_data(db, client.user_id).clients.update(client.id, fields)
    if commit:
        await db.commit()
    await db.refresh(client)
    return client


async def delete_client(db, client, *, commit=False):
    client_id, name = client.id, client.name
    await core_data(db, client.user_id).clients.delete(client_id)
    if commit:
        await db.commit()
    return client_id, name
