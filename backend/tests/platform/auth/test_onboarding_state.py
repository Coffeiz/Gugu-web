"""新手引导 Phase 1：状态迁移、用户隔离和首次展示判定。"""

import pytest
from pydantic import ValidationError

# app.models 不会为了业务启动而隐式加载独立 onboarding 表；测试需要显式注册它。
import onboarding.models  # noqa: F401


@pytest.mark.asyncio
async def test_legacy_state_is_normalized_without_losing_seeded_fields(db, user_a):
    from onboarding import state

    row = await state.get_or_create(db, user_a.id)
    row.state = {
        "seeded": True,
        "seeded_project_id": 123,
        "seeded_project_name": "示例项目",
    }
    await db.commit()

    result = await state.get_state(db, user_a.id)

    assert result["seed"]["seeded"] is True
    assert result["seed"]["project_id"] == 123
    assert result["guide"]["version"] == 1
    assert result["guide"]["completed_steps"] == []
    assert result["guide"]["enabled"] is False


@pytest.mark.asyncio
async def test_user_state_isolated_and_first_display_can_be_reopened(db, user_a, user_b):
    from onboarding.routes import OnboardingStatePatch, get_onboarding_state, reopen_onboarding, update_onboarding_state
    from onboarding import state

    await state.update_seed_state(db, user_a.id, {"seeded": True})
    await state.reset_guide_state(db, user_a.id)
    await state.update_seed_state(db, user_b.id, {"seeded": True})
    await state.reset_guide_state(db, user_b.id)

    visible = await get_onboarding_state(current_user=user_a, db=db)
    assert visible["should_show"] is True

    dismissed = await update_onboarding_state(
        OnboardingStatePatch(dismissed=True), current_user=user_a, db=db
    )
    assert dismissed["should_show"] is False
    assert (await get_onboarding_state(current_user=user_b, db=db))["should_show"] is True

    reopened = await reopen_onboarding(current_user=user_a, db=db)
    assert reopened["should_show"] is True
    assert reopened["seed"]["seeded"] is True


def test_user_patch_rejects_seeded_fields_and_invalid_steps():
    from onboarding.routes import OnboardingStatePatch
    from onboarding.guide_state import validate_patch

    with pytest.raises(ValidationError):
        OnboardingStatePatch.model_validate({"seeded": False})
    with pytest.raises(ValueError):
        validate_patch({"current_step": "not-a-step"})
    with pytest.raises(ValueError):
        validate_patch({"completed_steps": ["locale", "not-a-step"]})
