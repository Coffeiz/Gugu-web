"""新手引导状态读写 + claim-once。

claim-once：某块内容（welcome/guide/lookback/hint:<name>）**首次** claim 返回随机文案 +
标记已读，之后返回 None。用行锁保证并发只触发一次。文案全静态、不过 LLM。
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from onboarding import content
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
    # 兼容旧行：补齐后加的键
    merged = {**default_state(), **(row.state or {})}
    merged["hints"] = {**default_state()["hints"], **(row.state or {}).get("hints", {})}
    return merged


# ── claim-once：key → (取文案, 读/写标记) ─────────────────────────

def _text_for(key: str, state: dict):
    if key == "welcome":
        return content.pick(content.WELCOME)
    if key == "guide":
        return content.pick(content.GUIDE)
    if key == "lookback":
        t = content.pick(content.LOOKBACK)
        name = state.get("seeded_project_name") or "从这里开始"
        return t.format(project_name=name) if t else None
    if key.startswith("hint:"):
        return content.pick_hint(key[5:])
    return None


def _is_claimed(state: dict, key: str) -> bool:
    if key in ("welcome", "guide", "lookback"):
        return bool(state.get(f"{key}_shown"))
    if key.startswith("hint:"):
        return bool(state.get("hints", {}).get(key[5:]))
    return True   # 未知 key 当已读，永不返回文案


def _set_claimed(state: dict, key: str) -> None:
    if key in ("welcome", "guide", "lookback"):
        state[f"{key}_shown"] = True
    elif key.startswith("hint:"):
        state.setdefault("hints", {})[key[5:]] = True


async def claim(db: AsyncSession, user_id, key: str) -> str | None:
    """首次 claim → 返回随机文案 + 标记已读；已读或未知 key → None。"""
    row = await get_or_create(db, user_id, for_update=True)
    state = {**default_state(), **(row.state or {})}
    state["hints"] = {**default_state()["hints"], **(row.state or {}).get("hints", {})}
    if _is_claimed(state, key):
        return None
    text = _text_for(key, state)
    _set_claimed(state, key)
    row.state = state
    flag_modified(row, "state")
    await db.commit()
    return text


async def update_state(db: AsyncSession, user_id, patch: dict) -> dict:
    """合并写入若干顶层键（播种回填 seeded/seeded_project_id 等用）。"""
    row = await get_or_create(db, user_id, for_update=True)
    state = {**default_state(), **(row.state or {})}
    state["hints"] = {**default_state()["hints"], **(row.state or {}).get("hints", {})}
    state.update(patch)
    row.state = state
    flag_modified(row, "state")
    await db.commit()
    return state


async def peek(db: AsyncSession, user_id, key: str) -> str | None:
    """取某 key 的随机文案但**不标记已读**（demo「立刻触发」用）。"""
    st = await get_state(db, user_id)
    return _text_for(key, st)


async def reset(db: AsyncSession, user_id) -> None:
    """demo：清零所有「已读」标记（保留 seeded/seeded_project_id），可重新自然触发气泡。"""
    row = await get_or_create(db, user_id, for_update=True)
    state = {**default_state(), **(row.state or {})}
    keep = {k: state.get(k) for k in ("seeded", "seeded_project_id", "seeded_project_name")}
    fresh = default_state()
    fresh.update(keep)
    row.state = fresh
    flag_modified(row, "state")
    await db.commit()
