"""PRD-SEC-1 Phase 4：用户 BYOK 安全边界回归。"""

from types import SimpleNamespace
import pytest
from fastapi import HTTPException

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
    assert "dimensions" in view
    assert "encrypted_value" not in view
    assert "nonce" not in view
    assert "encrypted_data_key" not in view


@pytest.mark.asyncio
async def test_credential_view_returns_dimensions_and_patch_preserves_it(db, user_a, monkeypatch):
    """回归：credential_view 曾漏返 dimensions，编辑器拿到的存量凭据维度是 null，
    前端保存时固定发 dimensions:0——哪怕只改 Base URL 也会把已存维度清零（静默
    数据损坏）。create→GET→只 patch base_url 后，维度必须原样保留。"""
    monkeypatch.setattr("app.api.v1.byok.require_byok_enabled", lambda: None)
    monkeypatch.setenv("CREDENTIALS_MASTER_KEY", _master("dims"))
    from app.api.v1.byok import create_credential, get_credentials, patch_credential
    from app.byok.schemas import CredentialCreate, CredentialPatch

    created = await create_credential(
        CredentialCreate(provider="qwen", capability="embedding", value="sk-test-dims",
                         model="text-embedding-v4", dimensions=1024),
        user=user_a, db=db)
    assert created["dimensions"] == 1024

    listed = await get_credentials(user=user_a, db=db)
    assert [item["dimensions"] for item in listed["items"]] == [1024]

    patched = await patch_credential(
        created["id"],
        # 目的地绑定：base_url 变更属于新目的地，必须显式重新提供 Key 才允许保存。
        CredentialPatch(base_url="https://dashscope.example.com/compatible-mode/v1",
                        value="sk-test-dims"),
        user=user_a, db=db)
    assert patched["dimensions"] == 1024


@pytest.mark.asyncio
async def test_keyless_selfhosted_embedding_create_then_resolve_empty_key(db, user_a, monkeypatch):
    """回归：自托管 Embedding 空 Key 创建曾在 encrypt_envelope 里 ValueError
    未被捕获而 500。空 Key 必须能信封加密落库（allow_empty 显式语义，不落明文），
    resolve_embedding_settings 解析出 api_key 为空串；Ollama Cloud 与普通云
    provider 的空 Key 返回 422 业务错误而不是 500。"""
    monkeypatch.setattr("app.api.v1.byok.require_byok_enabled", lambda: None)
    monkeypatch.setattr(service, "byok_enabled", lambda: True)
    monkeypatch.setenv("CREDENTIALS_MASTER_KEY", _master("dims"))
    from app.api.v1.byok import create_credential
    from app.byok.schemas import CredentialCreate

    created = await create_credential(
        CredentialCreate(provider="ollama", capability="embedding", value="",
                         base_url="http://127.0.0.1:11434/v1", model="nomic-embed-text"),
        user=user_a, db=db)
    assert created["has_value"] is True  # 空串也走信封加密落库

    base = SimpleNamespace(api_key="platform-key", base_url="https://platform.example", model="platform-bge")
    resolved = await service.resolve_embedding_settings(db, user_a.id, base)
    assert resolved is not None
    assert resolved["api_key"] == ""
    assert resolved["provider"] == "ollama"
    assert resolved["base_url"] == "http://127.0.0.1:11434/v1"

    for body in (
        # Ollama Cloud 需要 Key
        CredentialCreate(provider="ollama", capability="embedding", value="",
                         base_url="https://ollama.com/v1", model="nomic-embed-text"),
        # 普通云 provider 需要 Key
        CredentialCreate(provider="openai", capability="embedding", value="",
                         model="text-embedding-3-small"),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await create_credential(body, user=user_a, db=db)
        assert exc_info.value.status_code == 422


@pytest.mark.asyncio
async def test_patch_switch_to_local_clears_old_cloud_key(db, user_a, monkeypatch):
    """回归：云端 Embedding 切换成本地无鉴权服务时，旧 Key 曾因「编辑不回显 +
    falsy 不进 PATCH」留在 row 上，embed() 会拿它给新 endpoint 发 Authorization
    （跨 Provider 凭据泄漏）。显式 PATCH value="" 必须把旧 Key 清掉。"""
    monkeypatch.setattr("app.api.v1.byok.require_byok_enabled", lambda: None)
    monkeypatch.setattr(service, "byok_enabled", lambda: True)
    monkeypatch.setenv("CREDENTIALS_MASTER_KEY", _master("dims"))
    from app.api.v1.byok import create_credential, patch_credential
    from app.byok.schemas import CredentialCreate, CredentialPatch

    created = await create_credential(
        CredentialCreate(provider="openai", capability="embedding", value="sk-openai-secret",
                         base_url="https://api.openai.com/v1", model="text-embedding-3-small"),
        user=user_a, db=db)
    patched = await patch_credential(
        created["id"],
        CredentialPatch(provider="local", base_url="http://127.0.0.1:8080/v1", value=""),
        user=user_a, db=db)
    assert patched["provider"] == "local"

    base = SimpleNamespace(api_key="platform-key", base_url="https://platform.example", model="platform-bge")
    resolved = await service.resolve_embedding_settings(db, user_a.id, base)
    assert resolved is not None
    assert resolved["api_key"] == ""  # 旧云端 Key 已清掉，不再发给本地 endpoint


@pytest.mark.asyncio
async def test_patch_switch_to_cloud_provider_requires_new_key(db, user_a, monkeypatch):
    """回归：本地空 Key 切到云端 Provider 且未提供新 Key 时，曾会保存出
    「云端 Provider + 空 Key」的必然失败配置；后端按最终配置一致性拒绝（422）。"""
    monkeypatch.setattr("app.api.v1.byok.require_byok_enabled", lambda: None)
    monkeypatch.setattr(service, "byok_enabled", lambda: True)
    monkeypatch.setenv("CREDENTIALS_MASTER_KEY", _master("dims"))
    from app.api.v1.byok import create_credential, patch_credential
    from app.byok.schemas import CredentialCreate, CredentialPatch

    created = await create_credential(
        CredentialCreate(provider="local", capability="embedding", value="",
                         base_url="http://127.0.0.1:8080/v1", model="bge-m3"),
        user=user_a, db=db)
    with pytest.raises(HTTPException) as exc_info:
        await patch_credential(
            created["id"],
            CredentialPatch(provider="openai", base_url="https://api.openai.com/v1"),
            user=user_a, db=db)
    assert exc_info.value.status_code == 422
