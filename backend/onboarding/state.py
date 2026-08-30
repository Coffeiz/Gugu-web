"""新用户播种状态读写。"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from onboarding.models import OnboardingState, default_state


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
    merged = {**default_state(), **(row.state or {})}
    return merged


async def update_state(db: AsyncSession, user_id, patch: dict) -> dict:
    """合并写入若干顶层键（播种回填 seeded/seeded_project_id 等用）。"""
    row = await get_or_create(db, user_id, for_update=True)
    state = {**default_state(), **(row.state or {})}
    state.update(patch)
    row.state = state
    flag_modified(row, "state")
    await db.commit()
    return state
