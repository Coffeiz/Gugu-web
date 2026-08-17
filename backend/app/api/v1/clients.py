from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import Client, User
from app.schemas import ClientCreate, ClientResponse
from app.core.security import get_current_user
from app.services.clients import (
    create_client as create_client_service,
    delete_client as delete_client_service,
    get_client,
    list_clients as list_clients_service,
)

router = APIRouter(prefix="/clients", tags=["clients"])


def _to_resp(c: Client) -> ClientResponse:
    return ClientResponse(id=c.id, name=c.name, contact=c.contact,
                          email=c.email, phone=c.phone, notes=c.notes)


@router.get("", response_model=list[ClientResponse])
async def list_clients(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    clients = await list_clients_service(db, current_user.id)
    return [_to_resp(c) for c in clients]


@router.post("", response_model=ClientResponse, status_code=201)
async def create_client(
    body: ClientCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    c = await create_client_service(
        db, current_user.id, **body.model_dump(by_alias=False),
    )
    await db.commit()
    return _to_resp(c)


@router.delete("/{cid}", status_code=204)
async def delete_client(
    cid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    c = await get_client(db, current_user.id, cid)
    if not c:
        raise HTTPException(404, "客户不存在")
    await delete_client_service(db, c)
    await db.commit()
