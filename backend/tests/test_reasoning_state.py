from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select

import agent.context.reasoning_runtime as reasoning_runtime
from agent.context.reasoning_state import (
    ProviderStateEnvelope,
    ReasoningPersistencePolicy,
    configuration_fingerprint,
)
from agent.context.reasoning_runtime import ReasoningStateCoordinator
from app.core.tz import now_utc
from app.models import ConversationMessage, ConversationSession, ProviderReasoningState
from app.services.provider_reasoning_state import (
    ProviderStateAccessError,
    ProviderStateConflict,
    ProviderStateLookup,
    commit_state,
    delete_state,
    expire_states,
    load_state,
)


async def _session(db, user_id):
    item = ConversationSession(user_id=user_id, title="状态测试")
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item


def _envelope(user, session, *, run_id="run-1", provider="anthropic", mode="continuation",
              state_kind="anthropic_thinking_blocks", created_at=None, expires_at=None, payload=None,
              state_summary=None):
    created = created_at or now_utc()
    return ProviderStateEnvelope.from_payload(
        owner_user_id=user.id,
        session_id=session.id,
        provider=provider,
        api_format="anthropic",
        model_id="claude-test",
        reasoning_persistence=mode,
        config_digest=configuration_fingerprint({"temperature": 0}),
        reasoning_config_digest=configuration_fingerprint({"thinking": True}),
        source_run_id=run_id,
        source_round_id="round-1",
        sequence=1,
        state_kind=state_kind,
        payload=payload or {"blocks": [{"type": "thinking", "signature": "opaque"}]},
        created_at=created,
        expires_at=expires_at or created + timedelta(hours=1),
        state_summary=state_summary or {"block_count": 1, "reasoning_tokens": 12},
    )


def test_policy_has_single_safe_boundary():
    assert ReasoningPersistencePolicy.from_value(None).mode == "off"
    assert ReasoningPersistencePolicy.from_value(" CONTINUATION ").can_resume
    with pytest.raises(ValueError):
        ReasoningPersistencePolicy.from_value("unknown")
    assert not hasattr(ReasoningPersistencePolicy("continuation"), "previous_response_id")


@pytest.mark.asyncio
async def test_coordinator_diagnostics_distinguish_state_lifecycle(monkeypatch):
    model = SimpleNamespace(
        provider="anthropic", model="claude-test", context_tokens=128000,
        max_tokens=8000, temperature=0.2, thinking="adaptive",
    )
    driver = SimpleNamespace(api_format="anthropic", continuation_available=True)
    ctx = SimpleNamespace(tool_state_digest="tools-digest")

    disabled = ReasoningStateCoordinator(
        user_id="user-a", session_id=None, model_cfg=model,
        policy=ReasoningPersistencePolicy("off"), session_factory=None,
    )
    await disabled.prepared(driver, ctx)
    assert disabled.diagnostics()["state_status"] == "disabled"
    assert disabled.diagnostics()["continuation_attempted"] is False

    unavailable = ReasoningStateCoordinator(
        user_id="user-a", session_id=None, model_cfg=model,
        policy=ReasoningPersistencePolicy("continuation"), session_factory=None,
    )
    await unavailable.prepared(driver, ctx)
    diagnostics = unavailable.diagnostics()
    assert diagnostics["state_status"] == "unavailable"
    assert diagnostics["continuation_attempted"] is True
    assert diagnostics["continuation_unavailable"] is True
    assert diagnostics["unavailable_reason"] == "missing_session"
    assert "payload" not in diagnostics

    class _DbContext:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def commit(self):
            return None

    async def load_expired(*_args, **_kwargs):
        return ProviderStateLookup(expected_version=3, unavailable_reason="expired")

    monkeypatch.setattr(reasoning_runtime.provider_reasoning_state, "load_state", load_expired)
    expired = ReasoningStateCoordinator(
        user_id="user-a", session_id=7, model_cfg=model,
        policy=ReasoningPersistencePolicy("continuation"),
        session_factory=lambda: _DbContext(),
    )
    await expired.prepared(driver, ctx)
    expired_diagnostics = expired.diagnostics()
    assert expired_diagnostics["state_status"] == "expired"
    assert expired_diagnostics["invalidated_reason"] == "expired"
    assert expired_diagnostics["continuation_unavailable"] is True

    rejected = ReasoningStateCoordinator(
        user_id="user-a", session_id=None, model_cfg=model,
        policy=ReasoningPersistencePolicy("continuation"), session_factory=None,
    )
    await rejected.failed()
    assert rejected.diagnostics()["state_status"] == "provider_rejected"
    assert rejected.diagnostics()["invalidated_reason"] == "provider_rejected"


def test_envelope_fingerprints_payload_but_metadata_excludes_it():
    # 这里只测纯对象边界；数据库加密回归在异步用例中覆盖。
    user = type("User", (), {"id": "user-a"})()
    session = type("Session", (), {"id": 7})()
    envelope = _envelope(user, session, payload={"private": "provider-only"})
    assert envelope.payload_digest == configuration_fingerprint({"private": "provider-only"})
    assert envelope.payload_size == len(envelope.payload_json().encode("utf-8"))
    assert "payload" not in envelope.metadata()
    assert "provider-only" not in repr(envelope)


@pytest.mark.asyncio
async def test_commit_load_encrypts_and_isolated_from_canonical_history(db, user_a, monkeypatch):
    import app.byok.crypto as byok_crypto

    monkeypatch.setattr(byok_crypto, "_master_key", lambda version=1: b"r" * 32)
    session = await _session(db, user_a.id)
    envelope = _envelope(user_a, session)

    version = await commit_state(
        db, user_id=user_a.id, session_id=session.id, envelope=envelope, expected_version=0
    )
    await db.commit()
    assert version == 1

    row = (await db.execute(select(ProviderReasoningState))).scalar_one()
    assert row.encrypted_payload != envelope.payload_json()
    assert row.payload_size == envelope.payload_size

    loaded = await load_state(
        db,
        user_id=user_a.id,
        session_id=session.id,
        policy=ReasoningPersistencePolicy("continuation"),
        provider="anthropic",
        api_format="anthropic",
        model_id="claude-test",
        config_digest=envelope.config_digest,
        reasoning_config_digest=envelope.reasoning_config_digest,
    )
    assert loaded.envelope is not None
    assert loaded.envelope.payload == envelope.payload
    assert loaded.expected_version == 1

    message = ConversationMessage(session_id=session.id, role="assistant", content="普通回复")
    db.add(message)
    await db.commit()
    assert (await db.execute(select(ConversationMessage))).scalars().all() == [message]


@pytest.mark.asyncio
async def test_stale_run_cannot_overwrite_newer_state(db, user_a, monkeypatch):
    import app.byok.crypto as byok_crypto

    monkeypatch.setattr(byok_crypto, "_master_key", lambda version=1: b"s" * 32)
    session = await _session(db, user_a.id)
    first = _envelope(user_a, session, run_id="run-1")
    await commit_state(db, user_id=user_a.id, session_id=session.id, envelope=first, expected_version=0)
    await db.commit()

    second = _envelope(user_a, session, run_id="run-2", payload={"blocks": ["new"]})
    await commit_state(db, user_id=user_a.id, session_id=session.id, envelope=second, expected_version=1)
    await db.commit()

    stale = _envelope(user_a, session, run_id="run-old", payload={"blocks": ["stale"]})
    with pytest.raises(ProviderStateConflict):
        await commit_state(db, user_id=user_a.id, session_id=session.id, envelope=stale, expected_version=1)
    row = (await db.execute(select(ProviderReasoningState))).scalar_one()
    assert row.source_run_id == "run-2"


@pytest.mark.asyncio
async def test_owner_cannot_read_another_users_session_state(db, user_a, user_b, monkeypatch):
    import app.byok.crypto as byok_crypto

    monkeypatch.setattr(byok_crypto, "_master_key", lambda version=1: b"o" * 32)
    session = await _session(db, user_a.id)
    envelope = _envelope(user_a, session)
    await commit_state(db, user_id=user_a.id, session_id=session.id, envelope=envelope, expected_version=0)
    await db.commit()

    with pytest.raises(ProviderStateAccessError):
        await load_state(
            db,
            user_id=user_b.id,
            session_id=session.id,
            policy=ReasoningPersistencePolicy("continuation"),
            provider="anthropic",
            api_format="anthropic",
            model_id="claude-test",
            config_digest=envelope.config_digest,
            reasoning_config_digest=envelope.reasoning_config_digest,
        )


@pytest.mark.asyncio
async def test_expired_and_changed_state_is_invalidated_without_replay(db, user_a, monkeypatch):
    import app.byok.crypto as byok_crypto

    monkeypatch.setattr(byok_crypto, "_master_key", lambda version=1: b"e" * 32)
    session = await _session(db, user_a.id)
    created = now_utc() - timedelta(hours=2)
    envelope = _envelope(
        user_a,
        session,
        created_at=created,
        expires_at=now_utc() - timedelta(hours=1),
    )
    await commit_state(db, user_id=user_a.id, session_id=session.id, envelope=envelope, expected_version=0)
    await db.commit()

    expired = await load_state(
        db,
        user_id=user_a.id,
        session_id=session.id,
        policy=ReasoningPersistencePolicy("continuation"),
        provider="anthropic",
        api_format="anthropic",
        model_id="claude-test",
        config_digest=envelope.config_digest,
        reasoning_config_digest=envelope.reasoning_config_digest,
    )
    assert expired.envelope is None
    assert expired.unavailable_reason == "expired"
    row = (await db.execute(select(ProviderReasoningState))).scalar_one()
    assert row.status == "invalidated"
    assert row.encrypted_payload == ""

    fresh = _envelope(user_a, session, run_id="run-2")
    await commit_state(
        db, user_id=user_a.id, session_id=session.id, envelope=fresh, expected_version=row.version
    )
    await db.commit()
    changed = await load_state(
        db,
        user_id=user_a.id,
        session_id=session.id,
        policy=ReasoningPersistencePolicy("continuation"),
        provider="openai",
        api_format="responses",
        model_id="gpt-test",
        config_digest=fresh.config_digest,
        reasoning_config_digest=fresh.reasoning_config_digest,
    )
    assert changed.envelope is None
    assert changed.unavailable_reason == "provider_changed"


@pytest.mark.asyncio
async def test_off_and_summary_never_replay_provider_payload(db, user_a, monkeypatch):
    import app.byok.crypto as byok_crypto

    monkeypatch.setattr(byok_crypto, "_master_key", lambda version=1: b"m" * 32)
    session = await _session(db, user_a.id)
    envelope = _envelope(user_a, session)
    await commit_state(db, user_id=user_a.id, session_id=session.id, envelope=envelope, expected_version=0)
    await db.commit()

    off = await load_state(
        db, user_id=user_a.id, session_id=session.id, policy=ReasoningPersistencePolicy("off"),
        provider="anthropic", api_format="anthropic", model_id="claude-test",
        config_digest=envelope.config_digest, reasoning_config_digest=envelope.reasoning_config_digest,
    )
    assert off.envelope is None
    assert off.unavailable_reason == "disabled"

    summary = await load_state(
        db, user_id=user_a.id, session_id=session.id, policy=ReasoningPersistencePolicy("summary"),
        provider="anthropic", api_format="anthropic", model_id="claude-test",
        config_digest=envelope.config_digest, reasoning_config_digest=envelope.reasoning_config_digest,
    )
    assert summary.envelope is None
    assert summary.unavailable_reason == "summary_only"


@pytest.mark.asyncio
async def test_summary_can_store_only_restricted_metrics(db, user_a, monkeypatch):
    import app.byok.crypto as byok_crypto

    monkeypatch.setattr(byok_crypto, "_master_key", lambda version=1: b"y" * 32)
    session = await _session(db, user_a.id)
    metrics = {"block_count": 2, "reasoning_tokens": 20, "state_digest": "a" * 64}
    envelope = _envelope(
        user_a, session, mode="summary", state_kind="summary", payload=metrics,
        state_summary=metrics,
    )
    assert await commit_state(
        db, user_id=user_a.id, session_id=session.id, envelope=envelope, expected_version=0
    ) == 1
    await db.commit()
    row = (await db.execute(select(ProviderReasoningState))).scalar_one()
    assert row.state_summary == metrics
    assert row.encrypted_payload != envelope.payload_json()


@pytest.mark.asyncio
async def test_expire_and_explicit_delete_contract(db, user_a, monkeypatch):
    import app.byok.crypto as byok_crypto

    monkeypatch.setattr(byok_crypto, "_master_key", lambda version=1: b"x" * 32)
    session = await _session(db, user_a.id)
    created = now_utc() - timedelta(hours=2)
    envelope = _envelope(
        user_a, session, created_at=created, expires_at=now_utc() - timedelta(hours=1)
    )
    await commit_state(db, user_id=user_a.id, session_id=session.id, envelope=envelope, expected_version=0)
    await db.commit()
    assert await expire_states(db, now=now_utc()) == 1
    await db.commit()
    row = (await db.execute(select(ProviderReasoningState))).scalar_one()
    assert row.status == "invalidated"
    assert await delete_state(db, user_id=user_a.id, session_id=session.id)
    await db.commit()
    assert (await db.execute(select(ProviderReasoningState))).scalars().all() == []


@pytest.mark.asyncio
async def test_delete_session_deletes_provider_state(db, user_a, monkeypatch):
    import app.byok.crypto as byok_crypto

    monkeypatch.setattr(byok_crypto, "_master_key", lambda version=1: b"d" * 32)
    session = await _session(db, user_a.id)
    envelope = _envelope(user_a, session)
    await commit_state(db, user_id=user_a.id, session_id=session.id, envelope=envelope, expected_version=0)
    await db.commit()
    await db.delete(session)
    await db.commit()
    assert (await db.execute(select(ProviderReasoningState))).scalars().all() == []
