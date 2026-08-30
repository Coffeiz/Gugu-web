"""新用户播种状态与 Dev 重播种路由（均作用于当前用户自己的数据）。

挂载见 app/main.py。端点只动自己的播种项目，无跨用户能力。
"""
from fastapi import APIRouter, Depends
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User, Project, File, UserPreferences
from onboarding import seed, state

router = APIRouter(prefix="/onboarding", tags=["onboarding"])


# ── 用户端 ───────────────────────────────────────────────────
@router.get("/state")
async def get_onboarding_state(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await state.get_state(db, current_user.id)


# ── demo 控制（作用于当前用户自己） ──────────────────────────────
@router.post("/dev/reseed")
async def dev_reseed(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删掉自己旧的引导项目（含其文件行）→ 清 seeded → 重新播种。供反复测试播种产物。"""
    uid = current_user.id
    st = await state.get_state(db, uid)
    old_pid = st.get("seeded_project_id")
    if old_pid:
        await db.execute(delete(File).where(File.user_id == uid, File.project_id == old_pid))
        await db.execute(delete(Project).where(Project.id == old_pid, Project.user_id == uid))
        await db.commit()
    await state.update_state(db, uid, {"seeded": False, "seeded_project_id": None, "seeded_project_name": None})
    prefs = (await db.execute(select(UserPreferences).where(UserPreferences.user_id == uid))).scalar_one_or_none()
    locale = (prefs.data if prefs else {}).get("locale")
    await seed.seed_for_user(db, current_user, locale=locale)
    return {"ok": True, "state": await state.get_state(db, uid)}
