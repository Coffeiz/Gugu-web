"""BYOK 草稿试呼：test-preview / models-preview / vision-probe 的目的地绑定 Key 裁决。

旧 Key 只属于它保存时的目的地：草稿 provider 或 endpoint origin（scheme+host+port）
与存量凭据不一致时拒绝复用（2026-09-08），显式新 Key 永远优先；无鉴权自托管
Embedding 直接用空串，不允许把旧云厂商 Key 带到新目的地。
"""
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

import app.api.v1.byok as byok_api


@pytest.fixture(autouse=True)
def _gate_open(monkeypatch):
    monkeypatch.setattr(byok_api, "_gate", lambda: None)


def _db_with(row):
    async def get(_model, pk):
        return row
    return SimpleNamespace(get=get)


def _forbid_decrypt(monkeypatch):
    """旧凭据一旦被解密即测试失败：用于所有「不得复用旧 Key」的场景。"""
    def _boom(row):
        raise AssertionError("目的地已变更，不允许解密旧凭据")
    monkeypatch.setattr(byok_api, "decrypt_value", _boom)


@pytest.mark.asyncio
async def test_missing_key_without_credential_is_rejected():
    body = byok_api.CredentialTestPreview(provider="minimax", capability="llm", value="")
    result = await byok_api.test_credential_preview(body, user=SimpleNamespace(id=uuid4()), db=_db_with(None))
    assert result["ok"] is False
    assert "API Key" in result["message"]


@pytest.mark.asyncio
async def test_draft_provider_change_refuses_stored_key(monkeypatch):
    """旧契约曾把 minimax 的 Key 发给 deepseek 草稿端点（跨服务商泄漏），现必须拒绝。"""
    _forbid_decrypt(monkeypatch)
    row = SimpleNamespace(user_id="owner", provider="minimax", base_url="https://api.minimax.example/v1")
    body = byok_api.CredentialTestPreview(
        provider="deepseek", capability="llm", value="",
        api_format="openai", base_url="https://api.deepseek.example/v1", model="deepseek-v4",
        credential_id=7,
    )
    result = await byok_api.test_credential_preview(body, user=SimpleNamespace(id="owner"), db=_db_with(row))
    assert result["ok"] is False
    assert "重新填写" in result["message"]


@pytest.mark.asyncio
async def test_same_provider_and_origin_reuses_stored_key(monkeypatch):
    captured = {}

    async def fake_probe(provider, api_key, base_url, model, api_format):
        captured.update(provider=provider, api_key=api_key, base_url=base_url, model=model, api_format=api_format)
        return {"ok": True, "status": 200, "detail": ""}

    monkeypatch.setattr("app.services.provider_diagnostics.test_provider_credential", fake_probe)
    monkeypatch.setattr(byok_api, "decrypt_value", lambda row: "sk-stored")
    row = SimpleNamespace(user_id="owner", provider="deepseek", base_url="https://api.deepseek.example/v1")
    body = byok_api.CredentialTestPreview(
        provider="deepseek", capability="llm", value="",
        api_format="openai", base_url="https://api.deepseek.example/v1", model="deepseek-v4.5",
        credential_id=7,
    )
    result = await byok_api.test_credential_preview(body, user=SimpleNamespace(id="owner"), db=_db_with(row))
    assert result["ok"] is True and result["message"] == "模型连接正常"
    assert captured == {"provider": "deepseek", "api_key": "sk-stored",
                        "base_url": "https://api.deepseek.example/v1", "model": "deepseek-v4.5",
                        "api_format": "openai"}


@pytest.mark.asyncio
async def test_same_provider_different_origin_refuses_stored_key(monkeypatch):
    _forbid_decrypt(monkeypatch)
    row = SimpleNamespace(user_id="owner", provider="deepseek", base_url="https://api.deepseek.example/v1")
    body = byok_api.CredentialTestPreview(
        provider="deepseek", capability="llm", value="",
        api_format="openai", base_url="https://mirror.example/v1", model="deepseek-v4",
        credential_id=7,
    )
    result = await byok_api.test_credential_preview(body, user=SimpleNamespace(id="owner"), db=_db_with(row))
    assert result["ok"] is False
    assert "重新填写" in result["message"]


@pytest.mark.asyncio
async def test_keyless_local_embedding_draft_uses_empty_key(monkeypatch):
    """minimax 凭据切到本地无鉴权 embedding：用空串测试，绝不外带旧云厂商 Key。"""
    _forbid_decrypt(monkeypatch)
    captured = {}

    async def fake_embed(*, api_key, base_url, model, dimensions=None):
        captured.update(api_key=api_key, base_url=base_url, model=model)
        return {"ok": True, "status": 200, "message": "Embedding 连接正常"}

    monkeypatch.setattr(byok_api, "_test_embedding_credential", fake_embed)
    row = SimpleNamespace(user_id="owner", provider="minimax", base_url="https://api.minimax.example/v1")
    body = byok_api.CredentialTestPreview(
        provider="local", capability="embedding", value="",
        base_url="http://127.0.0.1:11434/v1", model="bge-m3", credential_id=7,
    )
    result = await byok_api.test_credential_preview(body, user=SimpleNamespace(id="owner"), db=_db_with(row))
    assert result["ok"] is True
    assert captured == {"api_key": "", "base_url": "http://127.0.0.1:11434/v1", "model": "bge-m3"}

    # 未保存过凭据（无 credential_id）时同样允许直接试呼
    body_new = byok_api.CredentialTestPreview(
        provider="local", capability="embedding", value="",
        base_url="http://127.0.0.1:11434/v1", model="bge-m3",
    )
    result_new = await byok_api.test_credential_preview(body_new, user=SimpleNamespace(id="owner"), db=_db_with(None))
    assert result_new["ok"] is True
    assert captured["api_key"] == ""


@pytest.mark.asyncio
async def test_foreign_credential_is_rejected():
    row = SimpleNamespace(user_id="someone-else")
    body = byok_api.CredentialTestPreview(provider="minimax", capability="llm", value="", credential_id=7)
    with pytest.raises(HTTPException) as exc:
        await byok_api.test_credential_preview(body, user=SimpleNamespace(id="me"), db=_db_with(row))
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_embedding_draft_requires_base_url_and_model(monkeypatch):
    monkeypatch.setattr(byok_api, "decrypt_value", lambda row: "sk-stored")
    row = SimpleNamespace(user_id="owner", provider="dashscope", base_url="https://embedding.example/v1")
    body = byok_api.CredentialTestPreview(provider="dashscope", capability="embedding", value="", credential_id=3)
    result = await byok_api.test_credential_preview(body, user=SimpleNamespace(id="owner"), db=_db_with(row))
    assert result["ok"] is False
    assert "Base URL" in result["message"]


@pytest.mark.asyncio
async def test_models_preview_refuses_cross_provider_reuse():
    row = SimpleNamespace(user_id="me", provider="minimax", base_url="https://api.minimax.example/v1")
    body = byok_api.CredentialModelsPreview(provider="deepseek", base_url="https://api.deepseek.example/v1",
                                            api_key="", credential_id=7)
    with pytest.raises(HTTPException) as exc:
        await byok_api.preview_models(body, user=SimpleNamespace(id="me"), db=_db_with(row))
    assert exc.value.status_code == 422
    assert "重新填写" in exc.value.detail


@pytest.mark.asyncio
async def test_models_preview_reuses_key_for_same_destination(monkeypatch):
    captured = {}

    async def fake_fetch(base_url, provider, api_key, api_format):
        captured.update(base_url=base_url, provider=provider, api_key=api_key)
        return ["m1"]

    monkeypatch.setattr("app.api.v1.agent_admin._fetch_provider_models", fake_fetch)
    monkeypatch.setattr(byok_api, "decrypt_value", lambda row: "sk-stored")
    row = SimpleNamespace(user_id="me", provider="deepseek", base_url="https://api.deepseek.example/v1")
    body = byok_api.CredentialModelsPreview(provider="deepseek", base_url="https://api.deepseek.example/v1",
                                            api_key="", credential_id=7)
    result = await byok_api.preview_models(body, user=SimpleNamespace(id="me"), db=_db_with(row))
    assert result == {"models": ["m1"]}
    assert captured["api_key"] == "sk-stored"


@pytest.mark.asyncio
async def test_vision_probe_refuses_cross_provider_reuse():
    row = SimpleNamespace(user_id="me", provider="minimax", base_url="https://api.minimax.example/v1")
    body = byok_api.CredentialVisionProbe(provider="deepseek", base_url="https://api.deepseek.example/v1",
                                          api_key="", credential_id=7, dim="image")
    with pytest.raises(HTTPException) as exc:
        await byok_api.probe_vision(body, user=SimpleNamespace(id="me"), db=_db_with(row))
    assert exc.value.status_code == 422
    assert "重新填写" in exc.value.detail


@pytest.mark.asyncio
async def test_vision_probe_reuses_key_for_same_destination(monkeypatch):
    captured = {}

    async def fake_probe(provider, api_key, base_url, model, api_format, dim):
        captured.update(api_key=api_key, provider=provider, dim=dim)
        return True, 200, "ok"

    monkeypatch.setattr("app.api.v1.agent_admin._do_vision_probe", fake_probe)
    monkeypatch.setattr(byok_api, "decrypt_value", lambda row: "sk-stored")
    row = SimpleNamespace(user_id="me", provider="deepseek", base_url="https://api.deepseek.example/v1")
    body = byok_api.CredentialVisionProbe(provider="deepseek", base_url="https://api.deepseek.example/v1",
                                          api_key="", credential_id=7, dim="image")
    result = await byok_api.probe_vision(body, user=SimpleNamespace(id="me"), db=_db_with(row))
    assert result["supported"] is True
    assert captured["api_key"] == "sk-stored" and captured["dim"] == "image"


def test_url_origin_normalization():
    # 显式 443 端口与默认端口等价；/v1 路径差异不改变身份；scheme 不同则不同
    assert byok_api._url_origin("https://api.x.example:443/v1") == byok_api._url_origin("https://api.x.example/v1")
    assert byok_api._url_origin("http://api.x.example/v1") != byok_api._url_origin("https://api.x.example/v1")
    assert byok_api._url_origin("https://API.X.EXAMPLE/v1") == byok_api._url_origin("https://api.x.example/other")
    assert byok_api._url_origin("") == ("", "", None)
