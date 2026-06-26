"""定时任务技能：list / create / update / delete。

到点由调度器把 payload（自然语言指令）交给 agent 执行、按渠道投递（worker 每 ~30s
reconcile 到 APScheduler，新建/改动最多 30s 后生效）。复用 API 层的 cron 校验与渠道
规整（`app.api.v1.scheduled_tasks`）。

少调用设计：create 一次带齐；update/delete 支持**按名字定位**（task），无需先 list；
list 一次返回全部。这些工具不进 RESOURCE_BY_TOOL（单行写入、风险低，不触发自我核实那轮，省调用）。
"""
import json

from sqlalchemy import select
from fastapi import HTTPException

from app.models import ScheduledTask
from app.api.v1.scheduled_tasks import _validate_cron, _norm_channels
from agent import confirm
from agent.tools.base import BaseSkill, Tool

_WEEK = {"0": "周日", "1": "周一", "2": "周二", "3": "周三", "4": "周四", "5": "周五", "6": "周六", "7": "周日"}


def _humanize_cron(cron: str) -> str:
    """cron → 人话（给用户看，别把 cron 串暴露出去）。复杂的原样返回。"""
    cron = cron or ""
    if cron.startswith("@once:"):
        return "一次性 " + cron[6:].replace("T", " ")
    parts = cron.split()
    if len(parts) != 5:
        return cron
    m, h, dom, mon, dow = parts
    tm = f"{int(h):02d}:{int(m):02d}" if h.isdigit() and m.isdigit() else f"{h}:{m}"
    if dom == "*" and mon == "*" and dow == "*":
        return f"每天 {tm}"
    if dom == "*" and mon == "*" and dow in _WEEK:
        return f"每{_WEEK[dow]} {tm}"
    if dow == "*" and mon == "*" and dom.isdigit():
        return f"每月{dom}号 {tm}"
    return cron


def _check_cron(cron: str):
    """校验 cron / @once，非法返回错误 JSON，合法返回 None。"""
    try:
        _validate_cron(cron)
        return None
    except HTTPException as e:
        return json.dumps({"error": f"时间格式不对：{e.detail}"}, ensure_ascii=False)


def _to_dict(t: ScheduledTask) -> dict:
    return {
        "id": t.id, "name": t.name, "when": _humanize_cron(t.cron),
        "instruction": t.payload,
        "channels": [c for c in (t.channels or "").split(",") if c],
        "enabled": t.enabled,
        "last_run_at": t.last_run_at.isoformat() if t.last_run_at else None,
    }


async def _resolve_task(db, user_id, args):
    """按 task_id 或任务名 task 定位；返回 (task|None, 错误JSON|None)。少调用：可直接按名字操作。"""
    tid = args.get("task_id")
    if tid:
        t = await db.get(ScheduledTask, tid)
        return (t, None) if (t and t.user_id == user_id) else (None, json.dumps({"error": "定时任务不存在"}, ensure_ascii=False))
    name = args.get("task")
    if name:
        name = str(name).strip()
        rows = (await db.execute(
            select(ScheduledTask).where(ScheduledTask.user_id == user_id, ScheduledTask.name == name)
        )).scalars().all()
        if not rows:
            rows = (await db.execute(
                select(ScheduledTask).where(ScheduledTask.user_id == user_id, ScheduledTask.name.ilike(f"%{name}%"))
            )).scalars().all()
        if not rows:
            avail = (await db.execute(
                select(ScheduledTask.name).where(ScheduledTask.user_id == user_id)
            )).scalars().all()
            return None, json.dumps({"error": f"未找到名为「{name}」的定时任务", "available": sorted(set(avail))[:20]}, ensure_ascii=False)
        if len(rows) > 1:
            return None, json.dumps({"error": f"有多个匹配「{name}」的定时任务，请指明是哪个",
                                     "candidates": [{"id": t.id, "name": t.name} for t in rows[:10]]}, ensure_ascii=False)
        return rows[0], None
    return None, json.dumps({"error": "需提供 task_id 或任务名 task"}, ensure_ascii=False)


async def _list_scheduled_tasks(db, user_id, args: dict):
    rows = (await db.execute(
        select(ScheduledTask).where(ScheduledTask.user_id == user_id).order_by(ScheduledTask.id.desc())
    )).scalars().all()
    return [_to_dict(t) for t in rows]


async def _create_scheduled_task(db, user_id, args: dict):
    name = (args.get("name") or "").strip()
    if not name:
        return json.dumps({"error": "需提供任务名 name"}, ensure_ascii=False)
    cron = (args.get("cron") or "").strip()
    err = _check_cron(cron)
    if err:
        return err
    t = ScheduledTask(
        user_id=user_id, name=name,
        payload=(args.get("instruction") or "").strip(),
        cron=cron,
        channels=_norm_channels(args.get("channels")),
        enabled=args.get("enabled", True),
    )
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return {"success": True, "task_id": t.id, **_to_dict(t),
            "note": "最多 30 秒后开始按时触发"}


async def _update_scheduled_task(db, user_id, args: dict):
    t, err = await _resolve_task(db, user_id, args)
    if err:
        return err
    if args.get("cron") is not None:
        c = _check_cron(str(args["cron"]).strip())
        if c:
            return c
        t.cron = str(args["cron"]).strip()
    if args.get("name") is not None:
        t.name = str(args["name"]).strip()
    if args.get("instruction") is not None:
        t.payload = str(args["instruction"]).strip()
    if args.get("channels") is not None:
        t.channels = _norm_channels(args["channels"])
    if args.get("enabled") is not None:
        t.enabled = bool(args["enabled"])
    await db.commit()
    await db.refresh(t)
    return {"success": True, **_to_dict(t)}


async def _delete_scheduled_task(db, user_id, args: dict):
    t, err = await _resolve_task(db, user_id, args)
    if err:
        return err
    blocked = confirm.needs_confirmation(args, f"将删除定时任务「{t.name}」（{_humanize_cron(t.cron)}）")
    if blocked is not None:
        return blocked
    tid, name = t.id, t.name
    await db.delete(t)
    await db.commit()
    return {"success": True, "deleted_task_id": tid, "name": name}


_CRON_HINT = ("时间用 cron「分 时 日 月 周」(Asia/Shanghai)：每天9点=`0 9 * * *`、每周一9点=`0 9 * * 1`、"
              "每月1号10点=`0 10 1 * *`、每个工作日18点=`0 18 * * 1-5`；只跑一次用 `@once:2026-06-30T09:00`。")


class ScheduledTasksSkill(BaseSkill):
    name = "scheduled_tasks"
    tools = [
        Tool(
            name="list_scheduled_tasks", label="查看定时任务",
            description="列出我的全部定时任务（含 id、名称、触发时间、指令、投递渠道、是否启用、上次执行）。一次返回全部。",
            input_schema={"type": "object", "properties": {}},
            handler=_list_scheduled_tasks,
        ),
        Tool(
            name="create_scheduled_task", label="新建定时任务",
            description=("创建一个定时任务：到点自动按 instruction 执行并把结果投递给用户。一次带齐参数即可，无需多轮。\n"
                         + _CRON_HINT
                         + "\n渠道 channels：web(站内通知,默认) / feishu / qq；设 feishu/qq 前先确认用户已绑定对应 IM，否则会投递失败。"),
            input_schema={
                "type": "object",
                "properties": {
                    "name":        {"type": "string", "description": "任务名（简短）"},
                    "instruction": {"type": "string", "description": "到点要做的事，自然语言指令（如「汇总今天到期的待办发我」）"},
                    "cron":        {"type": "string", "description": "cron「分 时 日 月 周」或 @once:<ISO>，时区 Asia/Shanghai"},
                    "channels":    {"type": "array", "items": {"type": "string", "enum": ["web", "feishu", "qq"]},
                                    "description": "投递渠道，默认 [web]"},
                    "enabled":     {"type": "boolean", "description": "是否启用，默认 true"},
                },
                "required": ["name", "instruction", "cron"],
            },
            handler=_create_scheduled_task,
        ),
        Tool(
            name="update_scheduled_task", label="更新定时任务",
            description=("改定时任务的内容或启停。按 task_id 或任务名 task 定位（推荐直接用名字，免得先查）。"
                         "改时间同样用 cron/@once。停用传 enabled=false、启用传 true。"),
            input_schema={
                "type": "object",
                "properties": {
                    "task_id":     {"type": "integer", "description": "任务 ID（可选，已知时用）"},
                    "task":        {"type": "string", "description": "任务名（推荐：直接用名字定位）"},
                    "name":        {"type": "string", "description": "改名（可选）"},
                    "instruction": {"type": "string", "description": "改指令（可选）"},
                    "cron":        {"type": "string", "description": "改触发时间，cron 或 @once:<ISO>（可选）"},
                    "channels":    {"type": "array", "items": {"type": "string", "enum": ["web", "feishu", "qq"]},
                                    "description": "改投递渠道（可选）"},
                    "enabled":     {"type": "boolean", "description": "启用/停用（可选）"},
                },
                "required": [],
            },
            handler=_update_scheduled_task,
        ),
        Tool(
            name="delete_scheduled_task", label="删除定时任务",
            description=("删除定时任务（不可恢复）。按 task_id 或任务名 task 定位。"
                         "流程：先不带 confirm 调用 → 返回要删的任务 → 转达用户征得明确同意 → 带 confirm=true 再调一次执行。"),
            input_schema={
                "type": "object",
                "properties": {
                    "task_id": {"type": "integer", "description": "任务 ID（可选）"},
                    "task":    {"type": "string", "description": "任务名（推荐：直接用名字）"},
                    "confirm": {"type": "boolean", "description": "确认执行；仅在用户明确同意后置 true"},
                },
                "required": [],
            },
            handler=_delete_scheduled_task,
            destructive=True,
        ),
    ]


ScheduledTasksSkill().register()
