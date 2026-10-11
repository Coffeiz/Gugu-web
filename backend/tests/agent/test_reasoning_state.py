from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select

import agent.context.reasoning_runtime as reasoning_runtime
from agent.context.reasoning_state import (
    ProviderStateEnvelope,
    ReasoningPersistencePolicy,
    configuration_fingerprint,
    model_state_fingerprints,
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


def test_endpoint_identity_is_distinct_without_recording_url_credentials():
    """兼容端点变更使状态失效，URL 中的认证部分不进入身份或状态元数据。"""
    def fingerprints(url):
        return model_state_fingerprints(SimpleNamespace(model="synthetic", base_url=url),
                                        provider="anthropic", api_format="anthropic")

    assert fingerprints("https://a.example/v1") != fingerprints("https://b.example/v1")
    assert fingerprints("https://secret@a.example/v1?key=synthetic") == fingerprints("https://a.example/v1")


@pytest.mark.asyncio
async def test_boundary_refreshes_version_and_stale_failure_preserves_new_state(db, user_a, monkeypatch):
    """压缩后新状态可提交，旧 Run 的失败不能清除另一 Run 已提交的状态。"""
    session, envelope = await _seed_active_state(db, user_a, monkeypatch, key=b"r" * 32)

    class DbContext:
        async def __aenter__(self):
            return db

        async def __aexit__(self, *_args):
            return False

    coordinator = ReasoningStateCoordinator(
        user_id=user_a.id, session_id=session.id, model_cfg=SimpleNamespace(model="claude-test"),
        policy=ReasoningPersistencePolicy("continuation"), session_factory=DbContext,
    )
    coordinator.expected_version = 1
    await coordinator.boundary_changed("baseline_changed")
    assert coordinator.expected_version == 2
    await commit_state(db, user_id=user_a.id, session_id=session.id, envelope=envelope, expected_version=2)
    await db.commit()
    await coordinator.failed("provider_rejected")
    row = (await db.execute(select(ProviderReasoningState))).scalar_one()
    assert row.status == "active"
    assert row.version == 3


@pytest.mark.asyncio
async def test_legacy_history_cleanup_keeps_continuation_state_available(
    db, user_a, monkeypatch,
):
    """旧 session 清理历史 thinking 时，续接状态仍应独立恢复到 provider 边界。"""
    import app.byok.crypto as byok_crypto
    from agent import providers
    from agent.context.provider_history import clean_persisted_history, prepare_session
    from agent.loop_drivers import AnthropicDriver

    monkeypatch.setattr(byok_crypto, "_master_key", lambda version=1: b"r" * 32)
    adapter = SimpleNamespace(
        name="minimax",
        protocol_format=lambda _ai: "anthropic",
    )
    monkeypatch.setattr(providers, "adapter_for", lambda _ai: adapter)

    session = await _session(db, user_a.id)
    historical_thinking = {
        "type": "thinking", "thinking": "历史 provider 推理", "signature": "opaque-signature",
    }
    message = ConversationMessage(
        session_id=session.id,
        role="assistant",
        content_json=[historical_thinking, {"type": "text", "text": "已发出的答复"}],
    )
    db.add(message)
    await db.commit()

    model = SimpleNamespace(
        provider="minimax", model="MiniMax-M3.1-Flash-Preview",
        context_tokens=128000, max_tokens=8000, thinking="adaptive",
        reasoning_effort=None, thinking_budget=None, store=True,
        include_encrypted_reasoning=None,
    )
    config_digest, reasoning_digest = model_state_fingerprints(
        model, provider="minimax", api_format="anthropic", tool_digest="tools-digest",
    )
    envelope = ProviderStateEnvelope.from_payload(
        owner_user_id=user_a.id,
        session_id=session.id,
        provider="minimax",
        api_format="anthropic",
        model_id=model.model,
        reasoning_persistence="continuation",
        config_digest=config_digest,
        reasoning_config_digest=reasoning_digest,
        source_run_id="run-previous",
        source_round_id="round-1",
        sequence=1,
        state_kind="anthropic_thinking_blocks",
        payload={"tail_blocks": [historical_thinking], "history_thinking_by_tool_id": {}},
        expires_at=now_utc() + timedelta(hours=1),
        state_summary={"state_block_count": 1},
    )
    await commit_state(
        db, user_id=user_a.id, session_id=session.id, envelope=envelope, expected_version=0,
    )
    await db.commit()

    # 无 provenance 的旧 session 会触发一次 canonical 历史清理。
    _, changed = prepare_session(session, model)
    assert changed is True
    assert clean_persisted_history([message]) == 1
    assert message.content_json == [{"type": "text", "text": "已发出的答复"}]

    class _DbContext:
        async def __aenter__(self):
            return db

        async def __aexit__(self, *_args):
            return None

    ctx = SimpleNamespace(tool_state_digest="tools-digest", restored_blocks=None)
    coordinator = ReasoningStateCoordinator(
        user_id=user_a.id,
        session_id=session.id,
        model_cfg=model,
        policy=ReasoningPersistencePolicy("continuation"),
        session_factory=_DbContext,
    )
    await coordinator.prepared(AnthropicDriver(), ctx)

    assert coordinator.diagnostics()["continuation_reused"] is True
    assert ctx.restored_blocks == [historical_thinking]


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
        config_digest=configuration_fingerprint({}),
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


async def _seed_active_state(db, user, monkeypatch, *, key: bytes):
    import app.byok.crypto as byok_crypto

    monkeypatch.setattr(byok_crypto, "_master_key", lambda version=1: key)
    session = await _session(db, user.id)
    envelope = _envelope(user, session)
    await commit_state(
        db, user_id=user.id, session_id=session.id, envelope=envelope, expected_version=0
    )
    await db.commit()
    return session, envelope


def test_policy_has_single_safe_boundary():
    assert ReasoningPersistencePolicy.from_value(None).mode == "off"
    assert ReasoningPersistencePolicy.from_value(" CONTINUATION ").can_resume
    with pytest.raises(ValueError):
        ReasoningPersistencePolicy.from_value("unknown")
    with pytest.raises(ValueError):
        ReasoningPersistencePolicy.from_value("summary")
    assert not hasattr(ReasoningPersistencePolicy("continuation"), "previous_response_id")


@pytest.mark.asyncio
async def test_coordinator_diagnostics_distinguish_state_lifecycle(monkeypatch):
    model = SimpleNamespace(
        provider="anthropic", model="claude-test", context_tokens=128000,
        max_tokens=8000, thinking="adaptive",
    )
    driver = SimpleNamespace(
        api_format="anthropic", continuation_available=True,
        configure_reasoning_replay=lambda target, *, enabled: setattr(
            target, "reasoning_replay_enabled", enabled,
        ),
    )
    ctx = SimpleNamespace(tool_state_digest="tools-digest")

    disabled = ReasoningStateCoordinator(
        user_id="user-a", session_id=None, model_cfg=model,
        policy=ReasoningPersistencePolicy("off"), session_factory=None,
    )
    await disabled.prepared(driver, ctx)
    assert disabled.diagnostics()["state_status"] == "disabled"
    assert disabled.diagnostics()["continuation_attempted"] is False
    assert ctx.reasoning_replay_enabled is False

    unavailable = ReasoningStateCoordinator(
        user_id="user-a", session_id=None, model_cfg=model,
        policy=ReasoningPersistencePolicy("continuation"), session_factory=None,
    )
    await unavailable.prepared(driver, ctx)
    assert ctx.reasoning_replay_enabled is True
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


@pytest.mark.asyncio
async def test_coordinator_off_invalidates_state_before_pool_can_restore_it(monkeypatch):
    calls = []

    class _DbContext:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def commit(self):
            return None

    async def load_for_non_resumable(*_args, **kwargs):
        calls.append(kwargs["policy"].mode)
        return ProviderStateLookup(expected_version=7, unavailable_reason="disabled")

    monkeypatch.setattr(reasoning_runtime.provider_reasoning_state, "load_state", load_for_non_resumable)
    model = SimpleNamespace(provider="anthropic", model="claude-test", context_tokens=128000)
    driver = SimpleNamespace(api_format="anthropic", continuation_available=False)
    ctx = SimpleNamespace(tool_state_digest="tools-digest")

    off = ReasoningStateCoordinator(
        user_id="user-a", session_id=7, model_cfg=model,
        policy=ReasoningPersistencePolicy("off"),
        session_factory=lambda: _DbContext(),
    )
    await off.prepared(driver, ctx)
    assert off.expected_version == 7
    assert off.diagnostics()["state_status"] == "disabled"

    assert calls == ["off"]


@pytest.mark.asyncio
async def test_invalidate_user_states_clears_only_active_rows(db, user_a, monkeypatch):
    from app.services.provider_reasoning_state import invalidate_user_states

    await _seed_active_state(db, user_a, monkeypatch, key=b"r" * 32)
    count = await invalidate_user_states(db, user_id=user_a.id)
    assert count == 1
    await db.commit()
    row = (await db.execute(select(ProviderReasoningState))).scalar_one()
    assert row.status == "invalidated"
    assert row.invalidated_reason == "config_changed"

    # 再次执行是幂等的，不会继续增加版本。
    version = row.version
    assert await invalidate_user_states(db, user_id=user_a.id) == 0
    assert row.version == version


@pytest.mark.asyncio
async def test_responses_incompatible_invalidates_persisted_state(db, user_a, monkeypatch):
    """Responses 回退必须真正失效旧 reasoning state，避免下一轮重复撞 Responses。"""
    import app.byok.crypto as byok_crypto

    monkeypatch.setattr(byok_crypto, "_master_key", lambda version=1: b"r" * 32)
    session = await _session(db, user_a.id)
    envelope = _envelope(user_a, session, provider="openai", state_kind="openai_responses")
    await commit_state(db, user_id=user_a.id, session_id=session.id, envelope=envelope, expected_version=0)
    await db.commit()

    class _DbContext:
        async def __aenter__(self):
            return db

        async def __aexit__(self, *_args):
            return None

    model = SimpleNamespace(provider="openai", model="gpt-test")
    coordinator = ReasoningStateCoordinator(
        user_id=user_a.id,
        session_id=session.id,
        model_cfg=model,
        policy=ReasoningPersistencePolicy("continuation"),
        session_factory=lambda: _DbContext(),
    )

    coordinator.expected_version = 1
    await coordinator.failed("responses_incompatible")

    row = (await db.execute(select(ProviderReasoningState))).scalar_one()
    assert row.status == "invalidated"
    assert row.invalidated_reason == "responses_incompatible"
    assert coordinator.diagnostics()["invalidated_reason"] == "responses_incompatible"


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
async def test_off_never_replays_provider_payload(db, user_a, monkeypatch):
    session, envelope = await _seed_active_state(db, user_a, monkeypatch, key=b"m" * 32)

    off = await load_state(
        db, user_id=user_a.id, session_id=session.id, policy=ReasoningPersistencePolicy("off"),
        provider="anthropic", api_format="anthropic", model_id="claude-test",
        config_digest=envelope.config_digest, reasoning_config_digest=envelope.reasoning_config_digest,
    )
    assert off.envelope is None
    assert off.unavailable_reason == "disabled"

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
