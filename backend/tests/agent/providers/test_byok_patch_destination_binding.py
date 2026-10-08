"""BYOK PATCH 保存的目的地绑定：旧 Key 不得随 provider/base_url 变更静默带到新目的地。

与 resolve_preview_key（草稿试呼）同一安全边界：保存链路曾经只检查「旧 Key 是否为空」，
不检查原目的地与新目的地是否一致——deepseek + 代理 endpoint、minimax Key 绑到
deepseek 配置都能静默发生。修法：留空保持不变仅限同 provider 且 effective origin
一致；目的地变更必须重新输入 Key；校验全部通过才落字段（失败请求零副作用）。
"""
import pytest
from fastapi import HTTPException

import app.byok.service as service
from app.models import UserProviderCredential

from sqlalchemy import select

_MASTER = "patch-binding-master"


async def _make_credential(db, user_a, monkeypatch, *, provider="deepseek", base_url="https://api.deepseek.com/v1",
                           key="sk-deepseek-secret", capability="llm", model="deepseek-v4"):
    monkeypatch.setattr("app.api.v1.byok.require_byok_enabled", lambda: None)
    monkeypatch.setattr(service, "byok_enabled", lambda: True)
    monkeypatch.setenv("CREDENTIALS_MASTER_KEY", _MASTER)
    from app.api.v1.byok import create_credential
    from app.byok.schemas import CredentialCreate

    return await create_credential(
        CredentialCreate(provider=provider, capability=capability, value=key,
                         base_url=base_url, model=model),
        user=user_a, db=db)


async def _reload_row(db, user_a, credential_id):
    result = await db.execute(select(UserProviderCredential).where(
        UserProviderCredential.id == credential_id))
    return result.scalars().one()


@pytest.mark.asyncio
async def test_patch_provider_change_without_key_rejected_and_row_untouched(db, user_a, monkeypatch):
    """cloud A → cloud B（minimax Key 绑到 deepseek）：422 且 row 完全不变。"""
    from app.api.v1.byok import patch_credential
    from app.byok.schemas import CredentialPatch

    created = await _make_credential(db, user_a, monkeypatch, provider="minimax",
                                     base_url="https://api.minimaxi.com/anthropic", key="sk-minimax-secret")
    with pytest.raises(HTTPException) as exc_info:
        await patch_credential(
            created["id"],
            CredentialPatch(provider="deepseek", base_url="https://api.deepseek.com/v1"),
            user=user_a, db=db)
    assert exc_info.value.status_code == 422

    row = await _reload_row(db, user_a, created["id"])
    assert row.provider == "minimax"
    assert row.base_url == "https://api.minimaxi.com/anthropic"
    assert service.decrypt_value(row) == "sk-minimax-secret"


@pytest.mark.asyncio
async def test_patch_same_provider_new_origin_without_key_rejected(db, user_a, monkeypatch):
    """同 provider → 自建代理 endpoint，Key 留空：422，旧 Key 不发给代理。"""
    from app.api.v1.byok import patch_credential
    from app.byok.schemas import CredentialPatch

    created = await _make_credential(db, user_a, monkeypatch)
    with pytest.raises(HTTPException) as exc_info:
        await patch_credential(
            created["id"],
            CredentialPatch(base_url="https://my-proxy.example/v1"),
            user=user_a, db=db)
    assert exc_info.value.status_code == 422

    row = await _reload_row(db, user_a, created["id"])
    assert row.base_url == "https://api.deepseek.com/v1"
    assert service.decrypt_value(row) == "sk-deepseek-secret"


@pytest.mark.asyncio
async def test_patch_custom_endpoint_back_to_default_without_key_rejected(db, user_a, monkeypatch):
    """custom endpoint → 清空 Base URL（落 provider 默认端点）：目的地同样视为变更。"""
    from app.api.v1.byok import patch_credential
    from app.byok.schemas import CredentialPatch

    created = await _make_credential(db, user_a, monkeypatch, base_url="https://my-proxy.example/v1")
    with pytest.raises(HTTPException) as exc_info:
        await patch_credential(created["id"], CredentialPatch(base_url=""), user=user_a, db=db)
    assert exc_info.value.status_code == 422

    row = await _reload_row(db, user_a, created["id"])
    assert row.base_url == "https://my-proxy.example/v1"


@pytest.mark.asyncio
async def test_patch_same_destination_model_only_keeps_old_key(db, user_a, monkeypatch):
    """同 provider + 同 effective origin，只改模型：成功，旧 Key 原样保留。"""
    from app.api.v1.byok import patch_credential
    from app.byok.schemas import CredentialPatch

    created = await _make_credential(db, user_a, monkeypatch)
    patched = await patch_credential(
        created["id"],
        CredentialPatch(model="deepseek-v4-pro"),
        user=user_a, db=db)
    assert patched["model"] == "deepseek-v4-pro"

    row = await _reload_row(db, user_a, created["id"])
    assert service.decrypt_value(row) == "sk-deepseek-secret"


@pytest.mark.asyncio
async def test_patch_provider_change_with_explicit_new_key_succeeds(db, user_a, monkeypatch):
    """provider/origin 变更 + 显式新 Key：成功，新 Key 生效。"""
    from app.api.v1.byok import patch_credential
    from app.byok.schemas import CredentialPatch

    created = await _make_credential(db, user_a, monkeypatch, provider="minimax",
                                     base_url="https://api.minimaxi.com/anthropic", key="sk-minimax-secret")
    patched = await patch_credential(
        created["id"],
        CredentialPatch(provider="deepseek", base_url="https://api.deepseek.com/v1", value="sk-deepseek-new"),
        user=user_a, db=db)
    assert patched["provider"] == "deepseek"

    row = await _reload_row(db, user_a, created["id"])
    assert service.decrypt_value(row) == "sk-deepseek-new"


@pytest.mark.asyncio
async def test_patch_cloud_to_keyless_local_with_empty_value_clears_key(db, user_a, monkeypatch):
    """云端 → 无鉴权本地（显式 value=""）：成功，旧 Key 被清掉（迁移闭环）。"""
    from app.api.v1.byok import patch_credential
    from app.byok.schemas import CredentialPatch

    created = await _make_credential(db, user_a, monkeypatch, capability="embedding",
                                     base_url="https://api.openai.com/v1",
                                     key="sk-openai-secret", model="text-embedding-3-small")
    patched = await patch_credential(
        created["id"],
        CredentialPatch(provider="local", base_url="http://127.0.0.1:8080/v1", value=""),
        user=user_a, db=db)
    assert patched["provider"] == "local"

    row = await _reload_row(db, user_a, created["id"])
    assert service.decrypt_value(row) == ""
