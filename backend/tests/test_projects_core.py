"""项目写入底座：原子版本锁与输入边界。"""
from __future__ import annotations

import pytest

from app.core.projects import (
    build_project, find_project_stage, normalize_project_stages, normalize_project_stages_for_read, prepare_project_update,
    replace_project_stages, update_project_atomic,
)
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


def test_project_fields_reject_invalid_dates_and_stage_structure():
    with pytest.raises(ValueError, match="开始日期不能晚于截止日期"):
        prepare_project_update({"start_date": "2026-07-15", "deadline": "2026-07-14"})
    with pytest.raises(ValueError, match="阶段 key 不能重复"):
        prepare_project_update({
            "stages": [
                {"key": "s0", "label": "计划", "todos": []},
                {"key": "s0", "label": "执行", "todos": []},
            ],
        })
    with pytest.raises(ValueError, match="当前阶段必须属于阶段列表"):
        prepare_project_update({
            "stages": [{"key": "s0", "label": "计划", "todos": []}],
            "current_stage": "missing",
        })


def test_build_project_applies_shared_create_validation(user_a):
    project = build_project(user_a.id, {
        "name": "新项目",
        "status": "pending",
        "stages": [{"key": "s0", "label": "计划", "todos": []}],
        "current_stage": "s0",
    })

    assert project.name == "新项目"
    assert project.stages[0]["key"] == "s0"


def test_normalize_project_stages_builds_stable_stage_and_todo_ids():
    stages = normalize_project_stages(["计划", {"label": "执行", "todos": ["写接口", {"text": "验收", "done": True}]}])

    assert stages == [
        {"key": "s0", "label": "计划", "todos": []},
        {"key": "s1", "label": "执行", "todos": [
            {"id": "t1", "text": "写接口", "done": False},
            {"id": "t2", "text": "验收", "done": True},
        ]},
    ]


def test_normalize_project_stages_for_read_fills_legacy_missing_todos_without_mutating_stage_identity():
    stages = normalize_project_stages_for_read([
        {"key": "s0", "label": "计划"},
        {"key": "s1", "label": "执行", "todos": [
            {"id": "t1", "text": "开发", "done": True},
            {"id": "t2", "text": "", "done": False},
        ]},
    ])

    assert stages == [
        {"key": "s0", "label": "计划", "todos": []},
        {"key": "s1", "label": "执行", "todos": [
            {"id": "t1", "text": "开发", "done": True},
            {"id": "t2", "text": "", "done": False},
        ]},
    ]


def test_replace_project_stages_preserves_implicit_same_name_todos():
    old_stages = [{"key": "s0", "label": "计划", "todos": [{"id": "t1", "text": "梳理需求", "done": True}]}]

    stages, current_stage = replace_project_stages(old_stages, "s0", ["计划", "交付"])

    assert current_stage == "s0"
    assert stages[0]["todos"] == [{"id": "t1", "text": "梳理需求", "done": True}]
    assert find_project_stage(stages, "交付") == stages[1]
