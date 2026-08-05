"""用户定时任务 API：列表 / 增删改 / 立即试运行。

任务由 worker 每 ~30s 从 DB reconcile 到 APScheduler（新建/改动最多 30s 后生效）；
「立即运行」直接在本进程执行一次，便于测试。系统级任务（user_id 空）不在此暴露。
到点统一交给 agent 执行 payload（指令），无 reminder/agent 之分。
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.core.ownership import get_owned
from app.db.session import get_db
from app.models import ScheduledTask, User

router = APIRouter(prefix="/scheduled-tasks", tags=["scheduled-tasks"])

_CHANNELS = {"web", "feishu", "qq", "wechat", "im", "chat"}   # web=站内通知、feishu/qq/wechat=各 IM；chat=web、im=全部 IM（历史别名）

# 定时任务执行（run_ephemeral）按需精简注入用的工具组清单——直接引用 DefaultProfile.tools
# 本身（不抄一份重复列表），以后加/删工具组只用改那一处，这里自动跟着变，不用两边同步维护
# （踩过教训：devlog.md 2026-07-03「抽共享拖拽 composable」那次两份『该刷哪些』的清单分散在
# 前后端，迟早漂移）。放在这层（而非 agent/tools/scheduled_tasks.py）供两边共用：agent 那边
# 已经反向 import 这个文件的 _validate_cron/_norm_channels，这里再定义一遍会兜圈子循环 import。
from agent.profiles.default import DefaultProfile
TOOL_GROUPS = DefaultProfile.tools


async def classify_context_config(instruction: str) -> dict | None:
    """网页表单创建/改指令时没有 agent 在场顺手判断，补一次轻量分类调用（复用记忆/反思共用的
    complete_json，prompt 和输出都很小）。判断不出来就返回 None——退回全量，安全优先于省钱。"""
    instruction = (instruction or "").strip()
    if not instruction:
        return None
    from app.core.config import get_settings
    from agent.memory._llm import complete_json
    sys = (
        "你要判断一个定时任务到点执行时实际需要哪些工具/上下文，用来精简注入、省 token。"
        "只输出 JSON，不要任何解释文字。字段：\n"
        f"- tool_groups：数组，从这些里选（判断不出来就给空数组）：{TOOL_GROUPS}\n"
        "- projects/calendar/files/memory：布尔，是否需要项目列表/日历事件/文件概览/长期记忆作为参考\n"
        "meta 工具组（use_skill，用来拉取天气等技能）通常都该带上。"
    )
    result = await complete_json(sys, instruction, get_settings(), max_tokens=300)
    groups = result.get("tool_groups")
    if not isinstance(groups, list):
        return None
    return {
        "tool_groups": [g for g in groups if g in TOOL_GROUPS],
        "projects": bool(result.get("projects")),
        "calendar": bool(result.get("calendar")),
        "files":    bool(result.get("files")),
        "memory":   bool(result.get("memory")),
    }


# 后台任务引用，防止被 GC（fire-and-forget 的 context_config 分类，同 agent/runner.py 的 _bg_tasks 手法）
_bg_tasks: set = set()


def _schedule_context_config(task_id: int, instruction: str) -> None:
    """创建/改指令后台判断 tool_groups 等精简配置——别让用户等这次 LLM 调用，点创建/保存要秒回。
    分类完成前 context_config 保持 None（全量注入，安全默认），完成后再补丁进去。"""
    task = asyncio.create_task(_apply_context_config_bg(task_id, instruction))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


async def _apply_context_config_bg(task_id: int, instruction: str) -> None:
    try:
        cfg = await classify_context_config(instruction)
        if cfg is None:
            return   # 判断不出来就保持 None（全量），不用写回
        import app.db.session as _sess
        async with _sess._SessionLocal() as db:
            # task_id 是 create_task/update_task 已按 user.id 校验过归属后自己生成/持有的行 id，
            # 不是用户在这个调用点重新传入、需要当场校验的输入。
            t = await db.get(ScheduledTask, task_id)   # ownership-exempt: 见上，非用户直接输入的 id
            # 任务可能在这期间被删了，或指令又被改了一次（那次改动会自己再触发一轮分类）——
            # 两种情况都不该用这次基于旧指令算出来的结果覆盖，找不到/指令对不上就算了。
            if t and t.payload == instruction:
                t.context_config = cfg
                await db.commit()
    except Exception as e:
        print(f"[scheduled_tasks] 后台分类 context_config 失败: {type(e).__name__}: {e}", flush=True)


def _validate_cron(cron: str) -> None:
    if (cron or "").startswith("@once:"):
        from datetime import datetime
        try:
            datetime.fromisoformat(cron[6:])
        except ValueError:
            raise HTTPException(400, "一次性时间格式错误")
        return
    from apscheduler.triggers.cron import CronTrigger
    try:
        CronTrigger.from_crontab(cron)
    except Exception:
        raise HTTPException(400, f"cron 表达式非法：{cron!r}（格式 “分 时 日 月 周”，如 0 9 * * *）")


def _norm_channels(chs: list[str] | None) -> str:
    chs = [c for c in (chs or []) if c in _CHANNELS]
    return ",".join(chs) if chs else "web"


def _to_resp(t: ScheduledTask) -> dict:
    return {
        "id": t.id, "name": t.name,
        "payload": t.payload, "cron": t.cron,
        "channels": [c for c in (t.channels or "").split(",") if c],
        "enabled": t.enabled,
        "event_id": t.event_id,   # 绑定的日历事件（活动面板加的提醒）；null=独立任务
        "last_run_at": t.last_run_at.isoformat() if t.last_run_at else None,   # 原始 UTC ISO，前端按浏览器 tz 显示
        "context_config": t.context_config,   # null=全量注入；非空=按需精简（见 agent/runner.py run_ephemeral）
        "delivery_targets": t.delivery_targets,
    }


class TaskCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    payload: str = ""         # 到点要执行的指令
    cron: str                 # crontab "分 时 日 月 周"，或 @once:<ISO>
    channels: list[str] = ["web"]
    enabled: bool = True
    event_id: int | None = None   # 绑定到某日历事件（活动面板加的提醒）；省略=独立任务


class TaskUpdate(BaseModel):
    name: str | None = None
    payload: str | None = None
    cron: str | None = None
    channels: list[str] | None = None
    enabled: bool | None = None


@router.get("")
async def list_tasks(event_id: int | None = None, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    stmt = select(ScheduledTask).where(ScheduledTask.user_id == user.id)
    if event_id is not None:   # 活动面板按事件拉它的提醒
        stmt = stmt.where(ScheduledTask.event_id == event_id)
    else:                      # 定时任务面板：排除日程提醒（与日历解耦，作为活动的提醒单独存在）
        stmt = stmt.where(ScheduledTask.event_id.is_(None))
    rows = (await db.execute(stmt.order_by(ScheduledTask.id.desc()))).scalars().all()
    # 读时顺手清过期一次性任务：不只靠 worker 的 reconcile GC——万一 worker 滞后/没跑，
    # 面板自己也不显（也不留）过点的 @once。判据与 GC 同（过点超 120s 宽限，见 app/scheduled_tasks）。
    from app.scheduled_tasks import _once_expired
    from app.core.tz import local_now
    now = local_now()
    expired = [t for t in rows if _once_expired(t.cron, now)]
    if expired:
        for t in expired:
            await db.delete(t)
        await db.commit()
        rows = [t for t in rows if t not in expired]
    return {"tasks": [_to_resp(t) for t in rows]}


@router.post("", status_code=201)
async def create_task(body: TaskCreate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _validate_cron(body.cron)
    # 绑定事件校验：event_id 必须是本人的事件，防越权/挂错
    if body.event_id is not None:
        from app.models import CalendarEvent
        ev = await get_owned(db, CalendarEvent, body.event_id, user.id)
        if not ev:
            raise HTTPException(400, "绑定的日历事件不存在")
    t = ScheduledTask(
        user_id=user.id, name=body.name,
        payload=body.payload or "", cron=body.cron,
        channels=_norm_channels(body.channels), enabled=body.enabled,
        event_id=body.event_id,
        context_config=None,   # 先给安全默认（全量），分类结果后台补丁进来，别让创建等 LLM 调用
    )
    from app.scheduled_tasks import owner_private_targets
    t.delivery_targets = await owner_private_targets(db, user.id, body.channels)
    db.add(t)
    await db.commit()
    await db.refresh(t)
    _schedule_context_config(t.id, body.payload or "")
    return _to_resp(t)


async def _owned(task_id: int, user: User, db: AsyncSession) -> ScheduledTask:
    t = await get_owned(db, ScheduledTask, task_id, user.id)
    if not t:
        raise HTTPException(404, "任务不存在")
    return t


@router.patch("/{task_id}")
async def update_task(task_id: int, body: TaskUpdate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    t = await _owned(task_id, user, db)
    if body.cron is not None:
        _validate_cron(body.cron)
        t.cron = body.cron
    if body.name is not None:
        t.name = body.name
    if body.payload is not None:
        t.payload = body.payload
        # 指令变了，旧的 context_config 是按旧指令判断的，可能不再适用——先重置为安全默认
        # （全量），再后台重新分类一次补丁进来，别让保存等 LLM 调用。
        t.context_config = None
    if body.channels is not None:
        t.channels = _norm_channels(body.channels)
        from app.scheduled_tasks import owner_private_targets
        t.delivery_targets = await owner_private_targets(db, user.id, body.channels)
    if body.enabled is not None:
        t.enabled = body.enabled
    payload_changed = body.payload is not None
    await db.commit()
    await db.refresh(t)
    if payload_changed:
        _schedule_context_config(t.id, t.payload)
    return _to_resp(t)


@router.delete("/{task_id}", status_code=204)
async def delete_task(task_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    t = await _owned(task_id, user, db)
    await db.delete(t)
    await db.commit()


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
    """立即试运行一次并等结果，返回各渠道投递状态（成功 / 无地址 / 失败）给用户看。

    试运行是手动操作、用户在等反馈，所以同步 await（连接池已够，不会像 SSE 那样耗尽）。
    """
    await _owned(task_id, user, db)
    # _owned 只负责权限校验；Agent 生成和 IM 投递可能持续很久，先释放本次
    # 请求的 DB 连接，避免长事务阻塞迁移和其他登录/业务查询。
    await db.close()
    from app import scheduled_tasks as ST
    result = await ST.execute_task(task_id, is_trial=True)
    if not result:
        return {"ok": True, "msg": "已执行（该任务未选任何投递渠道）"}
    msg = "试运行结果：\n" + "\n".join(f"· {k}：{v}" for k, v in result.items())
    return {"ok": True, "result": result, "msg": msg}
