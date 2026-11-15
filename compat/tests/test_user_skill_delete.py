"""用户技能删除HTTP handler的合成SQLite对照。"""
import asyncio
from uuid import UUID
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.api.v1.user_skills import delete_skill
from app.models import UserSkill
from app.core import events


def test_user_skill_delete_is_owned_committed_and_notifies_once(monkeypatch):
    published = []

    async def publish(owner, *resources):
        published.append((owner, resources))

    monkeypatch.setattr(events, "publish", publish)

    async def scenario():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        first = UUID("00000000-0000-4000-8000-000000000061")
        second = UUID("00000000-0000-4000-8000-000000000062")
        try:
            async with engine.begin() as connection:
                await connection.run_sync(UserSkill.__table__.create)
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                for owner in [first, second]:
                    db.add(UserSkill(owner_id=owner, skill_id="U1", name="合成技能", description_short="测试", body="合成指导", content_digest="synthetic"))
                await db.commit()
                assert await delete_skill("U1", SimpleNamespace(id=first), db) is None
                assert published == [(first, ("skills",))]
                remaining = (await db.execute(select(UserSkill))).scalars().all()
                assert len(remaining) == 1 and remaining[0].owner_id == second
                with pytest.raises(HTTPException) as error:
                    await delete_skill("U1", SimpleNamespace(id=first), db)
                assert error.value.status_code == 404
                assert error.value.detail == "Skill 不存在"
                assert published == [(first, ("skills",))]
        finally:
            await engine.dispose()
    asyncio.run(scenario())
