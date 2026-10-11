"""交互卡历史清理：trim 对齐裁切（会话保留策略的不对称修复）。

interaction_prompts 此前没有任何清理路径，resolved/expired 卡片永久累积，
list_history 全量渲染挤占会话历史。这里锚定清理语义边界：
已完结（resolved/expired/cancelled）随消息裁切删除，active（待回复确认门）一律保留。
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select
from uuid6 import uuid7

from app.core.tz import now_utc
from app.models import InteractionPrompt, User


def _prompt(user_id, session_id: int, status: str, *, created_at=None,
            expires_in: timedelta = timedelta(hours=1),
            resolved_at=None) -> InteractionPrompt:
    now = now_utc()
    return InteractionPrompt(
        user_id=user_id, session_id=session_id, kind="choice",
        title="t", body="", schema_json={"kind": "choice", "options": []},
        status=status, expires_at=now + expires_in,
        resolved_at=resolved_at if resolved_at is not None else (now if status == "resolved" else None),
        created_at=created_at or now,
    )


@pytest.fixture
async def interaction_user(db):
    u = User(id=uuid7(), username="ixu", email="ixu@test.local", hashed_password="x")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def test_trim_finished_interactions_keeps_active(db, interaction_user):
    from app.services.interactions import trim_finished_interactions

    uid = interaction_user.id
    for status in ("resolved", "expired", "cancelled", "active"):
        db.add(_prompt(uid, 11, status))
    await db.commit()

    removed = await trim_finished_interactions(db, session_id=11)
    await db.commit()

    assert removed == 3
    left = (await db.execute(
        select(InteractionPrompt).where(InteractionPrompt.session_id == 11)
    )).scalars().all()
    assert [p.status for p in left] == ["active"]


async def test_trim_respects_created_before_boundary(db, interaction_user):
    from app.services.interactions import trim_finished_interactions

    uid = interaction_user.id
    old = now_utc() - timedelta(days=30)
    recent = now_utc()
    db.add(_prompt(uid, 12, "resolved", created_at=old))
    db.add(_prompt(uid, 12, "resolved", created_at=recent))
    await db.commit()

    removed = await trim_finished_interactions(db, session_id=12, created_before=recent)
    await db.commit()

    assert removed == 1
    left = (await db.execute(
        select(InteractionPrompt).where(InteractionPrompt.session_id == 12)
    )).scalars().all()
    assert len(left) == 1
    assert left[0].created_at == recent


async def test_trim_scoped_to_session(db, interaction_user):
    """裁切按会话隔离，不误删其它会话的交互卡。"""
    from app.services.interactions import trim_finished_interactions

    uid = interaction_user.id
    db.add(_prompt(uid, 31, "resolved"))
    db.add(_prompt(uid, 32, "resolved"))
    await db.commit()

    await trim_finished_interactions(db, session_id=31)

    left = (await db.execute(
        select(InteractionPrompt).where(InteractionPrompt.session_id == 32)
    )).scalars().all()
    assert len(left) == 1
