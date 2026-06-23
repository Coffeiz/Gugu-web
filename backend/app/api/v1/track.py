from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User, FrontendEvent

router = APIRouter(prefix="/track", tags=["track"])


class TrackBody(BaseModel):
    event: str
    properties: Optional[dict] = None


@router.post("")
async def track(
    body: TrackBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    db.add(FrontendEvent(
        user_id=current_user.id,
        event=body.event[:64],
        properties=body.properties,
    ))
    await db.commit()
    return {"ok": True}
