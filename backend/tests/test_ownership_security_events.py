"""Phase 1 安全事件持久化与脱敏回归测试。"""
from __future__ import annotations

import logging

from sqlalchemy import select

from app.core.ownership import get_owned
from app.models import File, SecurityEvent
from app.security.events import security_fingerprint


async def test_cross_user_ownership_creates_sanitized_event(db, user_a, user_b, caplog):
    file = File(user_id=user_b.id, display_name="private-note", ext="md", storage_key="private")
    db.add(file)
    await db.commit()
    await db.refresh(file)

    with caplog.at_level(logging.WARNING, logger="ownership"):
        assert await get_owned(db, File, file.id, user_a.id) is None

    row = (await db.execute(select(SecurityEvent).where(SecurityEvent.user_id == user_a.id))).scalar_one()
    assert row.event_type == "ownership.denied"
    assert row.resource_fingerprint == security_fingerprint(file.id)
    assert row.owner_fingerprint == security_fingerprint(user_b.id)
    assert row.action == "logged"
    assert row.metadata_json == {}
    assert row.resource_fingerprint != str(file.id)
    assert row.resource_fingerprint != "private-note"
    assert row.owner_fingerprint != str(user_b.id)
    assert row.client_fingerprint is None
    assert row.ip_fingerprint is None
    assert row.user_agent_fingerprint is None
    assert not any(f"resource={file.id}" in record.getMessage() for record in caplog.records)


def test_security_fingerprint_is_stable_and_not_plaintext(monkeypatch):
    from types import SimpleNamespace
    import app.security.events as events

    monkeypatch.setattr(events, "get_settings", lambda: SimpleNamespace(secret_key="test-key"))
    first = security_fingerprint("resource-123")
    assert first == security_fingerprint("resource-123")
    assert first != "resource-123"
    assert len(first) == 64
