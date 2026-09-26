"""PRD-SHELL-4 Phase 4：授权开关、审计和拒绝指标。"""

import pytest
import json
from types import SimpleNamespace
from sqlalchemy import select

from app.core import config
from app.core.config import AppSettings, DatabaseSettings, SandboxSettings
from app.models import ConversationSession, FilesystemAuthorizationGrant, SecurityEvent
from app.services.filesystem_authorization import (
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


def test_full_user_sandbox_authorization_is_on_by_default():
    assert SandboxSettings().full_user_sandbox_authorization_enabled is True


def test_unknown_sandbox_settings_are_not_loaded(tmp_path, monkeypatch):
    override = tmp_path / "config.override.json"
    override.write_text(json.dumps({
        "sandbox": {
            "retired_authorization_toggle": False,
        },
    }), encoding="utf-8")
    monkeypatch.setattr(config, "OVERRIDE_FILE", override)

    settings = AppSettings(db=DatabaseSettings(password="test-db-password")).apply_override()

    assert settings.sandbox.full_user_sandbox_authorization_enabled is True

    assert not hasattr(settings.sandbox, "retired_authorization_toggle")


@pytest.mark.asyncio
async def test_saving_sandbox_settings_cleans_unknown_override_keys(tmp_path, monkeypatch):
    override = tmp_path / "config.override.json"
    override.write_text(json.dumps({
        "sandbox": {
            "retired_authorization_toggle": False,
            "image": "debian:bookworm-slim",
        },
    }), encoding="utf-8")
    monkeypatch.setattr(config, "OVERRIDE_FILE", override)
    monkeypatch.setattr(config, "get_settings", lambda: AppSettings(db=DatabaseSettings(password="test-db-password")))

    await config.save_override({
        "sandbox": {"full_user_sandbox_authorization_enabled": True},
    })

    saved = json.loads(override.read_text(encoding="utf-8"))
    assert saved["sandbox"] == {
        "image": "debian:bookworm-slim",
        "full_user_sandbox_authorization_enabled": True,
    }


def test_rootless_is_not_required_by_default_for_user_facing_sandbox():
    assert SandboxSettings().rootless_required is False


@pytest.mark.asyncio
async def test_disabled_flag_ignores_existing_grant_and_blocks_new_grant(db, user_a, monkeypatch):
    import app.services.filesystem_authorization as authorization

    monkeypatch.setattr(authorization, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(backend="local"),
        sandbox=SimpleNamespace(full_user_sandbox_authorization_enabled=False),
    ))
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
async def test_disabled_flag_does_not_offer_model_authorization_prompt(user_a, monkeypatch):
    import app.services.filesystem_authorization as authorization

    monkeypatch.setattr(authorization, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(backend="local"),
        sandbox=SimpleNamespace(full_user_sandbox_authorization_enabled=False),
    ))
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
    policy = await resolve_filesystem_policy(db, user_a.id, subject_id=session.id)
    assert policy.full_user_sandbox is False


@pytest.mark.asyncio
async def test_session_grant_remains_effective_without_session_link_field(
    db, user_a, enable_filesystem_authorization,
):
    session = await _session(db, user_a)
    grant = FilesystemAuthorizationGrant(
        user_id=user_a.id, subject_type="session", subject_id=str(session.id),
        scope="user_sandbox", permission="read_write", granted_by="user",
    )
    db.add(grant)
    await db.flush()

    await db.commit()
    policy = await resolve_filesystem_policy(db, user_a.id, subject_id=session.id)

    assert policy.full_user_sandbox is True
    assert policy.grant_id == grant.id
