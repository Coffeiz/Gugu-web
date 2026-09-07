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


def _tool_res(result):
    """handler 可能返回 dict 或 JSON 字符串，统一成 dict。"""
    import json as _json
    return _json.loads(result) if isinstance(result, str) else result


def _as_stages(raw):
    """stages_json 列在 refresh 后可能已是 list/dict，统一兜一层。"""
    import json as _json
    return raw if isinstance(raw, (list, dict)) else _json.loads(raw)


async def _make_staged_project(db, user) -> Project:
    project = Project(
        user_id=user.id, name="视频项目", stages_json='[{"key":"s0","label":"准备","todos":[{"id":"t1","text":"写稿","done":false},{"id":"t2","text":"录屏","done":false}]},{"key":"s1","label":"后期","todos":[]}]',
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


async def test_update_stage_batch_completes_whole_stage(db, user_a):
    """一次把某阶段全部待办勾完——旧 update_todo 一条条勾的痛点。"""
    from agent.tools.projects import _update_stage
    import json as _json

    project = await _make_staged_project(db, user_a)
    res = _tool_res(await _update_stage(db, user_a.id, {
        "project_id": project.id,
        "todos": [{"text": "写稿", "done": True}, {"text": "录屏", "done": True}],
        "stage": "s0",
    }))
    assert res["success"] is True
    await db.commit()
    await db.refresh(project)
    stages = _as_stages(project.stages_json)
    assert all(t["done"] for t in stages[0]["todos"])


async def test_update_stage_mixed_ops_and_add(db, user_a):
    from agent.tools.projects import _update_stage
    import json as _json

    project = await _make_staged_project(db, user_a)
    res = _tool_res(await _update_stage(db, user_a.id, {
        "project_id": project.id,
        "stage": "s0",
        "add": ["配音"],
        "todos": [
            {"text": "录屏", "new_text": "录屏剪辑", "to_stage": "s1"},
            {"text": "写稿", "done": True},
        ],
    }))
    assert res["success"] is True
    await db.commit()
    await db.refresh(project)
    s0, s1 = _as_stages(project.stages_json)
    assert [t["text"] for t in s0["todos"]] == ["写稿", "配音"] and s0["todos"][0]["done"] is True
    assert [t["text"] for t in s1["todos"]] == ["录屏剪辑"]


async def test_update_stage_only_stage_switches_pointer(db, user_a):
    from agent.tools.projects import _update_stage
    import json as _json

    project = await _make_staged_project(db, user_a)
    res = _tool_res(await _update_stage(db, user_a.id, {"project_id": project.id, "stage": "s1"}))
    assert res["success"] is True and res["current_stage"] == "s1"
    await db.commit()
    await db.refresh(project)
    assert project.current_stage == "s1"


async def test_update_stage_rejects_noop_and_missing_text(db, user_a):
    from agent.tools.projects import _update_stage
    import json as _json

    project = await _make_staged_project(db, user_a)
    noop = _tool_res(await _update_stage(db, user_a.id, {"project_id": project.id}))
    assert "error" in noop
    no_text = _tool_res(await _update_stage(db, user_a.id, {
        "project_id": project.id, "todos": [{"done": True}],
    }))
    assert "error" in no_text
    missing = _tool_res(await _update_stage(db, user_a.id, {
        "project_id": project.id, "todos": [{"text": "不存在的待办", "done": True}],
    }))
    assert "error" in missing


@pytest.mark.asyncio
async def test_update_stage_failed_item_has_zero_side_effects(db, user_a):
    """回归：批量里某条 to_stage 不存在时，旧实现会先改内存对象（new_text/done）
    再校验目标阶段；同批成功项令 changed=True 后整份 stages 照常提交，失败项的
    改名/勾选也被静默保存。失败项必须零副作用，成功项正常生效。"""
    from agent.tools.projects import _update_stage

    project = await _make_staged_project(db, user_a)
    res = _tool_res(await _update_stage(db, user_a.id, {
        "project_id": project.id,
        "stage": "s0",
        "todos": [
            {"text": "写稿", "new_text": "写稿改", "done": True, "to_stage": "不存在的阶段"},
            {"text": "录屏", "done": True},
        ],
    }))
    assert res["success"] is True  # 成功项让整批照常提交——这正是旧实现漏数据的场景
    failed = next(r for r in res["results"] if r.get("todo") == "写稿")
    assert "目标阶段不存在" in failed["error"]
    await db.commit()
    await db.refresh(project)
    s0, s1 = _as_stages(project.stages_json)
    assert [t["text"] for t in s0["todos"]] == ["写稿", "录屏"]  # 没被改名、没被移走
    assert next(t for t in s0["todos"] if t["text"] == "写稿")["done"] is False  # 没被勾选
    assert next(t for t in s0["todos"] if t["text"] == "录屏")["done"] is True  # 成功项生效
    assert [t["text"] for t in s1["todos"]] == []  # 失败项没有被移动到目标阶段
