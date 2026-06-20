from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import User, UserPreferences
from app.schemas import PreferencesResponse, PreferencesUpdate
from app.core.security import get_current_user

router = APIRouter(prefix="/preferences", tags=["preferences"])


async def _get_or_create(user: User, db: AsyncSession) -> UserPreferences:
    result = await db.execute(
        select(UserPreferences).where(UserPreferences.user_id == user.id)
    )
    prefs = result.scalar_one_or_none()
    if prefs is None:
        prefs = UserPreferences(user_id=user.id, data_json="{}")
        db.add(prefs)
        await db.flush()
    return prefs


@router.get("", response_model=PreferencesResponse)
async def get_preferences(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    prefs = await _get_or_create(user, db)
    await db.commit()
    data = prefs.data
    return PreferencesResponse(
        lastStages=data.get("last_stages", []),
        stageTemplates=data.get("stage_templates", []),
    )


@router.patch("", response_model=PreferencesResponse)
async def update_preferences(
    body: PreferencesUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    prefs = await _get_or_create(user, db)
    data = prefs.data
    if body.lastStages is not None:
        data["last_stages"] = body.lastStages
    if body.stageTemplates is not None:
        data["stage_templates"] = body.stageTemplates
    prefs.data = data
    await db.commit()
    return PreferencesResponse(
        lastStages=data.get("last_stages", []),
        stageTemplates=data.get("stage_templates", []),
    )
