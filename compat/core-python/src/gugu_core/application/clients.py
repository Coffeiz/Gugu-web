"""联系人用例，事务与权限上下文由宿主和数据运行时提供。"""
from typing import Any, Dict, List, Protocol

from gugu_core.domain.clients import ClientRecord, prepare_client_fields


class ClientNotFound(ValueError):
    pass


class ClientRepository(Protocol):
    async def list(self) -> List[ClientRecord]: ...
    async def create(self, fields: Dict[str, Any]) -> ClientRecord: ...
    async def update(self, client_id: int, fields: Dict[str, Any]) -> bool: ...
    async def get(self, client_id: int) -> ClientRecord | None: ...
    async def delete(self, client_id: int) -> bool: ...


class ClientService:
    def __init__(self, repository: ClientRepository):
        self.repository = repository

    async def list(self) -> List[ClientRecord]:
        return await self.repository.list()

    async def create(self, fields: Dict[str, Any]) -> ClientRecord:
        return await self.repository.create(prepare_client_fields(fields, creating=True))

    async def update(self, client_id: int, fields: Dict[str, Any]) -> ClientRecord:
        values = prepare_client_fields(fields)
        if not values:
            raise ValueError("请提供需要更新的联系人字段")
        if not await self.repository.update(client_id, values):
            raise ClientNotFound("联系人不存在")
        result = await self.repository.get(client_id)
        if result is None:
            raise ClientNotFound("联系人不存在")
        return result

    async def delete(self, client_id: int) -> None:
        if not await self.repository.delete(client_id):
            raise ClientNotFound("联系人不存在")
