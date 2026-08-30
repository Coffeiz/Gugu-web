"""项目领域技能：list_projects / create_project / update_project。

逻辑迁自原 agent.py 的 `_exec_tool`，并统一经项目领域写入入口执行。
"""
import json
import random

from app.core.project_colors import PROJECT_COLOR_PRESETS
from app.core.projects import (
    build_project, find_project_stage, next_project_stage_key, next_project_todo_number,
    normalize_project_stages, replace_project_stages, update_project_atomic,
)
from app.core.tz import now_utc
from app.services.projects import (
    add_project,
    count_project_files,
    delete_project,
    find_project_rows,
    get_user_project,
    list_active_project_names,
    list_agent_projects,
    project_colors,
)

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
            "color": p.color,        # 给「同类项目同色系」用：建新项目前看现有同类的颜色好沿用
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
    error = await _commit_project_intent(db, p, user_id, fields)
    if error:
        return error
    return {"success": True, "project_id": p.id, "name": p.name, "priority": p.priority}


_DEFAULT_STAGES = [
    {"key": "s0", "label": "计划", "todos": []},
    {"key": "s1", "label": "执行", "todos": []},
    {"key": "s2", "label": "交付", "todos": []},
]


async def _pick_unused_color(db, user_id) -> str:
    rows = await project_colors(db, user_id)
    used = set(rows)
    unused = [c for c in PROJECT_COLOR_PRESETS if c not in used]
    pool = unused if unused else PROJECT_COLOR_PRESETS
    return random.choice(pool)


async def _create_project(db, user_id, args: dict):
    # 自定义阶段：stages 可为 ["计划","执行"] 或 [{"label":..,"todos":[..]}]，不传用默认三段
    raw = args.get("stages")
    stages = normalize_project_stages(raw) if raw else [dict(s) for s in _DEFAULT_STAGES]
    if not stages:
        stages = [dict(s) for s in _DEFAULT_STAGES]
    priority = (args.get("priority") or "").strip().lower()
    try:
        p = build_project(user_id, {
            "name": args["name"],
            "client": args.get("client"),
            "status": args.get("status", "pending"),
            "deadline": args["deadline"],
            "start_date": args["start_date"],
            "color": args.get("color") or await _pick_unused_color(db, user_id),
            "priority": priority if priority in ("high", "medium", "low") else None,
            "stages": stages,
            "current_stage": stages[0]["key"],
        })
    except ValueError as exc:
        return json.dumps({"error": str(exc)})
    await add_project(db, p)
    await db.commit()
    return {"success": True, "project_id": p.id, "name": p.name,
            "stages": [s["label"] for s in stages]}


async def _update_stage(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err

    stages = p.stages  # [{key, label, todos:[{id,text,done}]}]
    changed = False

    # 切换当前阶段（按 key 或 label 匹配）
    if args.get("stage"):
        target = str(args["stage"]).strip()
        match = next(
            (s for s in stages if s.get("key") == target or s.get("label") == target),
            None,
        )
        if not match:
            return json.dumps({"error": f"阶段不存在: {target}",
                               "available": [s.get("label") for s in stages]})
        current_stage = match["key"]
        changed = True
    else:
        current_stage = p.current_stage

    # 勾选/取消某条待办（按所在阶段 + 文本匹配）
    td = args.get("todo")
    if isinstance(td, str):                 # 容错：模型偶尔把 todo 传成字符串而非 {text,...}
        td = {"text": td} if td.strip() else None
    if td and td.get("text"):
        st_key = td.get("stage")
        done_val = bool(td.get("done", True))
        hit = False
        for s in stages:
            if st_key and s.get("key") != st_key and s.get("label") != st_key:
                continue
            for t in s.get("todos", []):
                if td["text"] in t.get("text", ""):
                    t["done"] = done_val
                    hit = True
                    break
            if hit:
                break
        if not hit:
            return json.dumps({"error": f"未找到待办: {td['text']}"})
        changed = True

    if not changed:
        return json.dumps({"error": "未指定 stage 或 todo，无操作"})

    fields = {"current_stage": current_stage}
    if td and td.get("text"):
        fields["stages"] = stages
    error = await _commit_project_intent(db, p, user_id, fields)
    if error:
        return error
    return {"success": True, "project_id": p.id, "current_stage": p.current_stage}


async def _set_color(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    color = (args.get("color") or "").strip()
    if not color:
        return json.dumps({"error": "未提供颜色（color，需为预设色板中的渐变色字符串）"})
    error = await _commit_project_intent(db, p, user_id, {"color": color})
    if error:
        return error
    return {"success": True, "project_id": p.id, "color": p.color}


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
        names = "、".join(p.name for p in projects[:8]) + (f"等 {len(projects)} 个" if len(projects) > 8 else "")
        blocked = confirm.needs_confirmation(args, f"将永久删除项目：{names}，共 {len(projects)} 个，连同其中文件，此操作不可恢复", user_id,
                                             identity=f"delete_project:project_ids={sorted(project_ids)}")
        if blocked is not None:
            return blocked
        deleted_at = now_utc()
        results = []
        for project in projects:
            pid, name = project.id, project.name
            file_count = await count_project_files(db, user_id, pid)
            await delete_project(db, user_id, project, deleted_at)
            results.append({"deleted_project_id": pid, "name": name, "file_count": file_count})
        await db.commit()
        return {"success": True, "deleted_count": len(results), "results": results}
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err

    # 不可逆 → 删除二次确认保底
    file_cnt = await count_project_files(db, user_id, p.id)
    summary = f"将永久删除项目「{p.name}」" + (f"及其 {file_cnt} 个文件" if file_cnt else "") + "，此操作不可恢复"
    blocked = confirm.needs_confirmation(args, summary, user_id)
    if blocked is not None:
        return blocked

    pid, pname = p.id, p.name
    # 文件软删（置 deleted_at），文件夹随项目 FK CASCADE 自动删
    await delete_project(db, user_id, p, now_utc())
    await db.commit()
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


async def _get_project(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    return {
        "id": p.id, "name": p.name, "status": p.status, "priority": p.priority,
        "client": p.client, "start_date": p.start_date, "deadline": p.deadline,
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
    new = {"key": next_project_stage_key(stages), "label": args["label"], "todos": []}
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
    match = find_project_stage(stages, args["stage"])
    if not match:
        return json.dumps({"error": f"阶段不存在: {args['stage']}",
                           "available": [s.get("label") for s in stages]})
    removed_key = match.get("key")
    stages = [s for s in stages if s.get("key") != removed_key]
    current_stage = stages[0]["key"] if p.current_stage == removed_key and stages else p.current_stage
    error = await _commit_project_intent(
        db, p, user_id, {"stages": stages, "current_stage": current_stage},
    )
    if error:
        return error
    return {"success": True, "project_id": p.id, "removed": match.get("label"),
            "remaining_stages": [s.get("label") for s in stages]}


async def _rename_stage(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    stages = p.stages
    match = find_project_stage(stages, args["stage"])
    if not match:
        return json.dumps({"error": f"阶段不存在: {args['stage']}"})
    match["label"] = args["new_label"]
    error = await _commit_project_intent(db, p, user_id, {"stages": stages})
    if error:
        return error
    return {"success": True, "project_id": p.id, "label": args["new_label"]}


async def _add_todo(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    stages = p.stages
    match = find_project_stage(stages, args["stage"])
    if not match:
        return json.dumps({"error": f"阶段不存在: {args['stage']}",
                           "available": [s.get("label") for s in stages]})
    texts = args.get("texts") or ([args["text"]] if args.get("text") else [])
    if not texts:
        return json.dumps({"error": "未提供待办内容（texts）"})
    base = next_project_todo_number(stages)
    match.setdefault("todos", [])
    for i, txt in enumerate(texts):
        match["todos"].append({"id": f"t{base + 1 + i}", "text": txt, "done": False})
    error = await _commit_project_intent(db, p, user_id, {"stages": stages})
    if error:
        return error
    return {"success": True, "project_id": p.id, "stage": match.get("label"), "added": texts}


async def _remove_todo(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    stages = p.stages
    match = find_project_stage(stages, args["stage"])
    if not match:
        return json.dumps({"error": f"阶段不存在: {args['stage']}"})
    target = str(args["todo"])
    todos = match.get("todos", [])
    kept = [t for t in todos if not (target in t.get("text", "") or t.get("id") == target)]
    if len(kept) == len(todos):
        return json.dumps({"error": f"未找到待办: {target}"})
    match["todos"] = kept
    error = await _commit_project_intent(db, p, user_id, {"stages": stages})
    if error:
        return error
    return {"success": True, "project_id": p.id, "removed": target}


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
    return {"success": True, "project_id": p.id, "stages": [s["label"] for s in new_stages]}


async def _update_todo(db, user_id, args: dict):
    """改一条待办的文本/完成态，并可选移动到另一阶段。按文本或 id 定位（可用 stage 限定范围）。"""
    action = args.get("action")
    if action == "complete":
        args = {**args, "done": args.get("done")}
    elif action == "rename":
        args = {**args, "text": args.get("text")}
    elif action == "move":
        args = {**args, "to_stage": args.get("to_stage")}
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    target = str(args.get("todo") or "").strip()
    if not target:
        return json.dumps({"error": "需提供 todo（待办文本或 id）"})
    stages = p.stages
    st_hint = args.get("stage")
    found = found_stage = None
    for s in stages:
        if st_hint and s.get("key") != str(st_hint) and s.get("label") != str(st_hint):
            continue
        for t in s.get("todos", []):
            if t.get("id") == target or target in t.get("text", ""):
                found, found_stage = t, s
                break
        if found:
            break
    if not found:
        return json.dumps({"error": f"未找到待办: {target}"})

    if not (args.get("text") or ("done" in args and args["done"] is not None) or args.get("to_stage")):
        return json.dumps({"error": "没提供要改的内容（text/done/to_stage），未改动。",
                           "todo": found.get("text")})

    if args.get("text"):
        found["text"] = str(args["text"])
    if "done" in args and args["done"] is not None:
        found["done"] = bool(args["done"])
    dest = found_stage
    to = args.get("to_stage")
    if to:
        dest = find_project_stage(stages, to)
        if not dest:
            return json.dumps({"error": f"目标阶段不存在: {to}",
                               "available": [s.get("label") for s in stages]})
        if dest is not found_stage:
            found_stage["todos"] = [t for t in found_stage.get("todos", []) if t is not found]
            dest.setdefault("todos", []).append(found)

    error = await _commit_project_intent(db, p, user_id, {"stages": stages})
    if error:
        return error
    return {"success": True, "project_id": p.id, "todo": found.get("text"),
            "done": found.get("done"), "stage": dest.get("label")}


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
        ),
        Tool(
            name="update_project",
            label="更新项目",
            description_short="修改项目；可调整优先级，none 清除优先级。",
            description="修改项目的状态、截止日期、开始日期、客户名称、优先级。",
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
            description_short="创建项目；可带 stages/todos，后续用 add_stage/add_todo",
            description="创建项目，必须填写开始日期和截止日期，可一次设置颜色、优先级、阶段和待办。",
            input_schema={
                "type": "object",
                "properties": {
                    "name":       {"type": "string"},
                    "client":     {"type": "string"},
                    "status":     {"type": "string", "enum": ["pending", "active", "done"]},
                    "deadline":   {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                    "start_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
                    "color":      {"type": "string", "enum": list(PROJECT_COLOR_PRESETS)},
                    "priority":   {"type": "string", "enum": ["high", "medium", "low"]},
                    "stages": {
                        "type": "array",
                        "items": {
                            "type": ["string", "object"],
                            "properties": {
                                "label": {"type": "string"},
                                "todos": {"type": "array", "items": {"type": "string"}},
                            },
                        },
                    },
                },
                "required": ["name", "start_date", "deadline"],
            },
            handler=_create_project,
            mutates=True,
        ),
        Tool(
            name="update_stage",
            label="更新阶段",
            description_short='切换阶段或待办；省略 done 时默认完成。',
            description="切换项目当前阶段，或勾选/取消某个阶段下的待办事项。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "stage": {"type": "string"},
                    "todo": {
                        "type": "object",
                        "properties": {
                            "stage": {"type": "string"},
                            "text": {"type": "string"},
                            "done": {"type": "boolean"},
                        },
                        "required": ["text"],
                    },
                },
                "required": [],
            },
            handler=_update_stage,
            mutates=True,
        ),
        Tool(
            name="set_color", label="设置项目颜色",
            description_short='设置项目颜色。',
            description="设置项目的颜色，只能是预设色板中的渐变色字符串之一。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "color": {"type": "string", "enum": list(PROJECT_COLOR_PRESETS)},
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
            description="永久删除一个或多个项目（连带项目文件，不可恢复）。单项传 project_id/project，批量传 project_ids；批量目标一次确认。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "project_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 20},
                    "confirm": {"type": "boolean"},
                    "confirm_token": {"type": "string"},
                },
                "required": [],
            },
            handler=_delete_project,
            mutates=True,
            destructive=True,
        ),
        Tool(
            name="get_project", label="项目详情",
            description_short="读取项目结构。",
            description="获取单个项目的完整结构：状态、日期、客户、当前阶段，以及每个阶段（含 key/label）下的待办列表（含 id/text/done）。管理阶段或待办前先用它看清结构。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                },
                "required": [],
            },
            handler=_get_project,
        ),
        Tool(
            name="add_stage", label="新增阶段",
            description_short="新增阶段。",
            description="给项目新增一个阶段（追加到末尾，或用 position 指定插入位置）。注意：这是给项目加阶段，不是新建项目。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "label": {"type": "string"},
                    "position": {"type": "integer", "minimum": 0},
                },
                "required": ["label"],
            },
            handler=_add_stage,
            mutates=True,
        ),
        Tool(
            name="remove_stage", label="删除阶段",
            description_short='删除阶段。',
            description="删除项目的某个阶段（按阶段名称或 key）。连带该阶段的待办一并移除。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "stage": {"type": "string"},
                },
                "required": ["stage"],
            },
            handler=_remove_stage,
            mutates=True,
        ),
        Tool(
            name="rename_stage", label="重命名阶段",
            description_short='重命名阶段。',
            description="重命名项目的某个阶段。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "stage": {"type": "string"},
                    "new_label": {"type": "string"},
                },
                "required": ["stage", "new_label"],
            },
            handler=_rename_stage,
            mutates=True,
        ),
        Tool(
            name="add_todo", label="新增待办",
            description_short="新增待办。",
            description="给项目某阶段新增一条或多条待办（用 texts 数组一次加多条，可用于批量建待办模板）。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "stage": {"type": "string"},
                    "texts": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["stage", "texts"],
            },
            handler=_add_todo,
            mutates=True,
        ),
        Tool(
            name="remove_todo", label="删除待办",
            description_short='删除待办。',
            description="删除项目某阶段下的一条待办（按文本或 id 匹配）。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "stage": {"type": "string"},
                    "todo": {"type": "string"},
                },
                "required": ["stage", "todo"],
            },
            handler=_remove_todo,
            mutates=True,
        ),
        Tool(
            name="set_stages", label="整体设置阶段",
            description_short="整体重排阶段。",
            description="一次性声明项目的完整阶段列表，可增删、改名和重排；只改一个阶段用专用工具。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "stages": {
                        "type": "array",
                        "items": {
                            "type": ["string", "object"],
                            "properties": {
                                "label": {"type": "string"},
                                "todos": {"type": "array", "items": {"type": "string"}},
                            },
                        },
                    },
                },
                "required": ["stages"],
            },
            handler=_set_stages,
            mutates=True,
        ),
        Tool(
            name="update_todo", label="修改待办",
            description_short='修改待办；支持完成、重命名和移动。',
            description="改一条待办的文本或完成状态，并可选移动到另一个阶段（to_stage）。按文本（部分匹配）或 id 定位，可用 stage 限定查找范围。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "project": {"type": "string"},
                    "todo": {"type": "string"},
                    "stage": {"type": "string"},
                    "text": {"type": "string"},
                    "done": {"type": "boolean"},
                    "to_stage": {"type": "string"},
                    "action": {"type": "string", "enum": ["complete", "rename", "move"]},
                },
                "required": ["todo"],
                "anyOf": [
                    {"required": ["action"], "oneOf": [
                        {"properties": {"action": {"const": "complete"}}, "required": ["done"], "not": {"anyOf": [{"required": ["text"]}, {"required": ["to_stage"]}]}},
                        {"properties": {"action": {"const": "rename"}}, "required": ["text"], "not": {"anyOf": [{"required": ["done"]}, {"required": ["to_stage"]}]}},
                        {"properties": {"action": {"const": "move"}}, "required": ["to_stage"], "not": {"anyOf": [{"required": ["done"]}, {"required": ["text"]}]}},
                    ]},
                    {"not": {"required": ["action"]}, "anyOf": [
                        {"required": ["done"]},
                        {"required": ["text"]},
                        {"required": ["to_stage"]},
                    ]},
                ],
            },
            handler=_update_todo,
            mutates=True,
        ),
    ]


ProjectsSkill().register()
