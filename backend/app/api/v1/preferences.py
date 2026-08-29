from fastapi import APIRouter, Depends, File as FastAPIFile, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import User, UserPreferences
from app.schemas import PreferencesResponse, PreferencesUpdate
from app.core.security import get_current_user
from app.core.config import get_settings
from app.services.personality_preferences import (
    invalidate_personality_snapshots,
    preference_revision,
    preference_updated_at,
    normalize_personality_preference,
    read_personality_file,
    write_personality_file,
)

router = APIRouter(prefix="/preferences", tags=["preferences"])

_DEFAULT_VIEWS = {"projects", "calendar", "files", "mind"}
_TOOL_INJECTION_MODES = {"description", "full"}
_LEGACY_TOOL_INJECTION_MODES = {"catalog": "description", "compact_schema": "full", "full_schema": "full"}
_MAX_PERSONALITY_UPLOAD_BYTES = 40_000
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


def _to_response(data: dict, personality: str | None = None) -> PreferencesResponse:
    personality_enabled = bool(personality and data.get("personality_preference_enabled", False))
    personality_available = bool(get_settings().agent.personality_preference_enabled)
    return PreferencesResponse(
        lastStages=data.get("last_stages", []),
        stageTemplates=data.get("stage_templates", []),
        replyTone=data.get("reply_tone"),
        replyLength=data.get("reply_length"),
        pmStagesExpanded=data.get("pm_stages_expanded", False),
        calendarWeekStart=data.get("calendar_week_start", "monday") if data.get("calendar_week_start", "monday") in {"monday", "sunday"} else "monday",
        defaultView=data.get("default_view", "projects") if data.get("default_view", "projects") in _DEFAULT_VIEWS else "projects",
        shellEnabled=bool(data.get("shell_enabled", False)),
        shellSystemEnabled=bool(data.get("shell_system_enabled", False)),
        shellDangerousEnabled=bool(data.get("shell_dangerous_enabled", False)),
        shellAutopilotEnabled=bool(data.get("shell_autopilot_enabled", False)),
        showToolInteractions=bool(data.get("show_tool_interactions", False)),
        toolInjectionMode=(
            data.get("tool_injection_mode", "description")
            if data.get("tool_injection_mode", "description") in _TOOL_INJECTION_MODES
            else _LEGACY_TOOL_INJECTION_MODES.get(data.get("tool_injection_mode"), "description")
        ),
        personalityPreference=personality,
        personalityPreferenceEnabled=personality_enabled,
        personalityPreferenceRevision=preference_revision(data),
        personalityPreferenceUpdatedAt=(
            preference_updated_at(data).isoformat()
            if preference_updated_at(data) else None
        ),
        personalityPreferenceAvailable=personality_available,
    )


@router.get("", response_model=PreferencesResponse)
async def get_preferences(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    prefs = await _get_or_create(user, db)
    await db.commit()
    return _to_response(prefs.data, read_personality_file(user.id))


@router.post("/personality/upload", response_model=PreferencesResponse)
async def upload_personality(
    file: UploadFile = FastAPIFile(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """上传 Markdown 人格文件；文件只写入用户隐藏人格目录。"""
    if not get_settings().agent.personality_preference_enabled:
        raise HTTPException(status_code=403, detail="用户人格偏好当前未开放")
    filename = (file.filename or "").strip().lower()
    if not filename.endswith(".md"):
        raise HTTPException(status_code=415, detail="人格文件必须是 Markdown（.md）文件")
    raw = await file.read(_MAX_PERSONALITY_UPLOAD_BYTES + 1)
    if len(raw) > _MAX_PERSONALITY_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="人格文件过大")
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="人格文件必须使用 UTF-8 编码") from exc
    try:
        content = normalize_personality_preference(content) or ""
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    prefs = await _get_or_create(user, db)
    data = prefs.data
    changed = write_personality_file(user.id, content)
    data.pop("personality_preference", None)
    data.pop("personality_preference_updated_at", None)
    data["personality_preference_revision"] = int(data.get("personality_preference_revision", 0)) + int(changed)
    prefs.data = data
    if changed:
        await invalidate_personality_snapshots(db, user.id)
    await db.commit()
    if changed:
        from app.core import events
        await events.bump_context_revision(user.id, "preferences")
    return _to_response(data, read_personality_file(user.id))


@router.patch("", response_model=PreferencesResponse)
async def update_preferences(
    body: PreferencesUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if {"personalityPreference", "personalityPreferenceEnabled"}.intersection(body.model_fields_set):
        if not get_settings().agent.personality_preference_enabled:
            raise HTTPException(status_code=403, detail="用户人格偏好当前未开放")
    prefs = await _get_or_create(user, db)
    data = prefs.data
    style_changed = False
    personality_changed = False
    personality_toggle_changed = False
    if "personalityPreference" in body.model_fields_set:
        personality_changed = write_personality_file(user.id, body.personalityPreference)
        # 正文事实源已迁出 JSON；清理旧键但保留开关元数据。
        data.pop("personality_preference", None)
        data.pop("personality_preference_updated_at", None)
        data["personality_preference_revision"] = int(data.get("personality_preference_revision", 0)) + int(personality_changed)
    if "personalityPreferenceEnabled" in body.model_fields_set:
        enabled = bool(body.personalityPreferenceEnabled)
        personality_toggle_changed = enabled != bool(data.get("personality_preference_enabled", False))
        data["personality_preference_enabled"] = enabled
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
    if body.calendarWeekStart is not None and body.calendarWeekStart in {"monday", "sunday"}:
        data["calendar_week_start"] = body.calendarWeekStart
    if body.defaultView is not None and body.defaultView in _DEFAULT_VIEWS:
        data["default_view"] = body.defaultView
    if body.shellEnabled is not None:
        data["shell_enabled"] = body.shellEnabled
    if body.shellSystemEnabled is not None:
        data["shell_system_enabled"] = body.shellSystemEnabled
    if body.shellDangerousEnabled is not None:
        data["shell_dangerous_enabled"] = body.shellDangerousEnabled
    if body.shellAutopilotEnabled is not None:
        data["shell_autopilot_enabled"] = body.shellAutopilotEnabled
    if body.showToolInteractions is not None:
        data["show_tool_interactions"] = body.showToolInteractions
    if body.toolInjectionMode is not None and body.toolInjectionMode in _TOOL_INJECTION_MODES:
        data["tool_injection_mode"] = body.toolInjectionMode
    prefs.data = data
    if personality_changed or personality_toggle_changed:
        await invalidate_personality_snapshots(db, user.id)
    await db.commit()
    shell_changed = any(
        field in body.model_fields_set
        for field in {
            "shellEnabled", "shellSystemEnabled", "shellDangerousEnabled", "shellAutopilotEnabled",
        }
    )
    if shell_changed:
        from app.core import events
        await events.publish(user.id, "terminals", operation="refresh")
    if style_changed:
        from app.core import events
        await events.bump_context_revision(user.id, "preferences")
    if personality_changed or personality_toggle_changed:
        from app.core import events
        await events.bump_context_revision(user.id, "preferences")
    return _to_response(data, read_personality_file(user.id))
