"""定时任务：DB 驱动的引擎（reconcile）+ 执行 + 投递。

worker 进程每 ~30s 调 `reconcile()`：从 `scheduled_tasks` 表读启用任务，同步到 APScheduler。
任务触发 → `execute_task` → 构造上下文 prompt → agent 生成回复 →
  ① SSE notification 事件（前端侧边栏铃铛弹窗）
  ② IM 主动 DM（飞书可主动；QQ best-effort）
"""
from __future__ import annotations

import json
import uuid as _uuid
from datetime import datetime

from sqlalchemy import select

_synced: dict[str, str] = {}   # job_id -> 上次同步用的 updated_at，变了才重挂


def _as_uuid(v):
    return v if not isinstance(v, str) else _uuid.UUID(v)


def build_trigger(cron: str):
    """cron 字符串 → APScheduler 触发器。`@once:<ISO>` = 一次性（DateTrigger），否则 crontab。"""
    if (cron or "").startswith("@once:"):
        from apscheduler.triggers.date import DateTrigger
        return DateTrigger(run_date=datetime.fromisoformat(cron[6:]), timezone="Asia/Shanghai")
    from apscheduler.triggers.cron import CronTrigger
    return CronTrigger.from_crontab(cron, timezone="Asia/Shanghai")


# ── reconcile：DB → APScheduler ──────────────────────────────────────────────
async def reconcile() -> None:
    from app.core import scheduler as sched
    s = sched.get()
    if s is None:
        return
    import app.db.session as ss
    from app.models import ScheduledTask
    if ss._engine is None:
        ss._build_engine()
    async with ss._SessionLocal() as db:
        tasks = (await db.execute(
            select(ScheduledTask).where(ScheduledTask.enabled.is_(True))
        )).scalars().all()

    desired: dict[str, str] = {}
    for t in tasks:
        jid = f"task:{t.id}"
        stamp = t.updated_at.isoformat() if t.updated_at else ""
        desired[jid] = stamp
        if s.get_job(jid) is not None and _synced.get(jid) == stamp:
            continue   # 没变，跳过
        try:
            trig = build_trigger(t.cron)
        except Exception as e:
            print(f"[sched] 任务 {t.id} 触发器非法({t.cron!r})：{e}", flush=True)
            continue
        s.add_job(execute_task, trig, args=[t.id], id=jid, name=t.name,
                  replace_existing=True, max_instances=1, coalesce=True)
        _synced[jid] = stamp

    # 删掉 DB 里已没有/已停用的
    for job in s.get_jobs():
        if job.id.startswith("task:") and job.id not in desired:
            s.remove_job(job.id)
            _synced.pop(job.id, None)


# ── 执行 ─────────────────────────────────────────────────────────────────────
async def execute_task(task_id: int, is_trial: bool = False) -> None:
    import app.db.session as ss
    from app.models import ScheduledTask
    async with ss._SessionLocal() as db:
        t = await db.get(ScheduledTask, task_id)
        if not t or not t.enabled:
            return
        payload, uid, name = t.payload or "", t.user_id, t.name
        t.last_run_at = datetime.utcnow()
        if not is_trial and (t.cron or "").startswith("@once:"):
            t.enabled = False
        await db.commit()
    try:
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
        prompt = (
            f"[定时任务触发：{name}]\n"
            f"现在是 {now_str}，用户设置了一条定时任务：{payload}\n"
            f"请以咕咕的身份完成这项任务，并将结果告知用户。"
        )
        text = await _run_agent(uid, prompt)
        from app.core import events as _ev
        await _ev.publish(uid, notification={"title": name, "content": text})
        try:
            await _deliver_im(uid, f"⏰ {name}\n\n{text}")
        except Exception as e:
            print(f"[sched] im 投递失败: {type(e).__name__}: {e}", flush=True)
    except Exception as e:
        import traceback
        print(f"[sched] 执行任务 {task_id} 出错: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()


async def _run_agent(user_id, prompt: str) -> str:
    from agent.runner import run_ephemeral
    import app.db.session as ss
    from app.models import User
    async with ss._SessionLocal() as db:
        u = await db.get(User, _as_uuid(user_id))
        uname = (u.display_name or u.username) if u else ""
    text = await run_ephemeral(user_id, uname, prompt)
    return text or "（咕咕这次没有产出内容）"


# ── IM 投递 ──────────────────────────────────────────────────────────────────
async def _deliver_im(user_id, text: str) -> None:
    """按 Redis 里存的可触达地址主动 DM。飞书可主动；QQ 主动受限，best-effort。"""
    reach = await get_imreach(user_id)
    if not reach:
        return   # 该用户没绑/没用过 IM，跳过（不算错）
    import worker
    payload = {
        "platform": reach.get("platform"),
        "channel_id": reach.get("channel_id"),
        "chat_id": reach.get("chat_id"),
        "platform_user_id": reach.get("puid"),
    }
    await worker._send(payload, text)


# ── IM 可触达地址（worker 收到消息时记一份，主动推送时用）──────────────────────
def _reach_key(user_id) -> str:
    return f"imreach:{user_id}"


async def save_imreach(user_id, platform, channel_id, chat_id, puid) -> None:
    from app.core import redis as R
    try:
        await R.get_redis().set(
            _reach_key(user_id),
            json.dumps({"platform": platform, "channel_id": channel_id, "chat_id": chat_id, "puid": puid}),
            ex=90 * 86400,   # 90 天，每次收到消息刷新
        )
    except Exception:
        pass


async def get_imreach(user_id) -> dict | None:
    from app.core import redis as R
    try:
        v = await R.get_redis().get(_reach_key(user_id))
        return json.loads(v) if v else None
    except Exception:
        return None
