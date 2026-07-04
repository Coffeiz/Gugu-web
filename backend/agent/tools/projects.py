"""项目领域技能：list_projects / create_project / update_project。

逻辑迁自原 agent.py 的 `_exec_tool`，一字不改（含 user_id 所有权校验、
done_at 处理）。
"""
import json
import random
from datetime import datetime, timedelta

from sqlalchemy import func, select, update

from app.models import File, Project

_COLOR_PRESETS = [
    "linear-gradient(135deg,#c8aa72,#b88060)",
    "linear-gradient(135deg,#8fbe8b,#7ab8a8)",
    "linear-gradient(135deg,#7ab8a8,#7ab8c8)",
    "linear-gradient(135deg,#7ab8c8,#7b7fb2)",
    "linear-gradient(135deg,#5e73b2,#7b7fb2)",
    "linear-gradient(135deg,#7b7fb2,#c4afc8)",
    "linear-gradient(135deg,#c4afc8,#b07090)",
    "linear-gradient(135deg,#be8b8f,#c8aa72)",
]
from agent import confirm
from agent.tools.base import BaseSkill, Tool


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
    if "status" in args:
        if args["status"] == "done" and p.done_at is None:
            p.done_at = datetime.utcnow()
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
            p.stages = stages   # 触发 setter 持久化 stages_json
            if stages:
                p.current_stage = stages[-1].get("key")
            p.progress = 100
        p.status = args["status"]
    if "priority" in args:
        pr = (args.get("priority") or "").strip().lower()
        p.priority = pr if pr in ("high", "medium", "low") else None
    for field in ("deadline", "start_date", "client", "name"):
        if field in args:
            setattr(p, field, args[field])
    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "name": p.name, "priority": p.priority}


_DEFAULT_STAGES = [
    {"key": "s0", "label": "计划", "todos": []},
    {"key": "s1", "label": "执行", "todos": []},
    {"key": "s2", "label": "交付", "todos": []},
]


def _build_stages(raw: list) -> list:
    """把 ['计划','执行'] 或 [{'label':'开发','todos':['a','b']}] 规范成
    [{key, label, todos:[{id,text,done}]}]，重排 key(s0..)/todo id(t1..)。"""
    out, tnum = [], 0
    for i, item in enumerate(raw or []):
        if isinstance(item, str):
            label, todo_src = item, []
        elif isinstance(item, dict):
            label = item.get("label") or item.get("name") or ""
            todo_src = item.get("todos") or []
        else:
            continue
        label = str(label).strip()
        if not label:
            continue
        todos = []
        for t in todo_src:
            txt = (t.get("text") if isinstance(t, dict) else t)
            if not str(txt or "").strip():
                continue
            tnum += 1
            todos.append({"id": f"t{tnum}", "text": str(txt),
                          "done": bool(t.get("done")) if isinstance(t, dict) else False})
        out.append({"key": f"s{i}", "label": label, "todos": todos})
    return out


async def _pick_unused_color(db, user_id) -> str:
    rows = (await db.execute(
        select(Project.color).where(Project.user_id == user_id)
    )).scalars().all()
    used = set(rows)
    unused = [c for c in _COLOR_PRESETS if c not in used]
    pool = unused if unused else _COLOR_PRESETS
    return random.choice(pool)


async def _create_project(db, user_id, args: dict):
    # 自定义阶段：stages 可为 ["计划","执行"] 或 [{"label":..,"todos":[..]}]，不传用默认三段
    raw = args.get("stages")
    stages = _build_stages(raw) if raw else [dict(s) for s in _DEFAULT_STAGES]
    if not stages:
        stages = [dict(s) for s in _DEFAULT_STAGES]
    # 未指定开始日期默认今天，未指定截止默认一周后（与上下文「今天」同口径用 datetime.now）
    _now = datetime.now()
    start_date = args.get("start_date") or _now.strftime("%Y-%m-%d")
    deadline = args.get("deadline") or (_now + timedelta(days=7)).strftime("%Y-%m-%d")
    priority = (args.get("priority") or "").strip().lower()
    p = Project(
        user_id=user_id,
        name=args["name"],
        client=args.get("client"),
        status=args.get("status", "pending"),
        deadline=deadline,
        start_date=start_date,
        color=args.get("color") or await _pick_unused_color(db, user_id),
        priority=priority if priority in ("high", "medium", "low") else None,
        stages_json=json.dumps(stages, ensure_ascii=False),
        current_stage=stages[0]["key"],
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
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
        p.current_stage = match["key"]
        changed = True

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
        p.stages = stages  # 回写 stages_json
        changed = True

    if not changed:
        return json.dumps({"error": "未指定 stage 或 todo，无操作"})

    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "current_stage": p.current_stage}


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
    # 文件软删（置 deleted_at），文件夹随项目 FK CASCADE 自动删
    await db.execute(
        update(File)
        .where(File.project_id == pid, File.user_id == user_id, File.deleted_at.is_(None))
        .values(deleted_at=datetime.utcnow())
    )
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


async def _set_stages(db, user_id, args: dict):
    """整体替换项目阶段（声明式：给出想要的完整阶段列表，增删改排序一次到位）。
    同名阶段的待办默认保留（本次没给该阶段 todos 时）；给了 todos 则以本次为准。"""
    p, _err = await _resolve_project(db, user_id, args)
    if _err:
        return _err
    raw = args.get("stages")
    if not isinstance(raw, list) or not raw:
        return json.dumps({"error": '需提供 stages 列表，如 ["需求","开发"] 或 [{"label":"开发","todos":["接口"]}]'})

    old = p.stages
    old_by_label = {s.get("label"): s for s in old}
    new_stages, tnum = [], 0
    for i, item in enumerate(raw):
        if isinstance(item, str):
            label, todo_src, gave_todos = item, [], False
        elif isinstance(item, dict):
            label = item.get("label") or item.get("name") or ""
            todo_src = item.get("todos") or []
            gave_todos = "todos" in item
        else:
            continue
        label = str(label).strip()
        if not label:
            continue
        # todos：本次给了就用本次；没给但旧的同名阶段有，则保留旧的（改名/重排不丢待办）
        if gave_todos:
            src = [{"text": (t.get("text") if isinstance(t, dict) else t),
                    "done": bool(t.get("done")) if isinstance(t, dict) else False} for t in todo_src]
        elif label in old_by_label:
            src = [{"text": t.get("text"), "done": t.get("done", False)}
                   for t in old_by_label[label].get("todos", [])]
        else:
            src = []
        todos = []
        for t in src:
            if not str(t.get("text") or "").strip():
                continue
            tnum += 1
            todos.append({"id": f"t{tnum}", "text": str(t["text"]), "done": bool(t.get("done"))})
        new_stages.append({"key": f"s{i}", "label": label, "todos": todos})

    if not new_stages:
        return json.dumps({"error": "stages 解析后为空"})
    # current_stage：保留同名阶段，否则落到第一阶段
    old_cur = next((s for s in old if s.get("key") == p.current_stage), None)
    cur_label = old_cur.get("label") if old_cur else None
    p.current_stage = next((s["key"] for s in new_stages if s["label"] == cur_label), new_stages[0]["key"])
    p.stages = new_stages
    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "stages": [s["label"] for s in new_stages]}


async def _update_todo(db, user_id, args: dict):
    """改一条待办的文本/完成态，并可选移动到另一阶段。按文本或 id 定位（可用 stage 限定范围）。"""
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
        dest = _find_stage(stages, to)
        if not dest:
            return json.dumps({"error": f"目标阶段不存在: {to}",
                               "available": [s.get("label") for s in stages]})
        if dest is not found_stage:
            found_stage["todos"] = [t for t in found_stage.get("todos", []) if t is not found]
            dest.setdefault("todos", []).append(found)

    p.stages = stages
    p.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "project_id": p.id, "todo": found.get("text"),
            "done": found.get("done"), "stage": dest.get("label")}


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
            description="修改项目的状态、截止日期、开始日期、客户名称、优先级。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选，已知时用）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字，无需 id）"},
                    "status":     {"type": "string", "enum": ["pending", "active", "done"]},
                    "deadline":   {"type": "string", "description": "截止日期 YYYY-MM-DD"},
                    "start_date": {"type": "string", "description": "开始日期 YYYY-MM-DD"},
                    "client":     {"type": "string", "description": "客户名称"},
                    "name":       {"type": "string", "description": "项目名称"},
                    "priority":   {"type": "string", "enum": ["high", "medium", "low", "none"], "description": "优先级；传空或 none 清除"},
                },
                "required": [],
            },
            handler=_update_project,
        ),
        Tool(
            name="create_project",
            label="新建项目",
            description="创建新项目，可一次性带上自定义阶段和待办（无需再逐个 add_stage/add_todo）。用户没明确说日期时不用追问：开始日期默认今天、截止日期默认一周后；不传 stages 用默认「计划/执行/交付」三段。\n\n颜色（color）：不传则随机从预设中选。如果能从上下文清楚判断项目类型（如设计、开发、运营、拍摄等），直接选一个合适色系创建，无需追问。如果类型模糊或无法推断，在调用工具前先问一句，给出 2~3 个色系选项让用户选（如「暖橙金 / 薰衣草紫 / 薄荷绿，你倾向哪种风格？」），拿到答案后再建。\n\n优先级（priority）：不传则不设（None），不是每个项目都要有优先级，别为了凑一个值追问。分三种情况：① 对话里有明确的紧急/重要信号（如「赶紧」「很急」「不着急」），直接给一个合理优先级、顺带说一句判断依据，无需追问；② 看起来是个分量不轻的项目（阶段多、周期长、涉及客户交付等）但语气里判断不出紧急程度，创建前顺口问一句要不要标个优先级、可以带上你的推荐（如「这个项目看起来分量不小，要标成高优先级吗？」），别问开放式的「优先级是什么」；③ 明显是日常小事/临时任务，不问不设，别打扰。",
            input_schema={
                "type": "object",
                "properties": {
                    "name":       {"type": "string", "description": "项目名称"},
                    "client":     {"type": "string"},
                    "status":     {"type": "string", "enum": ["pending", "active", "done"]},
                    "deadline":   {"type": "string", "description": "YYYY-MM-DD；不填默认一周后"},
                    "start_date": {"type": "string", "description": "YYYY-MM-DD；不填默认今天"},
                    "color":      {"type": "string", "description": "渐变色字符串，如 linear-gradient(135deg,#7b7fb2,#c4afc8)；不传则随机从预设中选"},
                    "priority":   {"type": "string", "enum": ["high", "medium", "low"], "description": "优先级；不传则不设"},
                    "stages": {
                        "type": "array",
                        "description": '自定义阶段（按顺序）。两种写法：纯名称 ["需求","开发","测试"]，或带待办 [{"label":"开发","todos":["接口","联调"]}]。',
                        "items": {
                            "type": ["string", "object"],
                            "properties": {
                                "label": {"type": "string"},
                                "todos": {"type": "array", "items": {"type": "string"}},
                            },
                        },
                    },
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
            description="获取单个项目的完整结构：状态、日期、客户、当前阶段，以及每个阶段（含 key/label）下的待办列表（含 id/text/done）。管理阶段或待办前先用它看清结构。",
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
        Tool(
            name="set_stages", label="整体设置阶段",
            description="一次性把项目的阶段设成你想要的完整列表（增/删/改名/重排序一步到位，声明式）。同名阶段的待办会自动保留（除非你本次给了该阶段的 todos 则以本次为准）。适合重排或大改结构；只动一个阶段用 add_stage/rename_stage 即可。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字）"},
                    "stages": {
                        "type": "array",
                        "description": '想要的完整阶段列表（按顺序）。纯名称 ["需求","开发"] 或带待办 [{"label":"开发","todos":["接口"]}]。',
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
        ),
        Tool(
            name="update_todo", label="修改待办",
            description="改一条待办的文本或完成状态，并可选移动到另一个阶段（to_stage）。按文本（部分匹配）或 id 定位，可用 stage 限定查找范围。",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "项目 ID（可选）"},
                    "project": {"type": "string", "description": "项目名称（推荐：直接用名字）"},
                    "todo": {"type": "string", "description": "要改的待办：文本（部分匹配）或 id"},
                    "stage": {"type": "string", "description": "待办所在阶段（可选，缩小查找范围）"},
                    "text": {"type": "string", "description": "新文本（可选）"},
                    "done": {"type": "boolean", "description": "完成态（可选）"},
                    "to_stage": {"type": "string", "description": "移动到的目标阶段名称或 key（可选）"},
                },
                "required": ["todo"],
            },
            handler=_update_todo,
        ),
    ]


ProjectsSkill().register()
