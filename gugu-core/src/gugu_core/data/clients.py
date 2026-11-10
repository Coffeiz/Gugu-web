"""联系人 SQL 适配，所有查询和写入都限定所属数据上下文。"""
from dataclasses import fields
from typing import Any, Dict, List
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from gugu_core.data.models import LocalClient
from gugu_core.domain.clients import ClientRecord


def client_record(row) -> ClientRecord:
    return ClientRecord(**{field.name: getattr(row, field.name) for field in fields(ClientRecord)})


class SqlClientRepository:
    def __init__(self, session: AsyncSession, owner_id: UUID, *, model=LocalClient):
        self.session, self.owner_id, self.model = session, owner_id, model

    async def list_rows(self):
        model = self.model
        return (await self.session.execute(
            select(model).where(model.user_id == self.owner_id).order_by(model.created_at.desc(), model.id.desc())
        )).scalars().all()

    async def list(self) -> List[ClientRecord]:
        return [client_record(row) for row in await self.list_rows()]

    async def find_rows(self, name: str):
        model = self.model
        statement = select(model).where(model.user_id == self.owner_id)
        rows = (await self.session.execute(statement.where(model.name == name))).scalars().all()
        if not rows:
            rows = (await self.session.execute(statement.where(model.name.ilike(f"%{name}%")))).scalars().all()
        return rows

    async def create_row(self, values: Dict[str, Any]):
        row = self.model(user_id=self.owner_id, **values)
        self.session.add(row)
        await self.session.flush()
        return row

    async def create(self, fields: Dict[str, Any]) -> ClientRecord:
        return client_record(await self.create_row(fields))

    async def get(self, client_id: int) -> ClientRecord | None:
        model = self.model
        row = (await self.session.execute(
            select(model).where(model.id == client_id, model.user_id == self.owner_id)
            .execution_options(populate_existing=True)
        )).scalar_one_or_none()
        return client_record(row) if row is not None else None

    async def update(self, client_id: int, fields: Dict[str, Any]) -> bool:
        model = self.model
        result = await self.session.execute(update(model).where(
            model.id == client_id, model.user_id == self.owner_id,
        ).values(**fields))
        return result.rowcount == 1

    async def delete(self, client_id: int) -> bool:
        model = self.model
        result = await self.session.execute(delete(model).where(model.id == client_id, model.user_id == self.owner_id))
        return result.rowcount == 1
