"""新用户播种状态读写。"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from onboarding.guide_state import validate_patch
from onboarding.models import OnboardingState, default_state, normalize_state


async def get_or_create(db: AsyncSession, user_id, *, for_update=False) -> OnboardingState:
    stmt = select(OnboardingState).where(OnboardingState.user_id == user_id)
    if for_update:
        stmt = stmt.with_for_update()
    row = (await db.execute(stmt)).scalar_one_or_none()
    if row is None:
        row = OnboardingState(user_id=user_id, state=default_state())
        db.add(row)
        await db.flush()
    return row


async def get_state(db: AsyncSession, user_id) -> dict:
    row = await get_or_create(db, user_id)
    return normalize_state(row.state)


async def update_state(db: AsyncSession, user_id, patch: dict) -> dict:
    """合并写入状态域；调用方负责传入 seed 或 guide 命名空间。"""
    row = await get_or_create(db, user_id, for_update=True)
    state = normalize_state(row.state)
    state.update(patch)
    row.state = state
    flag_modified(row, "state")
    await db.commit()
    return state


async def update_guide_state(db: AsyncSession, user_id, patch: dict) -> dict:
    current = await get_state(db, user_id)
    guide = {**current["guide"], **validate_patch(patch)}
    return await update_state(db, user_id, {"guide": guide})


async def reset_guide_state(db: AsyncSession, user_id) -> dict:
    current = await get_state(db, user_id)
    guide = {
        **current["guide"],
        "enabled": True,
        "version": 1,
        "current_step": "locale",
        "completed_steps": [],
        "dismissed": False,
        "completed_at": None,
    }
    return await update_state(db, user_id, {"guide": guide})


async def update_seed_state(db: AsyncSession, user_id, patch: dict) -> dict:
    current = await get_state(db, user_id)
    seed = {**current["seed"], **patch}
    return await update_state(db, user_id, {"seed": seed})
