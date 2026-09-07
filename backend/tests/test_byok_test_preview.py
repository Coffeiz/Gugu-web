"""BYOK test-preview：编辑草稿不落库试呼（Key 缺省回源已存凭据、llm/speech 连通性）。"""
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


@pytest.mark.asyncio
async def test_missing_key_without_credential_is_rejected():
    body = byok_api.CredentialTestPreview(provider="minimax", capability="llm", value="")
    result = await byok_api.test_credential_preview(body, user=SimpleNamespace(id=uuid4()), db=_db_with(None))
    assert result["ok"] is False
    assert "API Key" in result["message"]


@pytest.mark.asyncio
async def test_llm_draft_uses_form_target_and_stored_key(monkeypatch):
    captured = {}

    async def fake_probe(provider, api_key, base_url, model, api_format):
        captured.update(provider=provider, api_key=api_key, base_url=base_url, model=model, api_format=api_format)
        return {"ok": True, "status": 200, "detail": ""}

    monkeypatch.setattr("app.services.provider_diagnostics.test_provider_credential", fake_probe)
    monkeypatch.setattr(byok_api, "decrypt_value", lambda row: "sk-stored")

    row = SimpleNamespace(user_id="owner", provider="minimax")
    body = byok_api.CredentialTestPreview(
        provider="deepseek", capability="llm", value="",
        api_format="openai", base_url="https://api.deepseek.example/v1", model="deepseek-v4",
        credential_id=7,
    )
    result = await byok_api.test_credential_preview(body, user=SimpleNamespace(id="owner"), db=_db_with(row))

    assert result["ok"] is True and result["message"] == "模型连接正常"
    assert captured == {"provider": "deepseek", "api_key": "sk-stored",
                        "base_url": "https://api.deepseek.example/v1", "model": "deepseek-v4",
                        "api_format": "openai"}


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
    row = SimpleNamespace(user_id="owner")
    body = byok_api.CredentialTestPreview(provider="dashscope", capability="embedding", value="", credential_id=3)
    result = await byok_api.test_credential_preview(body, user=SimpleNamespace(id="owner"), db=_db_with(row))
    assert result["ok"] is False
    assert "Base URL" in result["message"]
