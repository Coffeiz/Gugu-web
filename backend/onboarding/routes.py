"""新手引导路由：用户端 state/claim + demo 控制（均作用于当前用户自己的 onboarding）。

挂载见 app/main.py。demo 端点只动「自己」的 onboarding（重置自己标记 / 重建自己的引导项目 /
给自己预览文案），无跨用户能力，故用普通用户鉴权即可、低风险。
"""
from fastapi import APIRouter, Depends
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User, Project, File
from onboarding import content, seed, state

router = APIRouter(prefix="/onboarding", tags=["onboarding"])


# ── 用户端 ───────────────────────────────────────────────────
@router.get("/state")
async def get_onboarding_state(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await state.get_state(db, current_user.id)


@router.post("/claim/{key:path}")
async def claim_onboarding(
    key: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """key ∈ {welcome, guide, lookback, hint:<name>}。首次返回文案 + 标记已读，之后 null。"""
    return {"text": await state.claim(db, current_user.id, key)}


# ── demo 控制（作用于当前用户自己） ──────────────────────────────
@router.get("/dev/pools")
async def dev_pools(_: User = Depends(get_current_user)):
    """各文案池预览（demo 面板展示）。"""
    return {
        "welcome": content.WELCOME, "guide": content.GUIDE,
        "project_names": content.PROJECT_NAMES,
        "stage_label_pools": content.STAGE_LABEL_POOLS, "stage_todos": content.STAGE_TODOS,
        "welcome_files": content.WELCOME_FILES,
        "scratch_bodies": content.SCRATCH_FILE_BODIES,
        "hints": content.HINTS, "lookback": content.LOOKBACK,
    }


@router.post("/dev/fire/{key:path}")
async def dev_fire(
    key: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """取某块随机文案但不标记已读（不重注册、不重置即可反复预览）。"""
    return {"text": await state.peek(db, current_user.id, key)}


@router.post("/dev/reset")
async def dev_reset(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """清零自己的已读标记（保留 seeded），气泡可重新自然触发。"""
    await state.reset(db, current_user.id)
    return {"ok": True}


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
    await seed.seed_for_user(db, current_user)
    return {"ok": True, "state": await state.get_state(db, uid)}
