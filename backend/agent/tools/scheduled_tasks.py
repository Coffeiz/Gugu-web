"""定时任务技能：list / create / update / delete。

到点由调度器把 payload（自然语言指令）交给 agent 执行、按渠道投递（worker 每 ~30s
reconcile 到 APScheduler，新建/改动最多 30s 后生效）。复用 API 层的 cron 校验与渠道
规整（`app.api.v1.scheduled_tasks`）。

少调用设计：create 一次带齐；update/delete 支持**按名字定位**（task），无需先 list；
list 一次返回全部。这些工具不进 RESOURCE_BY_TOOL（单行写入、风险低，不触发自我核实那轮，省调用）。
"""
import json
from typing import Any

from fastapi import HTTPException

from app.api.v1.scheduled_tasks import _validate_cron, _norm_channels
from app.services.scheduled_tasks import (
    create_task,
    delete_task,
    find_tasks,
    get_task,
    list_tasks,
    update_task,
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


def _check_cron(cron: str):
    """校验 cron / @once，非法返回错误 JSON，合法返回 None。"""
    try:
        _validate_cron(cron)
        return None
    except HTTPException as e:
        return json.dumps({"error": f"时间格式不对：{e.detail}"}, ensure_ascii=False)


def _to_dict(t: Any) -> dict:
    return {
        "id": t.id, "name": t.name, "when": _humanize_cron(t.cron),
        "instruction": t.payload,
        "channels": [c for c in (t.channels or "").split(",") if c],
        "enabled": t.enabled,
        "last_run_at": t.last_run_at.isoformat() if t.last_run_at else None,
        "delivery_targets": t.delivery_targets,
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
    cron = (args.get("cron") or "").strip()
    err = _check_cron(cron)
    if err:
        return err
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
        cron=cron,
        channels=channels,
        enabled=args.get("enabled", True),
        delivery_targets=delivery_targets,
    )
    return {"success": True, "task_id": t.id, **_to_dict(t),
            "note": "最多 30 秒后开始按时触发"}


async def _update_scheduled_task(db, user_id, args: dict):
    t, err = await _resolve_task(db, user_id, args)
    if err:
        return err
    if not any(args.get(fld) is not None for fld in ("cron", "name", "instruction", "channels", "enabled", "delivery_mode")):
        return json.dumps({"error": "没提供要修改的字段（cron/name/instruction/channels/enabled），未改动。"})
    delivery_targets = None
    next_channels = t.channels
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
    if args.get("cron") is not None:
        c = _check_cron(str(args["cron"]).strip())
        if c:
            return c
        fields["cron"] = str(args["cron"]).strip()
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
    t = await update_task(db, t, fields)
    return {"success": True, **_to_dict(t)}


async def _delete_scheduled_task(db, user_id, args: dict):
    t, err = await _resolve_task(db, user_id, args)
    if err:
        return err
    blocked = confirm.needs_confirmation(args, f"将删除定时任务「{t.name}」（{_humanize_cron(t.cron)}）", user_id)
    if blocked is not None:
        return blocked
    tid, name = await delete_task(db, t)
    return {"success": True, "deleted_task_id": tid, "name": name}


_CRON_HINT = ("时间用 cron「分 时 日 月 周」(Asia/Shanghai)：每天9点=`0 9 * * *`、每周一9点=`0 9 * * 1`、"
              "每月1号10点=`0 10 1 * *`、每个工作日18点=`0 18 * * 1-5`；只跑一次用 `@once:2026-06-30T09:00`。")


class ScheduledTasksSkill(BaseSkill):
    name = "scheduled_tasks"
    tools = [
        Tool(
            name="list_scheduled_tasks", label="查看定时任务",
            description=("列出我的全部独立定时任务（含 id、名称、触发时间、指令、投递渠道、是否启用、上次执行）。一次返回全部。"
                         "注意：日历活动的提醒不在此列——那是活动自带、在日历里单独管理，与定时任务两套互不影响。"),
            input_schema={"type": "object", "properties": {}},
            handler=_list_scheduled_tasks,
        ),
        Tool(
            name="create_scheduled_task", label="新建定时任务",
            description=("创建一个定时任务：到点自动按 instruction 执行并把结果投递给用户。一次带齐参数即可，无需多轮。"
                         "（这是独立定时任务；若是给某个日历活动定提醒，改用日历的 create_event(reminders) 或 add_event_reminder，"
                         "那种会绑定到活动、在活动卡里管理。跟活动无关的普通提醒/任务才用这个。两套互不影响。）\n"
                         + _CRON_HINT
                         + "\n渠道 channels：web(站内通知,默认) / feishu / qq；某渠道是否已连**看系统提示「当前对话来源 / 通知渠道」**——已连(✅)的直接设，只有未连(❌)才提示用户去绑（用户正用某 IM 跟你聊＝那个渠道必然已连，别让 TA 扫码）。"
                         "QQ 选择 qq 时：网页/私聊默认 owner_private（私聊提醒用户）；群聊中必须先确认是 owner_private 还是 current_group，不能对模糊的‘提醒我’自行猜测。"),
            input_schema={
                "type": "object",
                "properties": {
                    "name":        {"type": "string", "description": "任务名（简短）"},
                    "instruction": {"type": "string", "description": "到点要做的事，自然语言指令（如「汇总今天到期的待办发我」）"},
                    "cron":        {"type": "string", "description": "cron「分 时 日 月 周」或 @once:<ISO>，时区 Asia/Shanghai"},
                    "channels":    {"type": "array", "items": {"type": "string", "enum": ["web", "feishu", "qq"]},
                                    "description": "投递渠道，默认 [web]"},
                    "enabled":     {"type": "boolean", "description": "是否启用，默认 true"},
                    "delivery_mode": {"type": "string", "enum": ["owner_private", "current_group"],
                                      "description": "QQ 投递模式：owner_private=私聊提醒我；current_group=发送到当前 QQ 群，仅群聊中可用。QQ 群聊创建任务前必须先确认"},
                },
                "required": ["name", "instruction", "cron"],
            },
            handler=_create_scheduled_task,
            mutates=True,
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
                    "delivery_mode": {"type": "string", "enum": ["owner_private", "current_group"],
                                      "description": "QQ 投递模式：owner_private=私聊；current_group=当前群（可选）"},
                },
                "required": [],
            },
            handler=_update_scheduled_task,
            mutates=True,
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
                    "confirm_token": {"type": "string", "description": "上一步确认请求返回的短时确认凭证"},
                },
                "required": [],
            },
            handler=_delete_scheduled_task,
            mutates=True,
            destructive=True,
        ),
    ]


ScheduledTasksSkill().register()
