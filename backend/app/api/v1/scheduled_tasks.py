"""用户定时任务 API：列表 / 增删改 / 立即试运行。

任务由 worker 每 ~30s 从 DB reconcile 到 APScheduler（新建/改动最多 30s 后生效）；
「立即运行」直接在本进程执行一次，便于测试。系统级任务（user_id 空）不在此暴露。
到点统一交给 agent 执行 payload（指令），无 reminder/agent 之分。
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.core.ownership import get_owned
from app.core import events
from app.db.session import get_db
from app.models import FilesystemAuthorizationGrant, ScheduledTask, User
from app.services.calendar import find_event_reminder_by_cron
from app.services.scheduled_tasks import validate_task_workspace
from app.core.schedule_rules import (
    ScheduleValidationError,
    is_task_ended,
    normalize_schedule,
    schedule_status,
    task_schedule_kind,
)
from app.core.tz import iso_utc

router = APIRouter(prefix="/scheduled-tasks", tags=["scheduled-tasks"])
_TRIAL_WAIT_SECONDS = 180
_trial_tasks: set[asyncio.Task] = set()

_CHANNELS = {"web", "email", "feishu", "qq", "wechat", "im", "chat"}   # email=注册邮箱；chat=web、im=全部 IM（历史别名）


def _schedule_error(exc: ScheduleValidationError) -> HTTPException:
    return HTTPException(400, f"{exc.field}: {exc}")


def _normalize_schedule(*, schedule_kind, cron, interval_minutes, start_at, end_at):
    try:
        return normalize_schedule(
            schedule_kind=schedule_kind,
            cron=cron,
            interval_minutes=interval_minutes,
            start_at=start_at,
            end_at=end_at,
        )
    except ScheduleValidationError as exc:
        raise _schedule_error(exc) from exc


def _norm_channels(chs: list[str] | None) -> str:
    chs = list(dict.fromkeys(c for c in (chs or []) if c in _CHANNELS))
    return ",".join(chs) if chs else "web"


def _norm_authorized_tools(tools: list[str] | None) -> list[str]:
    return ["send_email"] if tools and "send_email" in tools else []


def _norm_script_authorization(value):
    from app.services.scheduled_tasks import normalize_script_authorization
    try:
        return normalize_script_authorization(value)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


def _to_resp(t: ScheduledTask) -> dict:
    from app.services.filesystem_authorization import filesystem_authorization_enabled

    return {
        "id": t.id, "name": t.name,
        "payload": t.payload, "cron": t.cron,
        "schedule_kind": task_schedule_kind(t),
        "interval_minutes": t.interval_minutes,
        "start_at": iso_utc(t.start_at) if t.start_at else None,
        "end_at": iso_utc(t.end_at) if t.end_at else None,
        "schedule_status": schedule_status(t),
        "channels": [c for c in (t.channels or "").split(",") if c],
        "enabled": t.enabled,
        "event_id": t.event_id,   # 绑定的日历事件（活动面板加的提醒）；null=独立任务
        "workspace_id": t.workspace_id,
        "filesystem_authorized": filesystem_authorization_enabled() and t.filesystem_authorization_grant_id is not None,
        "last_run_at": iso_utc(t.last_run_at) if t.last_run_at else None,   # 原始 UTC ISO，前端按浏览器 tz 显示
        "last_run_failed": bool(t.last_run_failed),   # 一次性任务触发过但没成功；前端可用来提示重试
        "delivery_targets": t.delivery_targets,
        "authorized_tools": t.authorized_tools or [],
        "script_authorization": t.script_authorization,
    }


class TaskCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    payload: str = ""         # 到点要执行的指令
    schedule_kind: Literal["cron", "interval", "once"]
    cron: str | None = None   # cron 模式的“分 时 日 月 周”表达式
    interval_minutes: int | None = Field(default=None, ge=1, le=60)
    start_at: datetime | None = None
    end_at: datetime | None = None
    channels: list[str] = ["web"]
    enabled: bool = True
    event_id: int | None = None   # 绑定到某日历事件（活动面板加的提醒）；省略=独立任务
    authorized_tools: list[str] = Field(default_factory=list)
    workspace_id: int | None = None
    script_authorization: dict | None = None


class TaskUpdate(BaseModel):
    name: str | None = None
    payload: str | None = None
    cron: str | None = None
    schedule_kind: Literal["cron", "interval", "once"] | None = None
    interval_minutes: int | None = Field(default=None, ge=1, le=60)
    start_at: datetime | None = None
    end_at: datetime | None = None
    channels: list[str] | None = None
    enabled: bool | None = None
    authorized_tools: list[str] | None = None
    workspace_id: int | None = None
    script_authorization: dict | None = None


@router.get("")
async def list_tasks(event_id: int | None = None, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    stmt = select(ScheduledTask).where(ScheduledTask.user_id == user.id)
    if event_id is not None:   # 活动面板按事件拉它的提醒
        stmt = stmt.where(ScheduledTask.event_id == event_id)
    else:                      # 定时任务面板：排除日程提醒（与日历解耦，作为活动的提醒单独存在）
        stmt = stmt.where(ScheduledTask.event_id.is_(None))
    rows = (await db.execute(stmt.order_by(ScheduledTask.id.desc()))).scalars().all()
    # 读时顺手处理已结束任务：不只靠 worker 的 reconcile——万一 worker 滞后/没跑，
    # 面板自己也要能收拾。重复任务结束后销毁，一次性任务按独立的失败重试规则处理。
    #
    # 1) 从没跑过（last_run_at 为空）且已经过点：调度大概率没触发（misfire/进程当时没起），
    #    真的没意义了，直接删——跟 reconcile() 的 GC 判据一致（过点超 120s 宽限）。
    # 2) 跑过、但既没标成功（行会被删掉）也没标失败、也查不到还在跑的 Redis 锁：
    #    大概率是执行中途进程崩了，没来得及写结果。这种不能删——用户压根没看到失败
    #    原因、也没法重试；转成"失败"状态，留给用户在面板里看到并手动重新触发。
    # "正在执行中"（Redis 锁还在）不能碰：
    # 执行超过 120s 宽限窗口完全可能（Agent 调用本身就慢），不能因为面板恰好在这时
    # 被打开，就把还在跑的任务误判成"过期没跑"或"崩了"。
    from app.scheduled_tasks import (
        _delete_ended_repeating_tasks,
        _reap_abandoned_once_tasks,
        _task_once_expired,
    )
    from app.core.tz import local_now
    now = local_now()
    from app.core.schedule_rules import task_schedule_kind
    ended_repeating = await _delete_ended_repeating_tasks(db, rows, now)
    if ended_repeating:
        rows = [t for t in rows if t not in ended_repeating]
    never_ran_expired = [
        t for t in rows
        if t.last_run_at is None
        and task_schedule_kind(t) == "once"
        and _task_once_expired(t, now)
    ]
    if never_ran_expired:
        for t in never_ran_expired:
            await db.delete(t)
        await db.commit()
        rows = [t for t in rows if t not in never_ran_expired]
    await _reap_abandoned_once_tasks(db, rows)
    return {"tasks": [_to_resp(t) for t in rows]}


@router.post("", status_code=201)
async def create_task(body: TaskCreate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    spec = _normalize_schedule(
        schedule_kind=body.schedule_kind,
        cron=body.cron,
        interval_minutes=body.interval_minutes,
        start_at=body.start_at,
        end_at=body.end_at,
    )
    if body.event_id is not None and spec.schedule_kind != "once":
        raise HTTPException(400, "日历活动提醒必须使用 once 类型")
    try:
        workspace_id = await validate_task_workspace(db, user.id, body.workspace_id)
    except LookupError as exc:
        raise HTTPException(400, str(exc)) from exc
    script_authorization = _norm_script_authorization(body.script_authorization)
    if script_authorization is not None:
        if script_authorization["root"] == "workspace" and workspace_id is None:
            raise HTTPException(400, "workspace 脚本必须绑定 workspace_id")
        if script_authorization["root"] in {"personal", "project"}:
            raise HTTPException(400, "personal/project 脚本必须通过完整用户沙箱授权")
    # 绑定事件校验：event_id 必须是本人的事件，防越权/挂错
    if body.event_id is not None:
        from app.models import CalendarEvent
        ev = await get_owned(db, CalendarEvent, body.event_id, user.id)
        if not ev:
            raise HTTPException(400, "绑定的日历事件不存在")
        existing = await find_event_reminder_by_cron(db, user.id, body.event_id, spec.cron)
        if existing:
            # 客户端超时重试或重复提交同一活动提醒时，返回原任务而不是再建一条。
            return _to_resp(existing)
    t = ScheduledTask(
        user_id=user.id, name=body.name,
        payload=body.payload or "", cron=spec.cron,
        schedule_kind=spec.schedule_kind,
        interval_minutes=spec.interval_minutes,
        start_at=spec.start_at,
        end_at=spec.end_at,
        channels=_norm_channels(body.channels), enabled=body.enabled,
        event_id=body.event_id,
        authorized_tools=_norm_authorized_tools(body.authorized_tools),
        workspace_id=workspace_id,
        script_authorization=script_authorization,
    )
    from app.scheduled_tasks import owner_private_targets
    t.delivery_targets = await owner_private_targets(db, user.id, body.channels)
    db.add(t)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        if body.event_id is not None:
            existing = await find_event_reminder_by_cron(db, user.id, body.event_id, spec.cron)
            if existing:
                return _to_resp(existing)
        raise
    await db.refresh(t)
    response = _to_resp(t)
    await events.publish(user.id, "scheduled_tasks", operation="create", entity_id=t.id,
                         event_payload=response)
    return response


async def _owned(task_id: int, user: User, db: AsyncSession) -> ScheduledTask:
    t = await get_owned(db, ScheduledTask, task_id, user.id)
    if not t:
        raise HTTPException(404, "任务不存在")
    return t


@router.patch("/{task_id}")
async def update_task(task_id: int, body: TaskUpdate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    t = await _owned(task_id, user, db)
    previous_workspace_id = t.workspace_id
    if "workspace_id" in body.model_fields_set:
        try:
            t.workspace_id = await validate_task_workspace(db, user.id, body.workspace_id)
        except LookupError as exc:
            raise HTTPException(400, str(exc)) from exc
    if body.enabled is False and t.event_id is None and t.filesystem_authorization_grant_id is not None:
        # 停用任务同时使任务级完整授权失效；审计记录由 service 保留。
        from app.services.filesystem_authorization import revoke_scheduled_task_filesystem_access
        await revoke_scheduled_task_filesystem_access(db, user.id, t.id)
    schedule_fields = {"schedule_kind", "cron", "interval_minutes", "start_at", "end_at"}
    if body.model_fields_set & schedule_fields:
        current_kind = task_schedule_kind(t)
        next_kind = body.schedule_kind if "schedule_kind" in body.model_fields_set else current_kind
        kind_changed = next_kind != current_kind
        if kind_changed:
            # 调度类型切换必须重新提供该类型所需字段，不能把旧类型字段带进来。
            next_cron = body.cron if "cron" in body.model_fields_set else None
            next_interval = body.interval_minutes if "interval_minutes" in body.model_fields_set else None
            next_start = body.start_at if "start_at" in body.model_fields_set else None
            next_end = body.end_at if "end_at" in body.model_fields_set else None
        else:
            next_cron = body.cron if "cron" in body.model_fields_set else None if next_kind in {"interval", "once"} else t.cron
            next_interval = body.interval_minutes if "interval_minutes" in body.model_fields_set else t.interval_minutes
            next_start = body.start_at if "start_at" in body.model_fields_set else t.start_at
            next_end = body.end_at if "end_at" in body.model_fields_set else t.end_at
        spec = _normalize_schedule(
            schedule_kind=next_kind,
            cron=next_cron,
            interval_minutes=next_interval,
            start_at=next_start,
            end_at=next_end,
        )
        if t.event_id is not None and spec.schedule_kind != "once":
            raise HTTPException(400, "日历活动提醒必须使用 once 类型")
        if t.event_id is not None:
            conflict = await find_event_reminder_by_cron(
                db, user.id, t.event_id, spec.cron, exclude_id=t.id,
            )
            if conflict is not None:
                raise HTTPException(409, "该活动在同一触发时刻已有提醒")
        t.cron = spec.cron
        t.schedule_kind = spec.schedule_kind
        t.interval_minutes = spec.interval_minutes
        t.start_at = spec.start_at
        t.end_at = spec.end_at
    if body.name is not None:
        t.name = body.name
    if body.payload is not None:
        t.payload = body.payload
    if body.channels is not None:
        t.channels = _norm_channels(body.channels)
        from app.scheduled_tasks import owner_private_targets
        t.delivery_targets = await owner_private_targets(db, user.id, body.channels)
    # 页面上的保存动作是用户重新确认任务意图；显式传授权时允许单独授予或撤销，
    # 内容或投递设置变更但未传授权时则自动撤销旧的持久权限。
    if body.authorized_tools is not None:
        t.authorized_tools = _norm_authorized_tools(body.authorized_tools)
    elif body.payload is not None or (body.model_fields_set & schedule_fields) or body.channels is not None:
        t.authorized_tools = []
    if body.enabled is not None:
        t.enabled = body.enabled
    if "script_authorization" in body.model_fields_set:
        script_authorization = _norm_script_authorization(body.script_authorization)
        if script_authorization is not None:
            if script_authorization["root"] == "workspace" and t.workspace_id is None:
                raise HTTPException(400, "workspace 脚本必须绑定 workspace_id")
            if script_authorization["root"] in {"personal", "project"}:
                raise HTTPException(400, "personal/project 脚本必须通过完整用户沙箱授权")
        t.script_authorization = script_authorization
    elif "workspace_id" in body.model_fields_set and previous_workspace_id != t.workspace_id:
        # 工作区变更后原脚本路径的根已不再确定，必须重新显式绑定，不能沿用旧授权。
        t.script_authorization = None
    await db.commit()
    await db.refresh(t)
    response = _to_resp(t)
    await events.publish(user.id, "scheduled_tasks", operation="update", entity_id=t.id,
                         event_payload=response)
    return response


class TaskFilesystemAuthorizationConfirm(BaseModel):
    confirm_code: str = Field(min_length=1, max_length=128)


def _task_authorization_summary(task: ScheduledTask) -> str:
    return f"允许定时任务「{task.name}」读写整个用户沙箱（包含 /workspace、/personal、/project）"


@router.post("/{task_id}/filesystem-authorization/request")
async def request_task_filesystem_authorization(
    task_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    """为任务授权弹窗申请一次性确认码；此请求本身不创建授权。"""
    from agent.security import confirm
    from agent.interactions.confirmations import revoke_confirmation
    from app.services.filesystem_authorization import (
        SUBJECT_SCHEDULED_TASK, record_filesystem_authorization_request,
        filesystem_authorization_enabled,
    )

    task = await _owned(task_id, user, db)
    if not filesystem_authorization_enabled():
        raise HTTPException(409, "完整用户沙箱授权功能当前未开启")
    if not task.enabled:
        raise HTTPException(400, "停用任务不能授予完整用户沙箱权限")
    if task.filesystem_authorization_grant_id is not None:
        grant = await get_owned(
            db, FilesystemAuthorizationGrant,
            task.filesystem_authorization_grant_id, user.id,
        )
        if grant is not None and grant.revoked_at is None:
            return {"status": "authorized", "task_id": task.id}
    summary = _task_authorization_summary(task)
    # 兼容旧版本：数据库授权已撤销时，清掉可能遗留的 Redis 确认授权，避免
    # 再次申请被误判为已确认而不弹窗。
    revoke_confirmation(
        user.id,
        summary,
        identity=f"scheduled-task:filesystem:{task.id}",
    )
    args: dict = {}
    pending = confirm.needs_confirmation(
        args, summary, user.id, identity=f"scheduled-task:filesystem:{task.id}", ttl_minutes=10,
        instruction="确认后，该定时任务每次运行都可读写用户沙箱；不包含宿主机目录。",
    )
    if pending is None:
        return {"status": "authorized", "task_id": task.id}
    try:
        response = json.loads(pending)
    except (TypeError, ValueError):
        raise HTTPException(503, "确认服务暂不可用，请稍后重试") from None
    record_filesystem_authorization_request(
        db, user_id=user.id, subject_type=SUBJECT_SCHEDULED_TASK,
        subject_id=task.id, source="user",
    )
    await db.commit()
    return response


@router.post("/{task_id}/filesystem-authorization")
async def confirm_task_filesystem_authorization(
    task_id: int, body: TaskFilesystemAuthorizationConfirm,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    """兑换确认码并创建任务级授权；确认码绑定用户、任务和授权范围。"""
    from agent.interactions.confirmations import redeem_confirmation
    from app.services.filesystem_authorization import (
        filesystem_authorization_enabled, grant_scheduled_task_filesystem_access,
    )
    from agent.security import confirm

    task = await _owned(task_id, user, db)
    if not filesystem_authorization_enabled():
        raise HTTPException(409, "完整用户沙箱授权功能当前未开启")
    if not task.enabled:
        raise HTTPException(400, "停用任务不能授予完整用户沙箱权限")
    if redeem_confirmation(user.id, body.confirm_code) is None:
        raise HTTPException(400, "授权确认已失效，请重新确认")
    args: dict = {}
    pending = confirm.needs_confirmation(
        args, _task_authorization_summary(task), user.id,
        identity=f"scheduled-task:filesystem:{task.id}", ttl_minutes=10,
    )
    if pending is not None:
        raise HTTPException(400, "授权确认不匹配，请重新确认")
    try:
        grant = await grant_scheduled_task_filesystem_access(db, user.id, task.id)
    except LookupError as exc:
        raise HTTPException(409, str(exc)) from exc
    await db.commit()
    return {"status": "authorized", "task_id": task.id, "grant_id": grant.id}


@router.delete("/{task_id}/filesystem-authorization")
async def revoke_task_filesystem_authorization(
    task_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    from app.services.filesystem_authorization import revoke_scheduled_task_filesystem_access

    try:
        revoked = await revoke_scheduled_task_filesystem_access(db, user.id, task_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    await db.commit()
    return {"status": "revoked", "task_id": task_id, "revoked": revoked}


@router.delete("/{task_id}", status_code=204)
async def delete_task(task_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    t = await _owned(task_id, user, db)
    await db.delete(t)
    await db.commit()
    await events.publish(user.id, "scheduled_tasks", operation="delete", entity_id=task_id)


class TestNotify(BaseModel):
    channels: list[str] = ["web"]
    name: str = "活动提醒"


@router.post("/test-notify")
async def test_notify(body: TestNotify, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """测试提醒渠道：立即往选定渠道投一条测试消息（不依赖已保存的任务，新建活动时也能测）。

    日程提醒与定时任务完全分开——提醒的测试不创建任何任务，只验证渠道能否触达。
    """
    chans = {c for c in (body.channels or []) if c in _CHANNELS} or {"web"}
    name = (body.name or "活动提醒").strip()
    text = f"这是一条测试提醒——「{name}」。如果你收到了这条消息，说明提醒渠道工作正常。"
    # 渠道投递可能等待外部 IM 接口，不能让认证用的请求会话跨越整个投递过程。
    await db.close()
    from app import scheduled_tasks as ST
    result = await ST.deliver_to_channels(user.id, f"{name}（测试）", text, chans)
    if not result:
        return {"ok": True, "msg": "已发送（未选任何投递渠道）"}
    msg = "测试发送结果：\n" + "\n".join(f"· {k}：{v}" for k, v in result.items())
    return {"ok": True, "result": result, "msg": msg}


@router.post("/{task_id}/run")
async def run_now(task_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """立即运行一次并等结果，返回各渠道投递状态（成功 / 无地址 / 失败）给用户看。

    普通任务/还没跑过的一次性任务：走试运行（is_trial=True），不写 last_run_at、
    不会因为这次点击就让任务被标记完成或删除，纯粹是"看看这次会说什么"。
    已经失败过的一次性任务：这是目前唯一暴露给用户的"重试"入口，必须走正式执行
    （is_trial=False）——试运行不会清 last_run_failed、不会在成功后删除任务，
    用户点了"立即运行"却发现任务列表毫无变化，等于这个失败任务永远卡在失败态、
    没有真正能收尾的路径。

    试运行是手动操作、用户在等反馈，所以同步 await（连接池已够，不会像 SSE 那样耗尽）。
    """
    t = await _owned(task_id, user, db)
    is_once = task_schedule_kind(t) == "once"
    if is_task_ended(t):
        return {"ok": False, "msg": "任务已结束，不能立即运行"}
    retry_failed_once = is_once and bool(t.last_run_failed)
    # _owned 只负责权限校验；Agent 生成和 IM 投递可能持续很久，先释放本次
    # 请求的 DB 连接，避免长事务阻塞迁移和其他登录/业务查询。
    await db.close()
    from app import scheduled_tasks as ST
    task = asyncio.create_task(ST.execute_task(task_id, is_trial=not retry_failed_once))
    _trial_tasks.add(task)
    task.add_done_callback(_trial_tasks.discard)
    try:
        # 请求超时只结束 HTTP 等待，不能取消实际任务；否则 Agent 尚未完成时，后续
        # deliver_to_channels 永远不会执行，QQ/飞书等渠道就会表现成“试运行没发送”。
        result = await asyncio.wait_for(
            asyncio.shield(task),
            timeout=_TRIAL_WAIT_SECONDS,
        )
    except asyncio.TimeoutError:
        return {
            "ok": True,
            "pending": True,
            "msg": f"试运行仍在执行，完成后会按任务渠道投递（已等待 {_TRIAL_WAIT_SECONDS} 秒）。",
        }
    if not result:
        return {"ok": True, "msg": "已执行（该任务未选任何投递渠道）"}
    msg = "试运行结果：\n" + "\n".join(f"· {k}：{v}" for k, v in result.items())
    return {"ok": True, "result": result, "msg": msg}
