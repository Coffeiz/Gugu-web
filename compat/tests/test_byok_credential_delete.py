"""BYOK删除真实Python handler的独立SQLite对照，不使用真实凭据。"""
import asyncio
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.api.v1 import byok
from app.models import UserProviderCredential
from app.services import provider_reasoning_state


def test_byok_delete_checks_gate_owner_and_invalidates_only_llm(monkeypatch):
    enabled = False
    invalidated = []

    def gate():
        if not enabled:
            raise PermissionError("用户 BYOK 未开放")

    async def invalidate(db, *, user_id):
        invalidated.append(user_id)

    monkeypatch.setattr(byok, "require_byok_enabled", gate)
    monkeypatch.setattr(provider_reasoning_state, "invalidate_user_states", invalidate)

    async def scenario():
        nonlocal enabled
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        owner = UUID("00000000-0000-4000-8000-000000000071")
        foreign = UUID("00000000-0000-4000-8000-000000000072")
        try:
            async with engine.begin() as connection:
                await connection.run_sync(UserProviderCredential.__table__.create)
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                for key, user, capability in [(1, owner, "llm"), (2, foreign, "llm"), (3, owner, "embedding")]:
                    db.add(UserProviderCredential(id=key, user_id=user, provider="synthetic", capability=capability, encrypted_value="synthetic", nonce="synthetic", encrypted_data_key="synthetic"))
                await db.commit()
                with pytest.raises(HTTPException) as error:
                    await byok.delete_credential(1, SimpleNamespace(id=owner), db)
                assert error.value.status_code == 403
                enabled = True
                with pytest.raises(HTTPException) as error:
                    await byok.delete_credential(2, SimpleNamespace(id=owner), db)
                assert error.value.status_code == 404
                assert await byok.delete_credential(3, SimpleNamespace(id=owner), db) is None
                assert invalidated == []
                assert await byok.delete_credential(1, SimpleNamespace(id=owner), db) is None
                assert invalidated == [owner]
                rows = (await db.execute(select(UserProviderCredential))).scalars().all()
                assert len(rows) == 1 and rows[0].user_id == foreign
        finally:
            await engine.dispose()
    asyncio.run(scenario())
