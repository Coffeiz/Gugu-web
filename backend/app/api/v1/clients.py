from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import Client, User
from app.schemas import ClientCreate, ClientResponse
from app.core.security import get_current_user

router = APIRouter(prefix="/clients", tags=["clients"])


def _to_resp(c: Client) -> ClientResponse:
    return ClientResponse(id=c.id, name=c.name, contact=c.contact,
                          email=c.email, phone=c.phone, notes=c.notes)


@router.get("", response_model=list[ClientResponse])
async def list_clients(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Client)
        .where(Client.user_id == current_user.id)
        .order_by(Client.created_at.desc())
    )
    return [_to_resp(c) for c in result.scalars().all()]


@router.post("", response_model=ClientResponse, status_code=201)
async def create_client(
    body: ClientCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    c = Client(user_id=current_user.id, **body.model_dump(by_alias=False))
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return _to_resp(c)


@router.delete("/{cid}", status_code=204)
async def delete_client(
    cid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    c = await db.get(Client, cid)
    if not c or c.user_id != current_user.id:
        raise HTTPException(404, "客户不存在")
    await db.delete(c)
    await db.commit()
