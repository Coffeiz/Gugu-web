"""项目领域技能：list_projects / create_project / update_project。

逻辑迁自原 agent.py 的 `_exec_tool`，并统一经项目领域写入入口执行。
"""
import json
import random

from app.core.project_colors import (
    PROJECT_COLOR_KEYS,
    PROJECT_COLOR_PRESETS,
    project_color_key,
    project_color_value,
)
from app.core.projects import (
    build_project, next_project_stage_key, next_project_todo_number,
    normalize_project_stages, replace_project_stages, update_project_atomic,
)
from app.core.tz import now_utc
from app.services.projects import (
    add_project,
    count_project_files,
    find_project_rows,
    get_user_project,
    list_active_project_names,
    list_agent_projects,
    project_colors,
    soft_delete_project_full,
)
from app.services.project_context import load_project_file_overviews, project_context_metadata
from app.services.storage import get_storage

from app.core import events
from agent.security import confirm
from agent.tools.base import BaseSkill, Tool


async def _list_projects(db, user_id, args: dict):
    projects = await list_agent_projects(
        db, user_id, archived=bool(args.get("archived", False)))
    if args.get("status"):
        projects = [p for p in projects if p.status == args["status"]]
    return [
        {
            "id": p.id,
            "name": p.name,
            "status": p.status,
            "color": project_color_key(p.color),  # 模型使用语义色名，CSS 渐变不出现在工具回执中
            "deadline": p.deadline,
            "start_date": p.start_date,
            "client": p.client,
            "stages_done": sum(1 for s in p.stages if s.get("done")),
            "stages_total": len(p.stages),
        }
        for p in projects
    ]


async def _update_project(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    fields = {}
    if "status" in args:
        if args["status"] == "done" and p.done_at is None:
            # 与前端「手拖到已完成」一致：标完成 = 整项收尾——自动勾选所有阶段的全部待办、
            # 当前阶段推到最后、进度置 100。未完成的待办打 autoCompleted + 快照原状态，
            # 之后从「已完成」退回时前端按此还原（同 GuguChat moveProject 约定）。
            stages = p.stages
            for s in stages:
                s["todos"] = [
                    t if t.get("done")
                    else {**t, "_savedDone": False, "done": True, "autoCompleted": True}
                    for t in (s.get("todos") or [])
                ]
            fields["stages"] = stages
            if stages:
                fields["current_stage"] = stages[-1].get("key")
            fields["progress"] = 100
        fields["status"] = args["status"]
    if "priority" in args:
        pr = (args.get("priority") or "").strip().lower()
        fields["priority"] = pr if pr in ("high", "medium", "low") else None
    for field in ("deadline", "start_date", "client", "name"):
        if field in args:
            fields[field] = args[field]
    if "summary" in args:
        fields["summary"] = args["summary"]
    error = await _commit_project_intent(db, p, user_id, fields)
    if error:
        return error
    return {"success": True, "project_id": p.id, "name": p.name, "priority": p.priority}


_DEFAULT_STAGES = [
    {"key": "s0", "label": "计划", "todos": []},
    {"key": "s1", "label": "执行", "todos": []},
    {"key": "s2", "label": "交付", "todos": []},
]
_STAGES_INPUT_SCHEMA = {
    "type": "array",
    "minItems": 1,
    "items": {
        "type": ["string", "object"],
        "minLength": 1,
        "properties": {
            "label": {"type": "string", "minLength": 1},
            "todos": {
                "type": "array",
                "items": {"type": "string", "minLength": 1},
            },
        },
        "required": ["label"],
        "additionalProperties": False,
    },
}
_SET_STAGES_INPUT_SCHEMA = {
    **_STAGES_INPUT_SCHEMA,
    "items": {
        **_STAGES_INPUT_SCHEMA["items"],
        "properties": {
            "key": {"type": "string", "minLength": 1},
            **_STAGES_INPUT_SCHEMA["items"]["properties"],
        },
    },
}


async def _pick_unused_color(db, user_id) -> str:
    rows = await project_colors(db, user_id)
    used = set(rows)
    unused = [c for c in PROJECT_COLOR_PRESETS if c not in used]
    pool = unused if unused else PROJECT_COLOR_PRESETS
    return random.choice(pool)


async def _create_project(db, user_id, args: dict):
    priority = (args.get("priority") or "").strip().lower()
    try:
        stages = (
            normalize_project_stages(args["stages"])
            if "stages" in args
            else [dict(s) for s in _DEFAULT_STAGES]
        )
        p = build_project(user_id, {
            "name": args["name"],
            "summary": args.get("summary"),
            "client": args.get("client"),
            "status": args.get("status", "pending"),
            "deadline": args["deadline"],
            "start_date": args["start_date"],
            "color": project_color_value(args.get("color")) or await _pick_unused_color(db, user_id),
            "priority": priority if priority in ("high", "medium", "low") else None,
            "stages": stages,
            "current_stage": stages[0]["key"],
        })
    except ValueError as exc:
        return json.dumps({"error": str(exc)})
    await add_project(db, p)
    await db.commit()
    return {"success": True, "project_id": p.id, "name": p.name,
            "stages": [s["label"] for s in stages],
            "stage_details": [{"key": s["key"], "label": s["label"],
                               "todo_count": len(s["todos"])} for s in stages],
            "current_stage": p.current_stage}


async def _update_stage(db, user_id, args: dict):
    """阶段与待办统一入口：只传 stage＝切换当前阶段；add/todos＝批量增删改移待办，一次提交。"""
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err

    stages = p.stages  # [{key, label, todos:[{id,text,done}]}]
    stage_arg = args.get("stage")
    if stage_arg is not None:
        if not isinstance(stage_arg, str) or not stage_arg.strip():
            return json.dumps({"error": "stage 必须是非空文本"})
        stage_arg = stage_arg.strip()

    raw_add = args.get("add", [])
    if not isinstance(raw_add, list) or any(not isinstance(text, str) or not text.strip() for text in raw_add):
        return json.dumps({"error": "add 必须是非空文本组成的数组"})
    add_texts = [text.strip() for text in raw_add]

    raw_todos = args.get("todos", [])
    if not isinstance(raw_todos, list):
        return json.dumps({"error": "todos 必须是对象数组"})
    for index, item in enumerate(raw_todos):
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not item["text"].strip():
            return json.dumps({"error": f"todos 第 {index + 1} 项必须包含非空 text"})
        for field in ("stage", "new_text", "to_stage"):
            if field in item and (not isinstance(item[field], str) or not item[field].strip()):
                return json.dumps({"error": f"todos 第 {index + 1} 项的 {field} 必须是非空文本"})
    todo_items = raw_todos

    if not stage_arg and not add_texts and not todo_items:
        return json.dumps({"error": "未指定操作：stage（切换阶段）、add（批量新增）或 todos（批量修改）至少给一个"})

    # 只传 stage = 切换当前阶段；配合 add/todos 时仅作操作范围限定，不切换指针
    if stage_arg and not add_texts and not todo_items:
        match, stage_error = _resolve_stage(stages, stage_arg)
        if stage_error:
            return json.dumps({"error": stage_error})
        if not match:
            return json.dumps({"error": f"阶段不存在: {stage_arg}",
                               "available": [s.get("label") for s in stages]})
        error = await _commit_project_intent(db, p, user_id, {"current_stage": match["key"]})
        if error:
            return error
        return {"success": True, "project_id": p.id, "current_stage": p.current_stage}

    results: list[dict] = []
    changed = False

    if add_texts:
        add_scope = stage_arg or p.current_stage
        target, stage_error = _resolve_stage(stages, str(add_scope)) if add_scope else (None, None)
        if stage_error:
            return json.dumps({"error": stage_error})
        if not target:
            return json.dumps({"error": f"阶段不存在: {stage_arg or p.current_stage}",
                               "available": [s.get("label") for s in stages]})
        base = next_project_todo_number(stages)
        target.setdefault("todos", [])
        for i, txt in enumerate(add_texts):
            target["todos"].append({"id": f"t{base + 1 + i}", "text": txt, "done": False})
        results.append({"action": "add", "stage": target.get("label"), "added": add_texts})
        changed = True

    for item in todo_items:
        target_text = str(item["text"]).strip()
        entry: dict = {"todo": target_text}
        results.append(entry)
        scope_hint = item.get("stage") or stage_arg
        scope = None
        if scope_hint:
            scope, stage_error = _resolve_stage(stages, scope_hint)
            if stage_error:
                entry["error"] = stage_error
                continue
            if not scope:
                entry["error"] = f"阶段不存在: {scope_hint}"
                continue
        todo_match, match_error = _find_todo(stages, target_text, scope)
        if match_error:
            if isinstance(match_error, tuple):
                entry["error"], entry["candidates"] = match_error
            else:
                entry["error"] = match_error
            continue
        if not todo_match:
            entry["error"] = "未找到待办"
            continue
        scope, found = todo_match
        entry["stage"] = scope.get("label")
        entry["todo"] = found.get("text")

        if item.get("remove"):
            scope["todos"] = [t for t in scope.get("todos", []) if t is not found]
            entry["action"] = "remove"
            changed = True
            continue

        # 先验证目标阶段再动内存对象：失败项必须零副作用，否则同批有成功项令
        # changed=True 时，这条已做的 rename/done 会被一起提交（静默数据损坏）。
        dest_stage = scope
        if item.get("to_stage"):
            dest_stage, stage_error = _resolve_stage(stages, item["to_stage"])
            if stage_error:
                entry["error"] = stage_error
                continue
            if not dest_stage:
                entry["error"] = f"目标阶段不存在: {item['to_stage']}"
                continue

        ops: list[str] = []
        if item.get("new_text"):
            found["text"] = str(item["new_text"])
            ops.append("rename")
        if "done" in item and item.get("done") is not None:
            found["done"] = bool(item["done"])
            ops.append("done")
        if dest_stage is not scope:
            scope["todos"] = [t for t in scope.get("todos", []) if t is not found]
            dest_stage.setdefault("todos", []).append(found)
            ops.append("move")
        if not ops:
            entry["error"] = "未指定操作（done/new_text/to_stage/remove 至少一个）"
            continue
        entry["action"] = "+".join(ops)
        entry["done"] = found.get("done")
        changed = True

    if not changed:
        return json.dumps({"error": "没有任何待办被修改", "results": results})

    error = await _commit_project_intent(db, p, user_id, {"stages": stages})
    if error:
        return error
    return {"success": True, "project_id": p.id, "results": results}


async def _set_color(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    color = project_color_value((args.get("color") or "").strip())
    if not color:
        return json.dumps({"error": "未提供颜色（color，需为预设色名）"})
    error = await _commit_project_intent(db, p, user_id, {"color": color})
    if error:
        return error
    return {"success": True, "project_id": p.id, "color": project_color_key(p.color)}


async def _archive_project(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    error = await _commit_project_intent(db, p, user_id, {"archived": bool(args.get("archived", True))})
    if error:
        return error
    return {"success": True, "project_id": p.id, "archived": p.archived}


async def _delete_project(db, user_id, args: dict):
    project_ids = args.get("project_ids")
    if project_ids is not None:
        if not isinstance(project_ids, list) or not project_ids or len(project_ids) > 20:
            return json.dumps({"error": "project_ids 必须是 1-20 个项目 id"})
        projects = []
        for pid in project_ids:
            project = await get_user_project(db, user_id, pid)
            if project is None:
                return json.dumps({"error": f"项目 {pid} 不存在"})
            projects.append(project)
        projects.sort(key=lambda project: project.id)
        names = "、".join(p.name for p in projects[:8]) + (f"等 {len(projects)} 个" if len(projects) > 8 else "")
        blocked = confirm.needs_target_confirmation(
            args,
            f"将删除项目：{names}，共 {len(projects)} 个，连同其中文件移入回收站（30 天内可恢复）",
            user_id,
            purpose=confirm.ACTION,
            action="delete_project",
            targets={"project_id": project_ids},
        )
        if blocked is not None:
            return blocked
        storage = get_storage()
        deleted_at = now_utc()
        results = []
        for project in projects:
            pid, name = project.id, project.name
            file_count = await count_project_files(db, user_id, pid)
            await soft_delete_project_full(db, storage, user_id, project, deleted_at)
            results.append({"deleted_project_id": pid, "name": name, "file_count": file_count})
        await db.commit()
        for project in projects:
            await events.publish(user_id, "projects", operation="delete", entity_id=project.id)
        return {"success": True, "deleted_count": len(results), "results": results}
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err

    # 不可逆 → 删除二次确认保底
    file_cnt = await count_project_files(db, user_id, p.id)
    summary = f"将删除项目「{p.name}」" + (f"及其 {file_cnt} 个文件" if file_cnt else "") + "移入回收站（30 天内可恢复）"
    blocked = confirm.needs_target_confirmation(
        args, summary, user_id,
        purpose=confirm.ACTION,
        action="delete_project",
        targets={"project_id": [p.id]},
    )
    if blocked is not None:
        return blocked

    pid, pname = p.id, p.name
    await soft_delete_project_full(db, get_storage(), user_id, p, now_utc())
    await db.commit()
    await events.publish(user_id, "projects", operation="delete", entity_id=pid)
    return {"success": True, "deleted_project_id": pid, "name": pname}


# ── 阶段/待办辅助 ──
async def _fetch(db, user_id, project_id):
    return await get_user_project(db, user_id, project_id)


async def _resolve_project(db, user_id, args):
    """按 project_id 或项目名 project 定位；返回 (Project|None, 错误JSON|None)。

    优先 id；否则按名精确匹配、再退化为包含匹配；重名优先未归档；仍歧义则列候选。
    """
    pid = args.get("project_id")
    if pid:
        p = await _fetch(db, user_id, pid)
        return (p, None) if p else (None, json.dumps({"error": "项目不存在"}))
    name = args.get("project")
    if name:
        name = str(name).strip()
        rows = await find_project_rows(db, user_id, name)
        if not rows:
            avail = await list_active_project_names(db, user_id)
            return None, json.dumps({"error": f"未找到名为「{name}」的项目",
                                     "available_projects": sorted(set(avail))[:20]})
        pool = [p for p in rows if not p.archived] or rows
        if len(pool) > 1:
            return None, json.dumps({"error": f"有多个匹配「{name}」的项目，请指明是哪个",
                                     "candidates": [{"id": p.id, "name": p.name, "status": p.status} for p in pool[:10]]})
        return pool[0], None
    return None, json.dumps({"error": "需提供 project_id 或项目名 project"})


async def _commit_project_intent(db, project, user_id, fields: dict):
    """咕咕按意图修改项目：基于刚读取的版本条件更新，冲突时不覆盖网页的新内容。"""
    if not fields:
        return json.dumps({"error": "未提供可更新的项目内容"})
    try:
        updated = await update_project_atomic(db, project.id, user_id, project.version, fields, project)
    except ValueError as exc:
        return json.dumps({"error": str(exc)})
    if not updated:
        await db.rollback()
        return json.dumps({"error": "项目刚被其他端修改，请重试"})
    await db.commit()
    return None


def _resolve_stage(stages: list[dict], target: str):
    """按 key 精确定位；名称仅在唯一时可用，避免重名时误改第一项。"""
    value = target.strip()
    by_key = next((stage for stage in stages if stage.get("key") == value), None)
    if by_key:
        return by_key, None
    by_label = [stage for stage in stages if stage.get("label") == value]
    if len(by_label) == 1:
        return by_label[0], None
    if len(by_label) > 1:
        return None, "阶段名称重名，请使用阶段 key 定位"
    return None, None


def _find_todo(stages: list[dict], target: str, stage: dict | None = None):
    """在给定阶段或全项目查找待办；重复命中时要求调用方缩小范围。"""
    haystack = [stage] if stage is not None else stages
    todos = [
        (candidate_stage, todo)
        for candidate_stage in haystack
        for todo in candidate_stage.get("todos", [])
    ]
    matches = [(candidate_stage, todo) for candidate_stage, todo in todos if todo.get("id") == target]
    if not matches:
        matches = [(candidate_stage, todo) for candidate_stage, todo in todos if todo.get("text") == target]
    if not matches:
        matches = [
            (candidate_stage, todo)
            for candidate_stage, todo in todos
            if target in todo.get("text", "")
        ]
    if len(matches) == 1:
        return matches[0], None
    if len(matches) > 1:
        candidates = [
            {"stage_key": candidate_stage.get("key"), "stage": candidate_stage.get("label"),
             "todo_id": todo.get("id"), "todo": todo.get("text")}
            for candidate_stage, todo in matches
        ]
        return None, ("待办匹配到多项，请提供 todos[].stage 或待办 ID", candidates)
    return None, None


async def _get_project(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    overview = await load_project_file_overviews(db, user_id, [p.id])
    context = project_context_metadata(p, overview[p.id])
    return {
        "id": p.id, "name": p.name, "status": p.status, "priority": p.priority,
        "summary": context["summary"], "files": context["files"],
        "client": p.client, "start_date": p.start_date, "deadline": p.deadline,
        "color": project_color_key(p.color),
        "current_stage": p.current_stage, "archived": p.archived,
        "stages": [
            {"key": s.get("key"), "label": s.get("label"), "done": s.get("done", False),
             "todos": [{"id": t.get("id"), "text": t.get("text"), "done": t.get("done", False)}
                       for t in s.get("todos", [])]}
            for s in p.stages
        ],
    }


async def _add_stage(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    stages = p.stages
    label = args.get("label")
    if not isinstance(label, str) or not label.strip():
        return json.dumps({"error": "阶段名称不能为空"})
    label = label.strip()
    new = {"key": next_project_stage_key(stages), "label": label, "todos": []}
    pos = args.get("position")
    if pos is None or pos >= len(stages):
        stages.append(new)
    else:
        stages.insert(max(0, pos), new)
    error = await _commit_project_intent(db, p, user_id, {"stages": stages})
    if error:
        return error
    return {"success": True, "project_id": p.id, "stage_key": new["key"], "label": new["label"]}


async def _remove_stage(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    stages = p.stages
    stage_arg = args.get("stage")
    if not isinstance(stage_arg, str) or not stage_arg.strip():
        return json.dumps({"error": "stage 必须是非空文本"})
    stage_arg = stage_arg.strip()
    match, stage_error = _resolve_stage(stages, stage_arg)
    if stage_error:
        return json.dumps({"error": stage_error})
    if not match:
        return json.dumps({"error": f"阶段不存在: {stage_arg}",
                           "available": [s.get("label") for s in stages]})
    if len(stages) <= 1:
        return json.dumps({"error": "项目至少保留一个阶段，无法删除最后一个阶段"})
    removed_key = match.get("key")
    stages = [s for s in stages if s.get("key") != removed_key]
    current_stage = stages[0]["key"] if p.current_stage == removed_key and stages else p.current_stage
    error = await _commit_project_intent(
        db, p, user_id, {"stages": stages, "current_stage": current_stage},
    )
    if error:
        return error
    current = next((stage for stage in stages if stage.get("key") == current_stage), None)
    return {"success": True, "project_id": p.id, "removed": match.get("label"),
            "remaining_stages": [s.get("label") for s in stages],
            "current_stage_key": current.get("key") if current else None,
            "current_stage": current.get("label") if current else None}


async def _rename_stage(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    stages = p.stages
    stage_arg = args.get("stage")
    if not isinstance(stage_arg, str) or not stage_arg.strip():
        return json.dumps({"error": "stage 必须是非空文本"})
    stage_arg = stage_arg.strip()
    match, stage_error = _resolve_stage(stages, stage_arg)
    if stage_error:
        return json.dumps({"error": stage_error})
    if not match:
        return json.dumps({"error": f"阶段不存在: {stage_arg}"})
    new_label = args.get("new_label")
    if not isinstance(new_label, str) or not new_label.strip():
        return json.dumps({"error": "阶段名称不能为空"})
    match["label"] = new_label.strip()
    error = await _commit_project_intent(db, p, user_id, {"stages": stages})
    if error:
        return error
    return {"success": True, "project_id": p.id, "label": match["label"]}


async def _set_stages(db, user_id, args: dict):
    """整体替换项目阶段（声明式：给出想要的完整阶段列表，增删改排序一次到位）。
    同名阶段的待办默认保留（本次没给该阶段 todos 时）；给了 todos 则以本次为准。"""
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    try:
        new_stages, current_stage = replace_project_stages(p.stages, p.current_stage, args.get("stages"))
    except ValueError as exc:
        return json.dumps({"error": str(exc)})
    error = await _commit_project_intent(
        db, p, user_id, {"stages": new_stages, "current_stage": current_stage},
    )
    if error:
        return error
    return {"success": True, "project_id": p.id, "stages": [s["label"] for s in new_stages],
            "stage_details": [{"key": s["key"], "label": s["label"],
                               "todo_count": len(s["todos"])} for s in new_stages],
            "current_stage": current_stage}


class ProjectsSkill(BaseSkill):
    name = "projects"
    tools = [
        Tool(
            name="list_projects",
            label="查询项目列表",
            description_short="查询项目；支持按状态和归档状态筛选。",
            description="查询项目列表，可按状态筛选；默认不含归档项目，返回阶段进度和截止日期。",
            input_schema={
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["pending", "active", "done"],
                    },
                    "archived": {
                        "type": "boolean",
                    },
                },
            },
            handler=_list_projects,
            parallel_safe=True,
        ),
        Tool(
            name="update_project",
            label="更新项目",
            description_short="修改项目；可调整优先级，none 清除优先级。",
            description="修改项目的状态、截止日期、开始日期、客户名称、优先级或项目摘要；summary 是给咕咕维护的项目近况，最多 200 个字符，传空字符串或 null 清空；它不替代 status、阶段或日期。start_date/deadline 传日期字符串，系统统一归一为 YYYY-MM-DD。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "status":     {"type": "string", "enum": ["pending", "active", "done"]},
                    "deadline":   {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                    "start_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                    "client":     {"type": "string"},
                    "name":       {"type": "string"},
                    "summary":   {"type": ["string", "null"], "maxLength": 200},
                    "priority":   {"type": "string", "enum": ["high", "medium", "low", "none"]},
                },
                "required": [],
            },
            handler=_update_project,
            mutates=True,
        ),
        Tool(
            name="create_project",
            label="新建项目",
            description_short='创建项目；stages 可用名称数组 ["开发","上线"]，也可用带待办的对象数组；省略时使用默认阶段',
            description="创建项目，必须填写开始日期和截止日期（YYYY-MM-DD），可设置颜色、优先级、阶段和最多 200 字符的项目摘要。summary 是给咕咕维护的近况，不替代项目状态或阶段。stages 必须是非空数组，可用名称简写 [\"开发\",\"上线\"]，或对象 {label: 阶段名, todos: [待办文本]}，例如 [{\"label\":\"设计\",\"todos\":[\"整理需求\"]}]；省略 stages 时使用默认阶段。color 只能传语义色名 amber、sage、teal、sky、indigo、lavender、rose、sunset；不要传 CSS、十六进制或视觉描述。",
            input_schema={
                "type": "object",
                "properties": {
                    "name":       {"type": "string"},
                    "client":     {"type": "string"},
                    "summary":    {"type": ["string", "null"], "maxLength": 200},
                    "status":     {"type": "string", "enum": ["pending", "active", "done"]},
                    "deadline":   {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                    "start_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                    "color":      {"type": "string", "enum": list(PROJECT_COLOR_KEYS)},
                    "priority":   {"type": "string", "enum": ["high", "medium", "low"]},
                    "stages": _STAGES_INPUT_SCHEMA,
                },
                "required": ["name", "start_date", "deadline"],
                "additionalProperties": False,
            },
            handler=_create_project,
            mutates=True,
        ),
        Tool(
            name="set_color", label="设置项目颜色",
            description_short='设置项目颜色。',
            description="设置项目的颜色。color 只能传语义色名 amber、sage、teal、sky、indigo、lavender、rose、sunset；不要传 CSS、十六进制或中文视觉描述。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "color": {"type": "string", "enum": list(PROJECT_COLOR_KEYS)},
                },
                "required": ["color"],
            },
            handler=_set_color,
            mutates=True,
        ),
        Tool(
            name="archive_project",
            label="归档项目",
            description_short='归档或取消归档项目，省略时默认归档。',
            description="归档或取消归档项目（可逆，不会删除数据）。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "archived": {"type": "boolean"},
                },
                "required": [],
            },
            handler=_archive_project,
            mutates=True,
        ),
        Tool(
            name="delete_project",
            label="删除项目",
            description_short='删除项目。',
            description="删除一个或多个项目（连带项目文件进入回收站，30 天内可恢复）。单项传 project_id/project，批量传 project_ids；批量目标一次确认。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "project_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 20, "uniqueItems": True},
                },
                "required": [],
            },
            handler=_delete_project,
            mutates=True,
            destructive=True,
            batch_confirmation=True,
        ),
        Tool(
            name="get_project", label="项目详情",
            description_short="读取项目结构。",
            description="获取单个项目的完整结构：状态、日期、客户、当前阶段、summary（咕咕维护的项目近况）、项目文件概览（总文件数、根层文件数、目录数），以及每个阶段（含 key/label）下的待办列表（含 id/text/done）。文件概览只给数量；查看文件明细时用 list_dir(space=project, project_id=项目ID, scope=project_root)，不要把项目 ID 当 folder_id。管理阶段或待办前先用它看清结构。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                },
                "required": [],
            },
            handler=_get_project,
            parallel_safe=True,
        ),
        Tool(
            name="add_stage", label="新增阶段",
            description_short="新增阶段。",
            description="给项目新增一个阶段（追加到末尾，或用 position 指定插入位置）。阶段 key 是稳定标识，不代表显示顺序；注意：这是给项目加阶段，不是新建项目。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "label": {"type": "string", "minLength": 1},
                    "position": {"type": "integer", "minimum": 0},
                },
                "required": ["label"],
                "additionalProperties": False,
            },
            handler=_add_stage,
            mutates=True,
        ),
        Tool(
            name="remove_stage", label="删除阶段",
            description_short='删除阶段。',
            description="删除项目的某个阶段（按唯一阶段名称或 key；同名时必须用 key）。连带该阶段的待办一并移除；删除当前阶段后会切换到剩余列表第一阶段并在结果中返回。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "stage": {"type": "string", "minLength": 1},
                },
                "required": ["stage"],
                "additionalProperties": False,
            },
            handler=_remove_stage,
            mutates=True,
        ),
        Tool(
            name="rename_stage", label="重命名阶段",
            description_short='重命名阶段。',
            description="重命名项目的某个阶段（按唯一阶段名称或 key；同名时必须用 key）。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "stage": {"type": "string", "minLength": 1},
                    "new_label": {"type": "string", "minLength": 1},
                },
                "required": ["stage", "new_label"],
                "additionalProperties": False,
            },
            handler=_rename_stage,
            mutates=True,
        ),
        Tool(
            name="update_stage",
            label="更新阶段",
            description_short='切换阶段或批量更新待办；add 是字符串数组，如 ["验收"]，todos 是对象数组。',
            description=(
                "项目阶段与待办的统一入口。只传 stage＝切换当前阶段；"
                "add＝批量新增待办（字符串数组，省略 stage 时加到当前阶段）；"
                "todos＝批量修改待办（每项 {text 定位, done 勾/取消, new_text 改名, "
                "to_stage 移动, remove 删除}，一次可处理多条，比如把整个阶段的待办一次勾完）。"
                "待办定位的 stage 优先取每项 todos[].stage，其次取顶层 stage；两者都省略时在全项目唯一匹配，"
                "如重名或模糊匹配到多项会要求提供阶段 key，或在 text 中填写 get_project 返回的待办 id。"
                '例如 add:["验收"]，或 todos:[{"text":"t1","done":true}]。顶层 stage 只作范围限定，不切换当前阶段。'
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "stage": {"type": "string", "minLength": 1},
                    "add": {"type": "array", "items": {"type": "string", "minLength": 1}},
                    "todos": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string", "minLength": 1},
                                "stage": {"type": "string", "minLength": 1},
                                "done": {"type": "boolean"},
                                "new_text": {"type": "string", "minLength": 1},
                                "to_stage": {"type": "string", "minLength": 1},
                                "remove": {"type": "boolean"},
                            },
                            "required": ["text"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": [],
                "additionalProperties": False,
            },
            handler=_update_stage,
            mutates=True,
        ),
        Tool(
            name="set_stages", label="整体设置阶段",
            description_short="整体重排阶段。",
            description="一次性声明项目的完整阶段列表，可增删、改名和重排；stages 是非空数组，可用名称简写，也可用对象 {key?: 现有阶段key, label: 阶段名, todos?: [待办文本]}。同名阶段必须提供 key；保留阶段时建议带上 key。省略 todos 保留对应阶段的待办，显式提供 todos 会将待办重建为未完成。当前阶段 key 若仍存在则保留，否则切换到首个阶段。只改一个阶段用专用工具。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "stages": _SET_STAGES_INPUT_SCHEMA,
                },
                "required": ["stages"],
                "additionalProperties": False,
            },
            handler=_set_stages,
            mutates=True,
        ),
    ]


ProjectsSkill().register()
