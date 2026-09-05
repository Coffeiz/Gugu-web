"""PRD-SHELL-4 Phase 4：授权开关、审计和拒绝指标。"""

from unittest.mock import Mock

import pytest
from sqlalchemy import select

from app.core.config import SandboxSettings
from app.models import ConversationSession, FilesystemAuthorizationGrant, SecurityEvent
from app.services.filesystem_authorization import (
    FilesystemPolicy,
    filesystem_write_error,
    grant_session_filesystem_access,
    resolve_filesystem_policy,
    revoke_session_filesystem_access,
)


async def _session(db, user):
    row = ConversationSession(user_id=user.id, title="授权测试", source="web")
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def test_filesystem_authorization_is_off_by_default():
    assert SandboxSettings().filesystem_authorization_enabled is False


@pytest.mark.asyncio
async def test_disabled_flag_ignores_existing_grant_and_blocks_new_grant(db, user_a):
    session = await _session(db, user_a)
    grant = FilesystemAuthorizationGrant(
        user_id=user_a.id, subject_type="session", subject_id=str(session.id),
        scope="user_sandbox", permission="read_write", granted_by="user",
    )
    db.add(grant)
    await db.flush()
    session.filesystem_authorization_grant_id = grant.id
    await db.commit()
    policy = await resolve_filesystem_policy(db, user_a.id, subject_id=session.id)

    assert policy.full_user_sandbox is False
    with pytest.raises(LookupError, match="未开启"):
        await grant_session_filesystem_access(db, user_a.id, session.id)


@pytest.mark.asyncio
async def test_disabled_flag_does_not_offer_model_authorization_prompt(user_a):
    from agent.tools.meta import _ask_user

    result = await _ask_user(None, user_a.id, {"authorization": "user_sandbox"})

    assert result == {"error": "完整用户沙箱授权功能当前未开启"}


@pytest.mark.asyncio
async def test_grant_and_revoke_are_audited_in_same_transaction(
    db, user_a, enable_filesystem_authorization,
):
    session = await _session(db, user_a)
    grant = await grant_session_filesystem_access(db, user_a.id, session.id, granted_by="askuser")
    await db.commit()

    events = (await db.scalars(select(SecurityEvent).order_by(SecurityEvent.id))).all()
    assert [event.reason_code for event in events] == ["granted"]
    assert events[0].event_type == "filesystem.authorization"
    assert events[0].resource_type == "filesystem:session"
    assert events[0].metadata_json["subject_id"] == str(session.id)
    assert events[0].metadata_json["grant_id"] == str(grant.id)
    assert events[0].metadata_json["source"] == "askuser"
    assert events[0].metadata_json["operation"] == "authorization"
    assert events[0].metadata_json["outcome"] == "granted"

    assert await revoke_session_filesystem_access(db, user_a.id, session.id) is True
    await db.commit()
    events = (await db.scalars(select(SecurityEvent).order_by(SecurityEvent.id))).all()
    assert [event.reason_code for event in events] == ["granted", "revoked"]
    await db.refresh(session)
    assert session.filesystem_authorization_grant_id is None


@pytest.mark.asyncio
async def test_denied_write_records_only_aggregate_metrics(db, user_a, monkeypatch):
    import app.core.opsmetrics as opsmetrics

    record_security = Mock()
    record_filesystem = Mock()
    monkeypatch.setattr(opsmetrics, "record_security", record_security)
    monkeypatch.setattr(opsmetrics, "record_filesystem_authorization", record_filesystem)

    error = await filesystem_write_error(
        db, user_a.id, FilesystemPolicy(), space="personal", folder_id=None,
    )

    assert error is not None and error.startswith("当前文件系统权限只允许读取")
    record_security.assert_called_once_with("filesystem.authorization.denied")
    record_filesystem.assert_called_once_with("denied", "session")
