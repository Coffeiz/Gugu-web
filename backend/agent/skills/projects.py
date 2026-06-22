"""项目领域技能：list_projects / create_project / update_project。

逻辑迁自原 agent.py 的 `_exec_tool`，一字不改（含 user_id 所有权校验、
done_at 处理）。
"""
import json
from datetime import datetime

from sqlalchemy import func, select

from app.models import File, Project
from agent import confirm
from agent.skills.base import BaseSkill, Tool


async def _list_projects(db, user_id, args: dict):
    stmt = select(Project).where(
        Project.user_id == user_id,
        Project.archived == False,
    ).order_by(Project.updated_at.desc())
    result = await db.execute(stmt)
    projects = result.scalars().all()
    if args.get("status"):
        projects = [p for p in projects if p.status == args["status"]]
    return [
        {
            "id": p.id,
            "name": p.name,
            "status": p.status,
            "deadline": p.deadline,
            "start_date": p.start_date,
            "client": p.client,
            "notes": p.notes,
            "stages_done": sum(1 for s in p.stages if s.get("done")),
            "stages_total": len(p.stages),
        }
        for p in projects
    ]


async def _update_project(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    if "status" in args:
        if args["status"] == "done" and p.done_at is None:
            p.done_at = datetime.utcnow()
        p.status = args["status"]
    for field in ("deadline", "start_date", "client", "notes", "name"):
        if field in args:
            setattr(p, field, args[field])
    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "name": p.name}


async def _create_project(db, user_id, args: dict):
    p = Project(
        user_id=user_id,
        name=args["name"],
        client=args.get("client"),
        status=args.get("status", "pending"),
        deadline=args.get("deadline"),
        start_date=args.get("start_date"),
        notes=args.get("notes", ""),
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return {"success": True, "project_id": p.id, "name": p.name}


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
        p.current_stage = match["key"]
        changed = True

    # 勾选/取消某条待办（按所在阶段 + 文本匹配）
    td = args.get("todo")
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
        p.stages = stages  # 回写 stages_json
        changed = True

    if not changed:
        return json.dumps({"error": "未指定 stage 或 todo，无操作"})

    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "current_stage": p.current_stage}


async def _set_priority(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    pr = (args.get("priority") or "").strip().lower()
    p.priority = pr if pr in ("high", "medium", "low") else None
    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "priority": p.priority}


async def _set_color(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    color = (args.get("color") or "").strip()
    if not color:
        return json.dumps({"error": "未提供颜色（color，如 #A3B1FF）"})
    p.color = color
    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "color": p.color}


async def _archive_project(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    p.archived = bool(args.get("archived", True))
    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "archived": p.archived}


async def _delete_project(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err

    # 不可逆 → 删除二次确认保底
    file_cnt = (await db.execute(
        select(func.count(File.id)).where(
            File.project_id == p.id,
            File.user_id == user_id,
            File.deleted_at.is_(None),
        )
    )).scalar() or 0
    summary = f"将永久删除项目「{p.name}」" + (f"及其 {file_cnt} 个文件" if file_cnt else "") + "，此操作不可恢复"
    blocked = confirm.needs_confirmation(args, summary)
    if blocked is not None:
        return blocked

    pid, pname = p.id, p.name
    await db.delete(p)
    await db.commit()
    return {"success": True, "deleted_project_id": pid, "name": pname}


# ── 阶段/待办辅助 ──
def _find_stage(stages: list, target: str):
    t = str(target).strip()
    return next((s for s in stages if s.get("key") == t or s.get("label") == t), None)


def _next_key(stages: list, prefix: str = "s") -> str:
    mx = -1
    for s in stages:
        k = str(s.get("key", ""))
        if k.startswith(prefix) and k[len(prefix):].isdigit():
            mx = max(mx, int(k[len(prefix):]))
    return f"{prefix}{mx + 1}"


def _max_todo_num(stages: list) -> int:
    mx = 0
    for s in stages:
        for t in s.get("todos", []):
            tid = str(t.get("id", ""))
            if tid.startswith("t") and tid[1:].isdigit():
                mx = max(mx, int(tid[1:]))
    return mx


async def _fetch(db, user_id, project_id):
    r = await db.execute(
        select(Project).where(Project.id == project_id, Project.user_id == user_id)
    )
    return r.scalars().first()


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
        rows = (await db.execute(
            select(Project).where(Project.user_id == user_id, Project.name == name)
        )).scalars().all()
        if not rows:
            rows = (await db.execute(
                select(Project).where(Project.user_id == user_id, Project.name.ilike(f"%{name}%"))
            )).scalars().all()
        if not rows:
            avail = (await db.execute(
                select(Project.name).where(Project.user_id == user_id, Project.archived == False)
            )).scalars().all()
            return None, json.dumps({"error": f"未找到名为「{name}」的项目",
                                     "available_projects": sorted(set(avail))[:20]})
        pool = [p for p in rows if not p.archived] or rows
        if len(pool) > 1:
            return None, json.dumps({"error": f"有多个匹配「{name}」的项目，请指明是哪个",
                                     "candidates": [{"id": p.id, "name": p.name, "status": p.status} for p in pool[:10]]})
        return pool[0], None
    return None, json.dumps({"error": "需提供 project_id 或项目名 project"})


async def _get_project(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    return {
        "id": p.id, "name": p.name, "status": p.status, "priority": p.priority,
        "client": p.client, "start_date": p.start_date, "deadline": p.deadline,
        "notes": p.notes, "current_stage": p.current_stage, "archived": p.archived,
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
    new = {"key": _next_key(stages), "label": args["label"], "todos": []}
    pos = args.get("position")
    if pos is None or pos >= len(stages):
        stages.append(new)
    else:
        stages.insert(max(0, pos), new)
    p.stages = stages
    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "stage_key": new["key"], "label": new["label"]}


async def _remove_stage(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    stages = p.stages
    match = _find_stage(stages, args["stage"])
    if not match:
        return json.dumps({"error": f"阶段不存在: {args['stage']}",
                           "available": [s.get("label") for s in stages]})
    removed_key = match.get("key")
    stages = [s for s in stages if s.get("key") != removed_key]
    if p.current_stage == removed_key:
        p.current_stage = stages[0]["key"] if stages else None
    p.stages = stages
    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "removed": match.get("label"),
            "remaining_stages": [s.get("label") for s in stages]}


async def _rename_stage(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    stages = p.stages
    match = _find_stage(stages, args["stage"])
    if not match:
        return json.dumps({"error": f"阶段不存在: {args['stage']}"})
    match["label"] = args["new_label"]
    p.stages = stages
    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "label": args["new_label"]}


async def _add_todo(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    stages = p.stages
    match = _find_stage(stages, args["stage"])
    if not match:
        return json.dumps({"error": f"阶段不存在: {args['stage']}",
                           "available": [s.get("label") for s in stages]})
    texts = args.get("texts") or ([args["text"]] if args.get("text") else [])
    if not texts:
        return json.dumps({"error": "未提供待办内容（texts）"})
    base = _max_todo_num(stages)
    match.setdefault("todos", [])
    for i, txt in enumerate(texts):
        match["todos"].append({"id": f"t{base + 1 + i}", "text": txt, "done": False})
    p.stages = stages
    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "stage": match.get("label"), "added": texts}


async def _remove_todo(db, user_id, args: dict):
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    stages = p.stages
    match = _find_stage(stages, args["stage"])
    if not match:
        return json.dumps({"error": f"阶段不存在: {args['stage']}"})
    target = str(args["todo"])
    todos = match.get("todos", [])
    kept = [t for t in todos if not (target in t.get("text", "") or t.get("id") == target)]
    if len(kept) == len(todos):
        return json.dumps({"error": f"未找到待办: {target}"})
    match["todos"] = kept
    p.stages = stages
    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "removed": target}


class ProjectsSkill(BaseSkill):
    name = "projects"
    tools = [
        Tool(
            name="list_projects",
            label="查询项目列表",
            description="获取用户的项目列表，可按状态筛选。返回 id、名称、状态、截止日期、客户、阶段进度。",
            input_schema={
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["pending", "active", "done"],
                        "description": "按状态筛选（不传则返回全部）",
                    }
                },
            },
            handler=_list_projects,
        ),
        Tool(
            name="update_project",
            label="更新项目",
            description="修改项目的状态、截止日期、开始日期、备注、客户名称。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选，已知时用）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字，无需 id）"},
                    "status":     {"type": "string", "enum": ["pending", "active", "done"]},
                    "deadline":   {"type": "string", "description": "截止日期 YYYY-MM-DD"},
                    "start_date": {"type": "string", "description": "开始日期 YYYY-MM-DD"},
                    "client":     {"type": "string", "description": "客户名称"},
                    "notes":      {"type": "string", "description": "备注"},
                    "name":       {"type": "string", "description": "项目名称"},
                },
                "required": [],
            },
            handler=_update_project,
        ),
        Tool(
            name="create_project",
            label="新建项目",
            description="创建新项目。",
            input_schema={
                "type": "object",
                "properties": {
                    "name":       {"type": "string", "description": "项目名称"},
                    "client":     {"type": "string"},
                    "status":     {"type": "string", "enum": ["pending", "active", "done"]},
                    "deadline":   {"type": "string", "description": "YYYY-MM-DD"},
                    "start_date": {"type": "string", "description": "YYYY-MM-DD"},
                    "notes":      {"type": "string"},
                },
                "required": ["name"],
            },
            handler=_create_project,
        ),
        Tool(
            name="update_stage",
            label="更新阶段",
            description="切换项目当前阶段，或勾选/取消某个阶段下的待办事项。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选，已知时用）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字，无需 id）"},
                    "stage": {"type": "string", "description": "目标阶段的名称或 key（切换当前阶段用）"},
                    "todo": {
                        "type": "object",
                        "description": "勾选/取消某条待办",
                        "properties": {
                            "stage": {"type": "string", "description": "待办所在阶段名称或 key"},
                            "text": {"type": "string", "description": "待办文本（支持部分匹配）"},
                            "done": {"type": "boolean", "description": "true=完成，false=取消，默认 true"},
                        },
                        "required": ["text"],
                    },
                },
                "required": [],
            },
            handler=_update_stage,
        ),
        Tool(
            name="set_priority",
            label="设置优先级",
            description="设置项目优先级。传 high/medium/low；传空或 none 清除优先级。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选，已知时用）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字，无需 id）"},
                    "priority": {"type": "string", "enum": ["high", "medium", "low", "none"]},
                },
                "required": ["priority"],
            },
            handler=_set_priority,
        ),
        Tool(
            name="set_color", label="设置项目颜色",
            description="设置项目的颜色（十六进制，如 #A3B1FF）。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字）"},
                    "color": {"type": "string", "description": "颜色，十六进制如 #A3B1FF"},
                },
                "required": ["color"],
            },
            handler=_set_color,
        ),
        Tool(
            name="archive_project",
            label="归档项目",
            description="归档或取消归档项目（可逆，不会删除数据）。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选，已知时用）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字，无需 id）"},
                    "archived": {"type": "boolean", "description": "true=归档，false=取消归档，默认 true"},
                },
                "required": [],
            },
            handler=_archive_project,
        ),
        Tool(
            name="delete_project",
            label="删除项目",
            description="永久删除项目（不可恢复，连带项目文件）。流程：先不带 confirm 调用 → 返回影响详情 → 转达用户征得明确同意 → 带 confirm=true 再调一次执行。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选，已知时用）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字，无需 id）"},
                    "confirm": {"type": "boolean", "description": "确认执行；仅在用户明确同意后置 true"},
                },
                "required": [],
            },
            handler=_delete_project,
            destructive=True,
        ),
        Tool(
            name="get_project", label="项目详情",
            description="获取单个项目的完整结构：状态、日期、客户、备注、当前阶段，以及每个阶段（含 key/label）下的待办列表（含 id/text/done）。管理阶段或待办前先用它看清结构。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字）"},
                },
                "required": [],
            },
            handler=_get_project,
        ),
        Tool(
            name="add_stage", label="新增阶段",
            description="给项目新增一个阶段（追加到末尾，或用 position 指定插入位置）。注意：这是给项目加阶段，不是新建项目。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字）"},
                    "label": {"type": "string", "description": "阶段名称"},
                    "position": {"type": "integer", "description": "插入位置(0起)，不传则追加末尾"},
                },
                "required": ["label"],
            },
            handler=_add_stage,
        ),
        Tool(
            name="remove_stage", label="删除阶段",
            description="删除项目的某个阶段（按阶段名称或 key）。连带该阶段的待办一并移除。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字）"},
                    "stage": {"type": "string", "description": "阶段名称或 key"},
                },
                "required": ["stage"],
            },
            handler=_remove_stage,
        ),
        Tool(
            name="rename_stage", label="重命名阶段",
            description="重命名项目的某个阶段。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字）"},
                    "stage": {"type": "string", "description": "原阶段名称或 key"},
                    "new_label": {"type": "string"},
                },
                "required": ["stage", "new_label"],
            },
            handler=_rename_stage,
        ),
        Tool(
            name="add_todo", label="新增待办",
            description="给项目某阶段新增一条或多条待办（用 texts 数组一次加多条，可用于批量建待办模板）。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字）"},
                    "stage": {"type": "string", "description": "阶段名称或 key"},
                    "texts": {"type": "array", "items": {"type": "string"}, "description": "待办内容列表"},
                },
                "required": ["stage", "texts"],
            },
            handler=_add_todo,
        ),
        Tool(
            name="remove_todo", label="删除待办",
            description="删除项目某阶段下的一条待办（按文本或 id 匹配）。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字）"},
                    "stage": {"type": "string", "description": "阶段名称或 key"},
                    "todo": {"type": "string", "description": "待办文本（支持部分匹配）或 id"},
                },
                "required": ["stage", "todo"],
            },
            handler=_remove_todo,
        ),
    ]


ProjectsSkill().register()
