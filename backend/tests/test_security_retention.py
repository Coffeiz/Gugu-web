"""Phase 5 安全事件保留期和清理回归测试。"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select

from app.core.tz import now_utc
from app.models import File, SecurityEvent
from app.security.events import cleanup_expired_security_events


async def test_cleanup_removes_only_expired_security_events(db, user_a):
    now = now_utc()
    expired = SecurityEvent(
        user_id=user_a.id,
        event_type="ownership.denied",
        resource_type="File",
        resource_fingerprint="expired-resource",
        action="logged",
        reason_code="ownership_mismatch",
        metadata_json={},
        occurred_at=now - timedelta(days=91),
        expires_at=now - timedelta(seconds=1),
    )
    retained = SecurityEvent(
        user_id=user_a.id,
        event_type="ownership.denied",
        resource_type="File",
        resource_fingerprint="retained-resource",
        action="logged",
        reason_code="ownership_mismatch",
        metadata_json={},
        occurred_at=now,
        expires_at=now + timedelta(days=89),
    )
    business_file = File(
        user_id=user_a.id,
        display_name="keep-business-data",
        ext="md",
        storage_key="keep-business-data",
    )
    db.add_all([expired, retained, business_file])
    await db.commit()

    assert await cleanup_expired_security_events(db, now=now) == 1

    events = (await db.execute(select(SecurityEvent))).scalars().all()
    assert [event.resource_fingerprint for event in events] == ["retained-resource"]
    assert await db.get(File, business_file.id) is not None
