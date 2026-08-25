from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import User, UserPreferences
from app.schemas import PreferencesResponse, PreferencesUpdate
from app.core.security import get_current_user

router = APIRouter(prefix="/preferences", tags=["preferences"])

_DEFAULT_VIEWS = {"projects", "calendar", "files", "mind"}


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


def _to_response(data: dict) -> PreferencesResponse:
    return PreferencesResponse(
        lastStages=data.get("last_stages", []),
        stageTemplates=data.get("stage_templates", []),
        replyTone=data.get("reply_tone"),
        replyLength=data.get("reply_length"),
        pmStagesExpanded=data.get("pm_stages_expanded", False),
        defaultView=data.get("default_view", "projects") if data.get("default_view", "projects") in _DEFAULT_VIEWS else "projects",
        shellEnabled=bool(data.get("shell_enabled", False)),
        shellSystemEnabled=bool(data.get("shell_system_enabled", False)),
        shellDangerousEnabled=bool(data.get("shell_dangerous_enabled", False)),
        showToolInteractions=bool(data.get("show_tool_interactions", False)),
    )


@router.get("", response_model=PreferencesResponse)
async def get_preferences(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    prefs = await _get_or_create(user, db)
    await db.commit()
    return _to_response(prefs.data)


@router.patch("", response_model=PreferencesResponse)
async def update_preferences(
    body: PreferencesUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    prefs = await _get_or_create(user, db)
    data = prefs.data
    style_changed = False
    if body.lastStages is not None:
        data["last_stages"] = body.lastStages
    if body.stageTemplates is not None:
        data["stage_templates"] = body.stageTemplates
    if "replyTone" in body.model_fields_set:
        style_changed = True
        if body.replyTone is None:
            data.pop("reply_tone", None)   # null = 重置为默认（自然）
        else:
            data["reply_tone"] = body.replyTone
    if "replyLength" in body.model_fields_set:
        style_changed = True
        if body.replyLength is None:
            data.pop("reply_length", None) # null = 重置为默认（适中）
        else:
            data["reply_length"] = body.replyLength
    if body.pmStagesExpanded is not None:
        data["pm_stages_expanded"] = body.pmStagesExpanded
    if body.defaultView is not None and body.defaultView in _DEFAULT_VIEWS:
        data["default_view"] = body.defaultView
    if body.shellEnabled is not None:
        data["shell_enabled"] = body.shellEnabled
    if body.shellSystemEnabled is not None:
        data["shell_system_enabled"] = body.shellSystemEnabled
    if body.shellDangerousEnabled is not None:
        data["shell_dangerous_enabled"] = body.shellDangerousEnabled
    if body.showToolInteractions is not None:
        data["show_tool_interactions"] = body.showToolInteractions
    prefs.data = data
    await db.commit()
    if style_changed:
        from app.core import events
        await events.bump_context_revision(user.id, "preferences")
    return _to_response(data)
