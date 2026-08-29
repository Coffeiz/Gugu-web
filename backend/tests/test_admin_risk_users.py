"""Phase 3 Admin 风险用户与账户状态服务测试。"""
from __future__ import annotations

from app.api.v1.users_admin import list_risk_users
from app.core.tz import now_utc
from app.models import SecurityEvent
from app.security.account_status import suspend_user, unsuspend_user


async def test_suspend_and_unsuspend_updates_compatibility_state(db, user_a):
    await suspend_user(db, user_a, duration_seconds=600, reason="repeated_ownership_denied")
    assert user_a.account_status == "suspended"
    assert user_a.is_active is False
    assert user_a.suspended_until is not None
    first_version = user_a.security_version

    await unsuspend_user(db, user_a)
    assert user_a.account_status == "active"
    assert user_a.is_active is True
    assert user_a.suspended_until is None
    assert user_a.suspended_reason is None
    assert user_a.security_version == first_version + 1


async def test_risk_user_query_includes_suspended_accounts(db, user_a):
    await suspend_user(db, user_a, duration_seconds=600, reason="admin_manual_suspend")
    response = await list_risk_users(window_minutes=5, db=db)
    assert response["total"] == 1
    assert response["items"][0]["id"] == str(user_a.id)
    assert response["items"][0]["account_status"] == "suspended"


async def test_risk_user_visibility_uses_persistent_event_window(db, user_a):
    db.add(SecurityEvent(
        user_id=user_a.id,
        event_type="ownership.denied",
        resource_type="File",
        resource_fingerprint="f" * 64,
        action="logged",
        reason_code="ownership_mismatch",
        metadata_json={},
        occurred_at=now_utc(),
        expires_at=now_utc(),
    ))
    await db.commit()

    response = await list_risk_users(window_minutes=1440, db=db)
    assert response["policy_window_minutes"] == 5
    assert response["items"][0]["visible_event_count"] == 1
    assert response["items"][0]["recent_event_count"] == 1
