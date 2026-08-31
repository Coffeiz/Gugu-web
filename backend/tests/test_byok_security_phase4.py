"""PRD-SEC-1 Phase 4：用户 BYOK 安全边界回归。"""

from types import SimpleNamespace
import pytest

from app.byok import crypto, policy, service
from app.models import UserProviderCredential


def _master(seed: str) -> str:
    return seed * 64


def test_envelope_never_stores_plaintext_and_round_trips(monkeypatch):
    monkeypatch.setenv("CREDENTIALS_MASTER_KEY", _master("a"))
    value = "sk-test-only-phase4-secret"

    ciphertext, nonce, wrapped_key = crypto.encrypt_envelope(value)

    assert value not in ciphertext
    assert value not in wrapped_key
    assert crypto.decrypt_envelope(ciphertext, nonce, wrapped_key) == value


def test_master_key_rotation_reads_previous_version(monkeypatch):
    old_key = _master("a")
    new_key = _master("b")
    monkeypatch.setenv("CREDENTIALS_MASTER_KEY", old_key)
    monkeypatch.setenv("CREDENTIALS_MASTER_KEY_VERSION", "1")
    ciphertext, nonce, wrapped_key = crypto.encrypt_envelope("rotation-secret", key_version=1)

    monkeypatch.setenv("CREDENTIALS_MASTER_KEY", new_key)
    monkeypatch.setenv("CREDENTIALS_MASTER_KEY_PREVIOUS", old_key)
    monkeypatch.setenv("CREDENTIALS_MASTER_KEY_VERSION", "2")

    assert crypto.decrypt_envelope(ciphertext, nonce, wrapped_key, key_version=1) == "rotation-secret"


@pytest.mark.asyncio
async def test_credentials_are_isolated_by_user(db, user_a, user_b, monkeypatch):
    # 隔离断言需要越过全局 BYOK 门禁，专门验证 user_id 过滤行为。
    monkeypatch.setattr(service, "byok_enabled", lambda: True)
    row = UserProviderCredential(
        user_id=user_b.id,
        provider="test-provider",
        capability="llm",
        encrypted_value="ciphertext",
        nonce="nonce",
        encrypted_data_key="wrapped-key",
    )
    db.add(row)
    await db.commit()

    assert await service.list_credentials(db, user_a.id) == []
    assert (await service.get_active_credential(db, user_a.id, "llm")) is None
    assert (await service.get_active_credential(db, user_b.id, "llm")).id == row.id


@pytest.mark.asyncio
async def test_master_key_status_is_scoped_to_user_and_empty_users_are_ready(db, user_a, user_b, monkeypatch):
    monkeypatch.setattr(service, "byok_enabled", lambda: True)
    monkeypatch.setenv("CREDENTIALS_MASTER_KEY", _master("a"))
    db.add(UserProviderCredential(
        user_id=user_b.id,
        provider="test-provider",
        capability="llm",
        encrypted_value="not-a-valid-envelope",
        nonce="nonce",
        encrypted_data_key="wrapped-key",
    ))
    await db.commit()

    assert service.master_key_status_for_credentials(await service.list_credentials(db, user_a.id)) == "ready"
    assert service.master_key_status_for_credentials(await service.list_credentials(db, user_b.id)) == "needs_reconfigure"


def test_master_key_status_does_not_require_key_without_credentials(monkeypatch):
    monkeypatch.delenv("CREDENTIALS_MASTER_KEY", raising=False)
    assert service.master_key_status_for_credentials([]) == "ready"


@pytest.mark.asyncio
async def test_decrypt_failure_does_not_fall_back_to_platform_config(db, user_a, monkeypatch):
    row = SimpleNamespace(
        provider="user-provider", api_format="openai", base_url="", model="user-model",
        vision=False, vision_video=False, vision_audio=False, vision_detail="auto",
    )
    async def active_credential(*_args):
        return row

    monkeypatch.setattr(service, "get_active_credential", active_credential)
    monkeypatch.setattr(service, "decrypt_value", lambda _row: (_ for _ in ()).throw(ValueError("bad envelope")))
    base = SimpleNamespace(provider="platform", api_key="platform-secret", model="platform-model")

    with pytest.raises(ValueError, match="bad envelope"):
        await service.resolve_capability_settings(db, user_a.id, "llm", base)


def test_disabled_policy_blocks_all_byok_entry_points(monkeypatch):
    settings = SimpleNamespace(byok=SimpleNamespace(enabled=False), ai=SimpleNamespace(deployment_mode="hosted"))
    monkeypatch.setattr(policy, "get_settings", lambda: settings)

    assert policy.byok_enabled() is False
    with pytest.raises(PermissionError, match="未开放"):
        policy.require_byok_enabled()


def test_credential_view_contains_metadata_but_not_encrypted_fields():
    row = SimpleNamespace(
        id=1, provider="test-provider", api_format="openai", capability="llm",
        base_url="https://example.test", model="test-model", vision=False,
        vision_video=False, vision_audio=False, vision_detail="auto", enabled=True,
        encrypted_value="ciphertext", last_verified_at=None, created_at=None, updated_at=None,
    )

    view = service.credential_view(row)

    assert view["has_value"] is True
    assert "encrypted_value" not in view
    assert "nonce" not in view
    assert "encrypted_data_key" not in view
