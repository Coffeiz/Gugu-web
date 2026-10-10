"""项目工具（agent/tools/projects.py）直调测试：CRUD/阶段待办/删除确认门。

P1 治理批次：对应 CRAP-FULL 高危清单 12 个函数。用 conftest 内存库 + 双用户
夹具直接调工具 handler；事件广播 noop，删除走确认门拦截路径（真实删除另见
test_project_trash 的软删链路）。
"""

import json

import pytest

from agent.tools import projects as projects_tools
from app.core.project_colors import PROJECT_COLOR_KEYS
from app.core import events


@pytest.fixture(autouse=True)
def _noop_events(monkeypatch):
    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(events, "publish", _noop)
    if hasattr(events, "bus"):
        monkeypatch.setattr(events.bus, "publish", lambda event: None)


async def _create(db, user_id, name, **overrides):
    args = {"name": name, "deadline": "2026-12-01", "start_date": "2026-11-01"}
    args.update(overrides)
    result = await projects_tools._create_project(db, user_id, args)
    assert result["success"] is True
    return result


async def test_create_project_default_stages_and_priority_normalization(db, user_a):
    result = await _create(db, user_a.id, "官网改版", priority="HIGH")

    assert result["stages"] == ["计划", "执行", "交付"]
    detail = await projects_tools._get_project(db, user_a.id, {"project_id": result["project_id"]})
    assert detail["priority"] == "high"
    assert detail["status"] == "pending"
    assert detail["color"] in PROJECT_COLOR_KEYS  # 未指定颜色时自动挑未用预设（回执为语义色名）


async def test_create_project_custom_stages_and_invalid_priority(db, user_a):
    result = await _create(
        db, user_a.id, "拍摄项目", priority="紧急",
        stages=[{"label": "勘景", "todos": ["约场地"]}, {"label": "拍摄"}],
    )

    assert result["stages"] == ["勘景", "拍摄"]
    detail = await projects_tools._get_project(db, user_a.id, {"project_id": result["project_id"]})
    assert detail["priority"] is None
    # normalize_project_stages 会重编 todo id（t1...），不信任调用方 id
    assert detail["stages"][0]["todos"] == [{"id": "t1", "text": "约场地", "done": False}]


async def test_create_project_rejects_wrapped_stage_without_creating_project(db, user_a):
    result = await projects_tools._create_project(db, user_a.id, {
        "name": "阶段格式回归",
        "deadline": "2026-12-01",
        "start_date": "2026-11-01",
        "stages": [{"item": {"label": "准备", "todos": ["整理需求"]}}],
    })

    assert "error" in json.loads(result)
    assert "阶段格式回归" not in {item["name"] for item in await projects_tools._list_projects(db, user_a.id, {})}


async def test_list_projects_filters_status_and_archived(db, user_a):
    active = await _create(db, user_a.id, "进行中项目")
    done = await _create(db, user_a.id, "已完成项目")
    await projects_tools._update_project(db, user_a.id, {"project_id": done["project_id"], "status": "done"})
    archived = await _create(db, user_a.id, "归档项目")
    await projects_tools._archive_project(db, user_a.id, {"project_id": archived["project_id"]})

    names = {item["name"] for item in await projects_tools._list_projects(db, user_a.id, {})}
    assert {"进行中项目", "已完成项目"} <= names
    assert "归档项目" not in names

    done_only = await projects_tools._list_projects(db, user_a.id, {"status": "done"})
    assert [item["name"] for item in done_only] == ["已完成项目"]

    archived_list = await projects_tools._list_projects(db, user_a.id, {"archived": True})
    assert "归档项目" in {item["name"] for item in archived_list}


async def test_resolve_project_by_id_and_exact_name(db, user_a):
    created = await _create(db, user_a.id, "独一份")

    resolved, err = await projects_tools._resolve_project(db, user_a.id, {"project_id": created["project_id"]})
    assert err is None and resolved.id == created["project_id"]

    by_name, err = await projects_tools._resolve_project(db, user_a.id, {"project": "独一份"})
    assert err is None and by_name.id == created["project_id"]

    _, err = await projects_tools._resolve_project(db, user_a.id, {"project": "不存在的项目"})
    assert err is not None and "error" in err


async def test_update_project_renames_and_normalizes_priority(db, user_a):
    created = await _create(db, user_a.id, "旧名")

    result = await projects_tools._update_project(db, user_a.id, {
        "project_id": created["project_id"], "name": "新名", "priority": "LOW", "client": "某客户",
    })

    assert result["success"] is True
    detail = await projects_tools._get_project(db, user_a.id, {"project_id": created["project_id"]})
    assert detail["name"] == "新名"
    assert detail["priority"] == "low"
    assert detail["client"] == "某客户"


async def test_update_project_done_auto_completes_todos(db, user_a):
    created = await _create(
        db, user_a.id, "收尾项目", status="active",
        stages=[
            {"label": "开发", "todos": ["A", "B"]},
            {"label": "收尾", "todos": []},
        ],
    )
    project_id = created["project_id"]

    result = await projects_tools._update_project(db, user_a.id, {"project_id": project_id, "status": "done"})

    assert result["success"] is True
    detail = await projects_tools._get_project(db, user_a.id, {"project_id": project_id})
    todos = detail["stages"][0]["todos"]
    # 标完成：未完成待办全置 done，current_stage 推到最后一段；
    # autoCompleted/_savedDone 标记持久在 stages JSON，但 _get_project 投影只暴露 {id,text,done}
    assert all(todo["done"] for todo in todos)
    assert detail["current_stage"] == detail["stages"][-1]["key"]
    listed = await projects_tools._list_projects(db, user_a.id, {"status": "done"})
    row = next(item for item in listed if item["id"] == project_id)
    assert row["stages_total"] == 2


async def test_update_project_missing_returns_error(db, user_a):
    result = await projects_tools._update_project(db, user_a.id, {"project_id": 987654, "name": "x"})
    assert "error" in result


async def test_set_color_valid_and_invalid(db, user_a):
    created = await _create(db, user_a.id, "颜色项目")
    pid = created["project_id"]

    preset_name = PROJECT_COLOR_KEYS[0]
    ok = await projects_tools._set_color(db, user_a.id, {"project_id": pid, "color": preset_name})
    assert ok["success"] is True
    assert ok["color"] == preset_name

    bad = await projects_tools._set_color(db, user_a.id, {"project_id": pid, "color": "炫彩"})
    assert "error" in bad


async def test_add_stage_appends_and_inserts_by_position(db, user_a):
    created = await _create(db, user_a.id, "阶段项目")
    pid = created["project_id"]

    appended = await projects_tools._add_stage(db, user_a.id, {"project_id": pid, "label": "复盘"})
    assert appended["stage_key"] == "s3"  # 默认三段后下一个 key

    inserted = await projects_tools._add_stage(db, user_a.id, {"project_id": pid, "label": "立项", "position": 0})
    assert inserted["stage_key"] == "s4"

    detail = await projects_tools._get_project(db, user_a.id, {"project_id": pid})
    assert [stage["label"] for stage in detail["stages"]] == ["立项", "计划", "执行", "交付", "复盘"]


async def test_remove_stage_falls_back_current_stage(db, user_a):
    created = await _create(db, user_a.id, "删阶段项目")
    pid = created["project_id"]
    # 默认 current_stage=s0（计划）；切到执行后删执行 → 回退到剩余第一段
    await projects_tools._update_stage(db, user_a.id, {"project_id": pid, "stage": "执行"})

    result = await projects_tools._remove_stage(db, user_a.id, {"project_id": pid, "stage": "执行"})

    assert result["removed"] == "执行"
    assert result["remaining_stages"] == ["计划", "交付"]
    assert result["current_stage_key"] == "s0"
    assert result["current_stage"] == "计划"
    detail = await projects_tools._get_project(db, user_a.id, {"project_id": pid})
    assert detail["current_stage"] == "s0"  # current_stage 存 key 不存 label

    missing = json.loads(await projects_tools._remove_stage(db, user_a.id, {"project_id": pid, "stage": "不存在"}))
    assert "阶段不存在" in missing["error"]


async def test_remove_stage_rejects_removing_last_stage(db, user_a):
    created = await _create(db, user_a.id, "单阶段项目", stages=[{"label": "准备"}])

    result = json.loads(await projects_tools._remove_stage(
        db, user_a.id, {"project_id": created["project_id"], "stage": "准备"},
    ))

    assert "最后一个阶段" in result["error"]
    detail = await projects_tools._get_project(db, user_a.id, {"project_id": created["project_id"]})
    assert [stage["label"] for stage in detail["stages"]] == ["准备"]


async def test_rename_stage(db, user_a):
    created = await _create(db, user_a.id, "改名项目")
    result = await projects_tools._rename_stage(
        db, user_a.id, {"project_id": created["project_id"], "stage": "计划", "new_label": "策划"})
    assert result["label"] == "策划"
    detail = await projects_tools._get_project(db, user_a.id, {"project_id": created["project_id"]})
    assert detail["stages"][0]["label"] == "策划"


async def test_rename_stage_requires_key_when_labels_are_ambiguous(db, user_a):
    created = await _create(db, user_a.id, "重名阶段项目", stages=[
        {"label": "阶段A"}, {"label": "阶段A", "todos": ["专属待办"]},
    ])

    ambiguous = json.loads(await projects_tools._rename_stage(db, user_a.id, {
        "project_id": created["project_id"], "stage": "阶段A", "new_label": "准备",
    }))
    renamed = await projects_tools._rename_stage(db, user_a.id, {
        "project_id": created["project_id"], "stage": "s1", "new_label": "准备",
    })

    detail = await projects_tools._get_project(db, user_a.id, {"project_id": created["project_id"]})
    assert "重名" in ambiguous["error"]
    assert renamed["label"] == "准备"
    assert [stage["label"] for stage in detail["stages"]] == ["阶段A", "准备"]
    assert detail["stages"][1]["todos"][0]["text"] == "专属待办"


async def test_set_stages_replaces_whole_list(db, user_a):
    created = await _create(db, user_a.id, "重排项目")
    pid = created["project_id"]

    result = await projects_tools._set_stages(
        db, user_a.id, {"project_id": pid, "stages": [
            {"label": "设计"}, {"label": "开发"}, {"label": "测试"}, {"label": "上线"},
        ]})

    assert result["stages"] == ["设计", "开发", "测试", "上线"]
    detail = await projects_tools._get_project(db, user_a.id, {"project_id": pid})
    assert [stage["label"] for stage in detail["stages"]] == result["stages"]


async def test_set_stages_reorder_preserves_keys_and_current_stage(db, user_a):
    created = await _create(db, user_a.id, "保留阶段身份项目", stages=[
        {"label": "准备"}, {"label": "开发"},
    ])
    await projects_tools._update_stage(db, user_a.id, {
        "project_id": created["project_id"], "stage": "s1",
    })

    result = await projects_tools._set_stages(db, user_a.id, {
        "project_id": created["project_id"],
        "stages": [{"key": "s1", "label": "开发"}, {"key": "s0", "label": "准备"}],
    })

    detail = await projects_tools._get_project(db, user_a.id, {"project_id": created["project_id"]})
    assert result["success"] is True
    assert [(stage["key"], stage["label"]) for stage in detail["stages"]] == [
        ("s1", "开发"), ("s0", "准备"),
    ]
    assert detail["current_stage"] == "s1"


async def test_update_stage_without_stage_searches_across_project(db, user_a):
    created = await _create(db, user_a.id, "全局待办定位项目", stages=[
        {"label": "准备"}, {"label": "发布", "todos": ["回归检查"]},
    ])

    result = await projects_tools._update_stage(db, user_a.id, {
        "project_id": created["project_id"],
        "todos": [{"text": "回归检查", "done": True}],
    })

    detail = await projects_tools._get_project(db, user_a.id, {"project_id": created["project_id"]})
    assert result["success"] is True
    assert result["results"][0]["stage"] == "发布"
    assert detail["stages"][1]["todos"][0]["done"] is True


async def test_update_stage_requires_scope_for_ambiguous_todo_match(db, user_a):
    created = await _create(db, user_a.id, "重复待办定位项目", stages=[
        {"label": "准备", "todos": ["检查资料"]},
        {"label": "发布", "todos": ["检查资料"]},
    ])

    result = json.loads(await projects_tools._update_stage(db, user_a.id, {
        "project_id": created["project_id"],
        "todos": [{"text": "检查资料", "done": True}],
    }))

    assert "success" not in result
    assert "多项" in result["results"][0]["error"]
    assert len(result["results"][0]["candidates"]) == 2


async def test_set_stages_rejects_wrapped_payload_without_changing_project(db, user_a):
    created = await _create(db, user_a.id, "无效重排项目")
    before = await projects_tools._get_project(db, user_a.id, {"project_id": created["project_id"]})

    result = json.loads(await projects_tools._set_stages(db, user_a.id, {
        "project_id": created["project_id"],
        "stages": {"item": [{"label": "准备"}, {"label": "执行"}]},
    }))

    after = await projects_tools._get_project(db, user_a.id, {"project_id": created["project_id"]})
    assert "error" in result
    assert after["stages"] == before["stages"]


async def test_update_stage_rejects_malformed_batch_before_mutating(db, user_a):
    created = await _create(
        db, user_a.id, "待办批量项目", stages=[{"label": "准备", "todos": ["已有待办"]}],
    )
    before = await projects_tools._get_project(db, user_a.id, {"project_id": created["project_id"]})

    result = json.loads(await projects_tools._update_stage(db, user_a.id, {
        "project_id": created["project_id"],
        "todos": [{"text": "已有待办", "done": True}, {"item": "格式错误"}],
    }))

    after = await projects_tools._get_project(db, user_a.id, {"project_id": created["project_id"]})
    assert "error" in result
    assert after["stages"] == before["stages"]


async def test_delete_project_requires_confirmation_before_trash(db, user_a, tmp_path, monkeypatch):
    created = await _create(db, user_a.id, "待删项目")
    from app.services.storage import LocalStorageBackend
    monkeypatch.setattr(projects_tools, "get_storage", lambda: LocalStorageBackend(tmp_path))

    result = await projects_tools._delete_project(db, user_a.id, {"project_id": created["project_id"]})

    # 破坏性操作：未带确认凭证时必须被确认门拦截，而不是直接删除
    assert "success" not in result

    invalid = json.loads(await projects_tools._delete_project(db, user_a.id, {"project_ids": []}))
    assert "project_ids" in invalid["error"]
