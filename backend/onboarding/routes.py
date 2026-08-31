"""新用户播种状态与 Dev 重播种路由（均作用于当前用户自己的数据）。

挂载见 app/main.py。端点只动自己的播种项目，无跨用户能力。
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User, Project, File, UserPreferences
from onboarding import seed, state
from onboarding.guide_state import GUIDE_VERSION, should_show

router = APIRouter(prefix="/onboarding", tags=["onboarding"])


class OnboardingStatePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_step: str | None = None
    completed_steps: list[str] | None = None
    dismissed: bool | None = None
    completed_at: str | None = None
    guide_version: int | None = Field(default=None, ge=1)


def _state_response(value: dict) -> dict:
    guide = value["guide"]
    visible = should_show(guide)
    return {**value, "guide": {**guide, "should_show": visible}, "should_show": visible}


# ── 用户端 ───────────────────────────────────────────────────
@router.get("/state")
async def get_onboarding_state(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return _state_response(await state.get_state(db, current_user.id))


@router.patch("/state")
async def update_onboarding_state(
    body: OnboardingStatePatch,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """只更新当前用户自己的引导进度，禁止覆盖播种字段。"""
    patch = body.model_dump(exclude_unset=True)
    if "guide_version" in patch:
        patch["version"] = patch.pop("guide_version")
    if "completed_at" in patch and patch["completed_at"] is None:
        patch.pop("completed_at")
    try:
        value = await state.update_guide_state(db, current_user.id, patch)
    except ValueError as exc:
        from fastapi import HTTPException
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _state_response(value)


@router.post("/state/reopen")
async def reopen_onboarding(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """主动重新打开当前版本引导，保留已完成步骤和播种内容。"""
    value = await state.update_guide_state(db, current_user.id, {
        "version": GUIDE_VERSION,
        "dismissed": False,
        "completed_at": None,
    })
    return _state_response(value)


# ── demo 控制（作用于当前用户自己） ──────────────────────────────
@router.post("/dev/reseed")
async def dev_reseed(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删掉自己旧的引导项目（含其文件行）→ 清 seeded → 重新播种。供反复测试播种产物。"""
    uid = current_user.id
    st = await state.get_state(db, uid)
    old_pid = st["seed"].get("project_id")
    if old_pid:
        await db.execute(delete(File).where(File.user_id == uid, File.project_id == old_pid))
        await db.execute(delete(Project).where(Project.id == old_pid, Project.user_id == uid))
        await db.commit()
    await state.update_seed_state(db, uid, {"seeded": False, "project_id": None, "project_name": None})
    prefs = (await db.execute(select(UserPreferences).where(UserPreferences.user_id == uid))).scalar_one_or_none()
    locale = (prefs.data if prefs else {}).get("locale")
    await seed.seed_for_user(db, current_user, locale=locale)
    return {"ok": True, "state": _state_response(await state.get_state(db, uid))}


@router.post("/dev/reset-guide")
async def dev_reset_guide(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """仅重置当前账号的引导进度，保留已播种的项目、文件和日历内容。"""
    result = await state.reset_guide_state(db, current_user.id)
    return {"ok": True, "state": _state_response(result)}
