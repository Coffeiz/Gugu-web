"""客户领域的查询与写入边界。"""
from sqlalchemy import select

from app.core.ownership import get_owned
from app.models import Client


async def list_clients(db, user_id):
    return (await db.execute(
        select(Client).where(Client.user_id == user_id).order_by(Client.created_at.desc())
    )).scalars().all()


async def create_client(db, user_id, **fields):
    client = Client(user_id=user_id, **fields)
    db.add(client)
    await db.commit()
    await db.refresh(client)
    return client


async def find_clients_by_name(db, user_id, name):
    rows = (await db.execute(select(Client).where(
        Client.user_id == user_id, Client.name == name,
    ))).scalars().all()
    if not rows:
        rows = (await db.execute(select(Client).where(
            Client.user_id == user_id, Client.name.ilike(f"%{name}%"),
        ))).scalars().all()
    return rows


async def get_client(db, user_id, client_id):
    return await get_owned(db, Client, client_id, user_id)


async def update_client(db, client, fields):
    for field, value in fields.items():
        setattr(client, field, value)
    await db.commit()
    return client


async def delete_client(db, client):
    client_id, name = client.id, client.name
    await db.delete(client)
    await db.commit()
    return client_id, name
