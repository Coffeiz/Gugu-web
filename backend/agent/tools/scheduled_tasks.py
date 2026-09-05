"""定时任务技能：list / create / update / delete。

到点由调度器把 payload（自然语言指令）交给 agent 执行、按渠道投递（worker 每 ~30s
reconcile 到 APScheduler，新建/改动最多 30s 后生效）。调度字段统一复用
`app.core.schedule_rules`，渠道仍复用 API 层规整逻辑。

少调用设计：create 一次带齐；update/delete 支持**按名字定位**（task），无需先 list；
list 一次返回全部。这些工具不进 RESOURCE_BY_TOOL（单行写入、风险低，不触发自我核实那轮，省调用）。
"""
import json
from typing import Any

from app.api.v1.scheduled_tasks import _norm_channels
from app.core.schedule_rules import (
    ScheduleSpec,
    ScheduleValidationError,
    normalize_schedule,
    schedule_status,
    task_schedule_kind,
)
from app.core.tz import iso_utc
from app.services.scheduled_tasks import (
    create_task,
    delete_task,
    find_tasks,
    get_task,
    list_tasks,
    validate_task_workspace,
    update_task,
    normalize_script_authorization,
)
from agent.security import confirm
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


def _schedule_error(error: ScheduleValidationError) -> str:
    return json.dumps({
        "error": "定时规则校验失败",
        "field": error.field,
        "message": str(error),
    }, ensure_ascii=False)


def _normalize_tool_schedule(args: dict, *, current=None) -> ScheduleSpec | str:
    """使用共享规则校验工具参数，避免 Skill 自己复制一套调度语义。"""
    try:
        if current is None:
            kind = args.get("schedule_kind")
            if kind is None:
                return json.dumps({"error": "创建任务必须提供 schedule_kind：cron 或 interval"}, ensure_ascii=False)
            cron = args.get("cron")
            interval_minutes = args.get("interval_minutes")
            start_at = args.get("start_at")
            end_at = args.get("end_at")
        else:
            kind = args["schedule_kind"] if "schedule_kind" in args else task_schedule_kind(current)
            if kind is None:
                return json.dumps({"error": "schedule_kind 不能为空"}, ensure_ascii=False)
            if kind == "interval":
                cron = args.get("cron") if "cron" in args else None
                interval_minutes = args["interval_minutes"] if "interval_minutes" in args else getattr(current, "interval_minutes", None)
            elif kind == "once":
                cron = args["cron"] if "cron" in args else None
                interval_minutes = args["interval_minutes"] if "interval_minutes" in args else None
            else:
                cron = args["cron"] if "cron" in args else current.cron
                interval_minutes = args["interval_minutes"] if "interval_minutes" in args else None
            start_at = args["start_at"] if "start_at" in args else getattr(current, "start_at", None)
            end_at = args["end_at"] if "end_at" in args else getattr(current, "end_at", None)
        return normalize_schedule(
            schedule_kind=kind,
            cron=cron,
            interval_minutes=interval_minutes,
            start_at=start_at,
            end_at=end_at,
        )
    except ScheduleValidationError as error:
        return _schedule_error(error)


def _to_dict(t: Any) -> dict:
    from app.services.filesystem_authorization import filesystem_authorization_enabled

    kind = task_schedule_kind(t)
    interval_minutes = getattr(t, "interval_minutes", None)
    start_at = getattr(t, "start_at", None)
    end_at = getattr(t, "end_at", None)
    return {
        "id": t.id, "name": t.name,
        "when": f"每 {interval_minutes} 分钟" if kind == "interval" else _humanize_cron(t.cron),
        "schedule_kind": kind,
        "cron": t.cron,
        "interval_minutes": interval_minutes,
        "start_at": iso_utc(start_at) if start_at else None,
        "end_at": iso_utc(end_at) if end_at else None,
        "schedule_status": schedule_status(t),
        "instruction": t.payload,
        "channels": [c for c in (t.channels or "").split(",") if c],
        "enabled": t.enabled,
        "last_run_at": t.last_run_at.isoformat() if t.last_run_at else None,
        "delivery_targets": t.delivery_targets,
        "authorized_tools": t.authorized_tools or [],
        "workspace_id": getattr(t, "workspace_id", None),
        "filesystem_authorized": filesystem_authorization_enabled() and getattr(t, "filesystem_authorization_grant_id", None) is not None,
    }


async def _resolve_delivery_targets(db, user_id, channels, mode: str = "owner_private"):
    """解析任务目标：模型只选择语义模式，不直接填写平台 openid。"""
    channels = list(channels or [])
    if "qq" not in channels:
        return None, None
    if mode == "owner_private":
        from app.scheduled_tasks import owner_private_targets

        return await owner_private_targets(db, user_id, channels), None
    if mode != "current_group":
        return None, json.dumps({"error": "delivery_mode 只能是 owner_private 或 current_group"}, ensure_ascii=False)

    from agent.im import imctx

    current = imctx.get_im()
    if not current or current.get("platform") != "qq" or current.get("chat_type") != "group":
        return None, json.dumps({"error": "只有在 QQ 群聊中才能把定时任务绑定到当前群"}, ensure_ascii=False)
    group_id = current.get("chat_id")
    if not group_id:
        return None, json.dumps({"error": "当前 QQ 群没有可用的 group_openid，任务未创建"}, ensure_ascii=False)
    return {
        "qq": {
            "platform": "qq",
            "chat_type": "group",
            "chat_id": group_id,
            "puid": current.get("puid"),
            "channel_id": current.get("channel_id"),
        }
    }, None


def _group_delivery_mode_required(channels, delivery_mode) -> bool:
    """群聊中的 QQ 任务必须先明确投递到当前群还是 owner 私聊。"""
    if delivery_mode:
        return False
    if "qq" not in (channels or []):
        return False

    from agent.im import imctx

    current = imctx.get_im()
    return bool(
        current
        and current.get("platform") == "qq"
        and current.get("chat_type") == "group"
    )


def _delivery_mode_confirmation_error() -> str:
    return json.dumps({
        "error": "创建 QQ 群聊定时任务前请先确认投递位置：到时发当前群，还是私聊提醒你？",
        "required": "delivery_mode",
        "options": [
            {"value": "current_group", "label": "发到当前群"},
            {"value": "owner_private", "label": "私聊提醒我"},
        ],
    }, ensure_ascii=False)


def _authorized_tools(value) -> list[str]:
    """只接受用户明确勾选的危险工具；默认不授予任何自动权限。"""
    return ["send_email"] if isinstance(value, list) and "send_email" in value else []


def _script_authorization(value):
    try:
        return normalize_script_authorization(value)
    except ValueError as exc:
        raise ValueError(str(exc)) from exc


async def _resolve_task(db, user_id, args):
    """按 task_id 或任务名 task 定位；返回 (task|None, 错误JSON|None)。少调用：可直接按名字操作。"""
    # 日程提醒（event_id 非空）归日历管，咕咕的定时任务工具一律视作「不存在」、不可解析/改/删
    tid = args.get("task_id")
    if tid:
        t = await get_task(db, user_id, tid)
        return (t, None) if t else (None, json.dumps({"error": "定时任务不存在"}, ensure_ascii=False))
    name = args.get("task")
    if name:
        name = str(name).strip()
        rows = await find_tasks(db, user_id, name)
        if not rows:
            avail = [task.name for task in await list_tasks(db, user_id)]
            return None, json.dumps({"error": f"未找到名为「{name}」的定时任务", "available": sorted(set(avail))[:20]}, ensure_ascii=False)
        if len(rows) > 1:
            return None, json.dumps({"error": f"有多个匹配「{name}」的定时任务，请指明是哪个",
                                     "candidates": [{"id": t.id, "name": t.name} for t in rows[:10]]}, ensure_ascii=False)
        return rows[0], None
    return None, json.dumps({"error": "需提供 task_id 或任务名 task"}, ensure_ascii=False)


async def _list_scheduled_tasks(db, user_id, args: dict):
    # 日程提醒与定时任务完全分开：event_id 非空的是活动提醒（归日历管），咕咕的定时任务工具一律不碰
    rows = await list_tasks(db, user_id)
    return [_to_dict(t) for t in rows]


async def _create_scheduled_task(db, user_id, args: dict):
    name = (args.get("name") or "").strip()
    if not name:
        return json.dumps({"error": "需提供任务名 name"}, ensure_ascii=False)
    if args.get("filesystem_authorized") is True:
        from app.services.filesystem_authorization import filesystem_authorization_enabled
        if not filesystem_authorization_enabled():
            return json.dumps({"error": "完整用户沙箱授权功能当前未开启"}, ensure_ascii=False)
    spec = _normalize_tool_schedule(args)
    if isinstance(spec, str):
        return spec
    try:
        script_authorization = _script_authorization(args.get("script_authorization"))
    except ValueError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)
    if script_authorization is not None:
        if script_authorization["root"] == "workspace" and args.get("workspace_id") is None:
            return json.dumps({"error": "workspace 脚本必须绑定 workspace_id"}, ensure_ascii=False)
        if script_authorization["root"] in {"personal", "project"} and args.get("filesystem_authorized") is not True:
            return json.dumps({"error": "personal/project 脚本必须同时申请完整用户沙箱授权"}, ensure_ascii=False)
    try:
        workspace_id = await validate_task_workspace(db, user_id, args.get("workspace_id"))
    except LookupError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)
    if args.get("filesystem_authorized") is True:
        summary = f"允许新建定时任务「{name}」读写整个用户沙箱（包含 /workspace、/personal、/project）"
        blocked = confirm.needs_confirmation(
            args, summary, user_id,
            identity=f"scheduled-task:create-filesystem:{name}:{workspace_id or 'none'}",
            ttl_minutes=10,
            instruction="确认后，该定时任务每次运行都可读写用户沙箱；不包含宿主机目录。",
        )
        if blocked is not None:
            return blocked
    channels = _norm_channels(args.get("channels"))
    delivery_mode = args.get("delivery_mode")
    if _group_delivery_mode_required(channels.split(","), delivery_mode):
        return _delivery_mode_confirmation_error()
    delivery_targets, target_error = await _resolve_delivery_targets(
        db,
        user_id,
        channels.split(","),
        str(delivery_mode or "owner_private"),
    )
    if target_error:
        return target_error
    t = await create_task(
        db, user_id, name=name,
        payload=(args.get("instruction") or "").strip(),
        cron=spec.cron,
        schedule_kind=spec.schedule_kind,
        interval_minutes=spec.interval_minutes,
        start_at=spec.start_at,
        end_at=spec.end_at,
        channels=channels,
        enabled=args.get("enabled", True),
        delivery_targets=delivery_targets,
        authorized_tools=_authorized_tools(args.get("authorized_tools")),
        script_authorization=script_authorization,
        workspace_id=workspace_id,
    )
    if args.get("filesystem_authorized") is True and args.get("enabled", True) is not False:
        from app.services.filesystem_authorization import grant_scheduled_task_filesystem_access
        await grant_scheduled_task_filesystem_access(db, user_id, t.id, granted_by="askuser")
    return {"success": True, "task_id": t.id, **_to_dict(t),
            "note": "最多 30 秒后开始按时触发"}


async def _update_scheduled_task(db, user_id, args: dict):
    t, err = await _resolve_task(db, user_id, args)
    if err:
        return err
    if args.get("filesystem_authorized") is True:
        from app.services.filesystem_authorization import filesystem_authorization_enabled
        if not filesystem_authorization_enabled():
            return json.dumps({"error": "完整用户沙箱授权功能当前未开启"}, ensure_ascii=False)
    schedule_fields = {"schedule_kind", "cron", "interval_minutes", "start_at", "end_at"}
    editable_fields = schedule_fields | {
        "name", "instruction", "channels", "enabled", "delivery_mode", "authorized_tools",
        "workspace_id", "filesystem_authorized",
        "script_authorization",
    }
    if not any(fld in args for fld in editable_fields):
        return json.dumps({"error": "没提供要修改的字段（调度、名称、指令、渠道、启停、工作区或完整沙箱授权），未改动。"}, ensure_ascii=False)
    spec = None
    if args.keys() & schedule_fields:
        spec = _normalize_tool_schedule(args, current=t)
        if isinstance(spec, str):
            return spec
    delivery_targets = None
    next_channels = t.channels
    if "workspace_id" in args:
        try:
            workspace_id = await validate_task_workspace(db, user_id, args["workspace_id"])
        except LookupError as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)
    else:
        workspace_id = getattr(t, "workspace_id", None)
    if args.get("filesystem_authorized") is True and getattr(t, "filesystem_authorization_grant_id", None) is None:
        requested_name = str(args.get("name") or t.name).strip()
        summary = f"允许定时任务「{requested_name}」读写整个用户沙箱（包含 /workspace、/personal、/project）"
        blocked = confirm.needs_confirmation(
            args, summary, user_id,
            identity=f"scheduled-task:filesystem:{t.id}",
            ttl_minutes=10,
            instruction="确认后，该定时任务每次运行都可读写用户沙箱；不包含宿主机目录。",
        )
        if blocked is not None:
            return blocked
    if args.get("channels") is not None or args.get("delivery_mode") is not None:
        delivery_mode = args.get("delivery_mode")
        next_channels = (
            _norm_channels(args["channels"])
            if args.get("channels") is not None
            else t.channels
        )
        if _group_delivery_mode_required(next_channels.split(","), delivery_mode):
            return _delivery_mode_confirmation_error()
        mode = str(delivery_mode or "owner_private")
        delivery_targets, target_error = await _resolve_delivery_targets(
            db, user_id, next_channels.split(","), mode
        )
        if target_error:
            return target_error
    fields = {}
    if spec is not None:
        fields.update({
            "cron": spec.cron,
            "schedule_kind": spec.schedule_kind,
            "interval_minutes": spec.interval_minutes,
            "start_at": spec.start_at,
            "end_at": spec.end_at,
        })
    if args.get("name") is not None:
        fields["name"] = str(args["name"]).strip()
    if args.get("instruction") is not None:
        fields["payload"] = str(args["instruction"]).strip()
    if args.get("channels") is not None or args.get("delivery_mode") is not None:
        if args.get("channels") is not None:
            fields["channels"] = next_channels
        fields["delivery_targets"] = delivery_targets
    if args.get("enabled") is not None:
        fields["enabled"] = bool(args["enabled"])
    if args.get("authorized_tools") is not None:
        fields["authorized_tools"] = _authorized_tools(args["authorized_tools"])
    elif any(field in args for field in ("instruction", "schedule_kind", "cron", "interval_minutes", "start_at", "end_at", "channels", "delivery_mode")):
        fields["authorized_tools"] = []
    if "workspace_id" in args:
        fields["workspace_id"] = workspace_id
    if "script_authorization" in args:
        try:
            script_authorization = _script_authorization(args["script_authorization"])
        except ValueError as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)
        if script_authorization is not None:
            if script_authorization["root"] == "workspace" and workspace_id is None:
                return json.dumps({"error": "workspace 脚本必须绑定 workspace_id"}, ensure_ascii=False)
            if script_authorization["root"] in {"personal", "project"} and args.get("filesystem_authorized") is not True and not getattr(t, "filesystem_authorization_grant_id", None):
                return json.dumps({"error": "personal/project 脚本必须拥有完整用户沙箱授权"}, ensure_ascii=False)
        fields["script_authorization"] = script_authorization
    elif "workspace_id" in args and getattr(t, "script_authorization", None):
        current_script = t.script_authorization
        if current_script.get("root") == "workspace" and workspace_id != getattr(t, "workspace_id", None):
            fields["script_authorization"] = None
    t = await update_task(db, t, fields)
    if args.get("enabled") is False:
        # 停用任务即让任务级完整授权失效；保留 grant 审计记录，不等到下一次触发才处理。
        from app.services.filesystem_authorization import revoke_scheduled_task_filesystem_access
        await revoke_scheduled_task_filesystem_access(db, user_id, t.id)
    elif args.get("filesystem_authorized") is True:
        from app.services.filesystem_authorization import grant_scheduled_task_filesystem_access
        await grant_scheduled_task_filesystem_access(db, user_id, t.id, granted_by="askuser")
    elif args.get("filesystem_authorized") is False:
        from app.services.filesystem_authorization import revoke_scheduled_task_filesystem_access
        await revoke_scheduled_task_filesystem_access(db, user_id, t.id)
    return {"success": True, **_to_dict(t)}


async def _delete_scheduled_task(db, user_id, args: dict):
    task_ids = args.get("task_ids")
    if task_ids is not None:
        if not isinstance(task_ids, list) or not task_ids or len(task_ids) > 50:
            return json.dumps({"error": "task_ids 必须是 1-50 个任务 id"})
        tasks = []
        for tid in task_ids:
            task = await get_task(db, user_id, tid)
            if task is None:
                return json.dumps({"error": f"定时任务 {tid} 不存在"})
            tasks.append(task)
        names = "、".join(t.name for t in tasks[:10]) + (f"等 {len(tasks)} 个" if len(tasks) > 10 else "")
        blocked = confirm.needs_confirmation(args, f"将删除定时任务：{names}，共 {len(tasks)} 个", user_id,
                                             identity=f"delete_scheduled_task:task_ids={sorted(task_ids)}")
        if blocked is not None:
            return blocked
        results = [dict(zip(("deleted_task_id", "name"), await delete_task(db, task))) for task in tasks]
        await db.commit()
        return {"success": True, "deleted_count": len(results), "results": results}
    t, err = await _resolve_task(db, user_id, args)
    if err:
        return err
    blocked = confirm.needs_confirmation(args, f"将删除定时任务「{t.name}」（{_humanize_cron(t.cron)}）", user_id,
                                         identity=f"delete_scheduled_task:task_id={t.id}")
    if blocked is not None:
        return blocked
    tid, name = await delete_task(db, t)
    return {"success": True, "deleted_task_id": tid, "name": name}


class ScheduledTasksSkill(BaseSkill):
    name = "scheduled_tasks"
    tools = [
        Tool(
            name="list_scheduled_tasks", label="查看定时任务",
            description_short='查看独立定时任务；不包含日历活动提醒',
            description=("列出我的全部独立定时任务（含 id、名称、触发时间、指令、投递渠道、是否启用、上次执行）。一次返回全部。"
                         "注意：日历活动的提醒不在此列——那是活动自带、在日历里单独管理，与定时任务两套互不影响。"),
            input_schema={"type": "object", "properties": {}},
            handler=_list_scheduled_tasks,
        ),
        Tool(
            name="create_scheduled_task", label="新建定时任务",
            description_short='创建定时任务；支持邮件、站内通知和 QQ 私聊或群聊投递。',
            description="创建独立定时任务并按渠道投递。schedule_kind=once 时只传 start_at，在指定时间执行一次，成功投递后自动移除；schedule_kind=cron 时传合法 cron（Asia/Shanghai）；schedule_kind=interval 时只传 interval_minutes（1-60），间隔从 start_at 锚定，不按整点重新对齐。cron/interval 的 start_at/end_at 可分别省略，也可传 ISO 日期时间；end_at 含边界，任务到期后自动停用。可选 workspace_id 绑定用户自己的工作区；绑定后任务从 workspace 根目录执行并可读写整个 workspace。filesystem_authorized=true 会单独请求确认，确认后任务才可读写 /personal 和 /project；不要传目录级授权参数。只有用户明确授权时才传 authorized_tools=[send_email]，否则到点调用邮件工具仍需确认。日历活动提醒请用 create_event(reminders) 或 add_event_reminder。工具成功回执中的 task_id、schedule_status 才是事实来源。",
            input_schema={
                "type": "object",
                "properties": {
                    "name":        {"type": "string"},
                    "instruction": {"type": "string"},
                    "schedule_kind": {"type": "string", "enum": ["cron", "interval", "once"]},
                    "cron":        {"type": ["string", "null"]},
                    "interval_minutes": {"type": ["integer", "null"], "minimum": 1, "maximum": 60},
                    "start_at": {"type": ["string", "null"], "format": "date-time"},
                    "end_at": {"type": ["string", "null"], "format": "date-time"},
                    "channels":    {"type": "array", "items": {"type": "string", "enum": ["web", "email", "feishu", "qq"]},
                                    "minItems": 1, "uniqueItems": True},
                    "enabled":     {"type": "boolean"},
                    "delivery_mode": {"type": "string", "enum": ["owner_private", "current_group"]},
                    "authorized_tools": {"type": "array", "items": {"type": "string", "enum": ["send_email"]}, "uniqueItems": True},
                    "workspace_id": {"type": ["integer", "null"]},
                    "filesystem_authorized": {"type": "boolean"},
                    "script_authorization": {"type": ["object", "null"], "properties": {
                        "root": {"type": "string", "enum": ["workspace", "personal", "project"]},
                        "script_path": {"type": "string"},
                        "interpreter": {"type": "string", "enum": ["python3", "node", "bash"]},
                        "args": {"type": "array", "items": {"type": "string"}, "maxItems": 32},
                    }, "required": ["root", "script_path", "interpreter"]},
                },
                "required": ["name", "instruction", "schedule_kind"],
            },
            handler=_create_scheduled_task,
            mutates=True,
        ),
        Tool(
            name="update_scheduled_task", label="更新定时任务",
            description_short='修改定时任务；可调整执行计划和 QQ 投递范围。',
            description="修改定时任务内容、投递渠道、启停、调度窗口或 workspace；按 task_id 或 task 定位。修改调度类型时必须同时提供新类型所需字段。schedule_kind=once 时提供 start_at 并清除 end_at；schedule_kind=cron 时提供 cron；schedule_kind=interval 时提供 interval_minutes（1-60），间隔从 start_at 锚定。start_at/end_at 省略表示不修改，显式传 null 表示清除；workspace_id 显式传 null 会解除绑定，绑定后任务从 workspace 根目录执行并可读写整个 workspace。filesystem_authorized=true/false 仅用于显式申请或撤销完整用户沙箱授权，true 必须经过确认；不要传目录级授权参数。只有用户明确授权时才传 authorized_tools=[send_email]。",
            input_schema={
                "type": "object",
                "properties": {
                    "task_id":     {"type": "integer"},
                    "task":        {"type": "string"},
                    "name":        {"type": "string"},
                    "instruction": {"type": "string"},
                    "schedule_kind": {"type": ["string", "null"], "enum": ["cron", "interval", "once", None]},
                    "cron":        {"type": ["string", "null"]},
                    "interval_minutes": {"type": ["integer", "null"], "minimum": 1, "maximum": 60},
                    "start_at": {"type": ["string", "null"], "format": "date-time"},
                    "end_at": {"type": ["string", "null"], "format": "date-time"},
                    "channels":    {"type": "array", "items": {"type": "string", "enum": ["web", "email", "feishu", "qq"]},
                                    "minItems": 1, "uniqueItems": True},
                    "enabled":     {"type": "boolean"},
                    "delivery_mode": {"type": "string", "enum": ["owner_private", "current_group"]},
                    "authorized_tools": {"type": "array", "items": {"type": "string", "enum": ["send_email"]}, "uniqueItems": True},
                    "workspace_id": {"type": ["integer", "null"]},
                    "filesystem_authorized": {"type": "boolean"},
                    "script_authorization": {"type": ["object", "null"], "properties": {
                        "root": {"type": "string", "enum": ["workspace", "personal", "project"]},
                        "script_path": {"type": "string"},
                        "interpreter": {"type": "string", "enum": ["python3", "node", "bash"]},
                        "args": {"type": "array", "items": {"type": "string"}, "maxItems": 32},
                    }, "required": ["root", "script_path", "interpreter"]},
                },
                "required": [],
            },
            handler=_update_scheduled_task,
            mutates=True,
        ),
        Tool(
            name="delete_scheduled_task", label="删除定时任务",
            description_short='删除定时任务。',
            description="删除定时任务，不可恢复；单项传 task_id/task，批量传 task_ids。确认后直接再次调用即可，无需携带凭证。",
            input_schema={
                "type": "object",
                "properties": {
                    "task_id": {"type": "integer"},
                    "task":    {"type": "string"},
                    "task_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 50},
                },
                "required": [],
            },
            handler=_delete_scheduled_task,
            mutates=True,
            destructive=True,
        ),
    ]


ScheduledTasksSkill().register()
