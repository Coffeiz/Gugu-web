"""项目写入底座：原子版本锁与输入边界。"""
from __future__ import annotations

import pytest

from app.core.projects import update_project_atomic
from app.models import Project


async def _make_project(db, user) -> Project:
    project = Project(user_id=user.id, name="原项目", stages_json="[]")
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


@pytest.mark.asyncio
async def test_atomic_project_update_bumps_version(db, user_a):
    project = await _make_project(db, user_a)

    updated = await update_project_atomic(
        db, project.id, user_a.id, project.version, {"name": "新项目", "progress": 30},
    )

    assert updated is True
    await db.commit()
    await db.refresh(project)
    assert project.name == "新项目"
    assert project.progress == 30
    assert project.version == 2


@pytest.mark.asyncio
async def test_atomic_project_update_rejects_stale_version(db, user_a):
    project = await _make_project(db, user_a)

    assert await update_project_atomic(db, project.id, user_a.id, 1, {"name": "先到"}) is True
    assert await update_project_atomic(db, project.id, user_a.id, 1, {"name": "后到"}) is False
    await db.commit()
    await db.refresh(project)
    assert project.name == "先到"
    assert project.version == 2


@pytest.mark.asyncio
async def test_atomic_project_update_cannot_cross_user_boundary(db, user_a, user_b):
    project = await _make_project(db, user_a)

    updated = await update_project_atomic(db, project.id, user_b.id, project.version, {"name": "越权"})

    assert updated is False
    await db.refresh(project)
    assert project.name == "原项目"


@pytest.mark.asyncio
async def test_atomic_project_update_sets_and_clears_done_at(db, user_a):
    project = await _make_project(db, user_a)

    assert await update_project_atomic(db, project.id, user_a.id, 1, {"status": "done"}) is True
    await db.commit()
    await db.refresh(project)
    assert project.done_at is not None

    assert await update_project_atomic(db, project.id, user_a.id, 2, {"status": "active"}) is True
    await db.commit()
    await db.refresh(project)
    assert project.done_at is None


@pytest.mark.asyncio
async def test_atomic_project_update_rejects_invalid_domain_values(db, user_a):
    project = await _make_project(db, user_a)

    with pytest.raises(ValueError, match="项目状态"):
        await update_project_atomic(db, project.id, user_a.id, project.version, {"status": "paused"})
    with pytest.raises(ValueError, match="项目进度"):
        await update_project_atomic(db, project.id, user_a.id, project.version, {"progress": 101})
