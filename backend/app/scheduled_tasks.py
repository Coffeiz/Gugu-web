"""定时任务：DB 驱动的引擎（reconcile）+ 执行 + 投递。

worker 进程每 ~30s 调 `reconcile()`：从 `scheduled_tasks` 表读启用任务，同步到 APScheduler
（增/删/改/开关即时生效，不重启——同 supervisor 读 user_bots 的套路）。任务触发 → `execute_task`。

动作：
- reminder       到点发提醒文本
- agent          到点跑一条咕咕指令、把结果发回
- deadline_scan  系统级：扫所有用户近期截稿，按各自开关投递（用户偏好 remind_deadlines）

投递渠道（任务的 channels 字段，逗号分隔）：
- chat  作为一条 assistant 消息进用户的「⏰ 咕咕提醒」会话 + 推 SSE（在线即时/离线下次见）
- im    主动 DM（按 Redis 里存的「可触达地址」imreach 发；飞书可主动，QQ 主动受限、best-effort）
"""
from __future__ import annotations

import json
import uuid as _uuid
from datetime import datetime, timedelta

from sqlalchemy import select

CHANNELS_DEFAULT = "chat,im"
_synced: dict[str, str] = {}   # job_id -> 上次同步用的 updated_at，变了才重挂


def _as_uuid(v):
    return v if not isinstance(v, str) else _uuid.UUID(v)


# ── reconcile：DB → APScheduler ──────────────────────────────────────────────
async def reconcile() -> None:
    from app.core import scheduler as sched
    from apscheduler.triggers.cron import CronTrigger
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
            trig = CronTrigger.from_crontab(t.cron, timezone="Asia/Shanghai")
        except Exception as e:
            print(f"[sched] 任务 {t.id} cron 非法({t.cron!r})：{e}", flush=True)
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
async def execute_task(task_id: int) -> None:
    import app.db.session as ss
    from app.models import ScheduledTask
    async with ss._SessionLocal() as db:
        t = await db.get(ScheduledTask, task_id)
        if not t or not t.enabled:
            return
        action, payload, channels, uid, name = t.action_type, t.payload or "", t.channels or CHANNELS_DEFAULT, t.user_id, t.name
        t.last_run_at = datetime.utcnow()
        await db.commit()
    try:
        if action == "reminder":
            await deliver(uid, f"⏰ {payload}", channels)
        elif action == "agent":
            text = await _run_agent(uid, payload)
            await deliver(uid, f"⏰ {name}\n\n{text}", channels)
        else:
            print(f"[sched] 任务 {task_id} 未知动作 {action!r}", flush=True)
    except Exception as e:
        import traceback
        print(f"[sched] 执行任务 {task_id}({action}) 出错: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()


async def _run_agent(user_id, prompt: str) -> str:
    from agent.models import AgentRequest
    from agent.runner import run_collect
    import app.db.session as ss
    from app.models import User
    async with ss._SessionLocal() as db:
        u = await db.get(User, _as_uuid(user_id))
        uname = (u.display_name or u.username) if u else ""
    resp = await run_collect(AgentRequest(message=prompt, user_id=user_id, user_name=uname, source="schedule"))
    return (resp.text or "").strip() or "（咕咕这次没有产出内容）"


# ── 投递 ─────────────────────────────────────────────────────────────────────
async def deliver(user_id, text: str, channels: str) -> None:
    chans = {c.strip() for c in (channels or "").split(",") if c.strip()}
    if "chat" in chans:
        try:
            await _deliver_chat(user_id, text)
        except Exception as e:
            print(f"[sched] chat 投递失败: {type(e).__name__}: {e}", flush=True)
    if "im" in chans:
        try:
            await _deliver_im(user_id, text)
        except Exception as e:
            print(f"[sched] im 投递失败: {type(e).__name__}: {e}", flush=True)


async def _deliver_chat(user_id, text: str) -> None:
    """进用户的「⏰ 咕咕提醒」会话（source=schedule，找不到就建），推 SSE。"""
    import app.db.session as ss
    from app.models import ConversationSession, ConversationMessage
    from app.core import events
    uid = _as_uuid(user_id)
    async with ss._SessionLocal() as db:
        sess = (await db.execute(
            select(ConversationSession).where(
                ConversationSession.user_id == uid,
                ConversationSession.source == "schedule",
            ).order_by(ConversationSession.id.desc())
        )).scalars().first()
        if sess is None:
            sess = ConversationSession(user_id=uid, title="⏰ 咕咕提醒", source="schedule")
            db.add(sess)
            await db.flush()
        db.add(ConversationMessage(session_id=sess.id, role="assistant", content=text))
        sess.updated_at = datetime.utcnow()
        await db.commit()
        sid = sess.id
    await events.publish(uid, "sessions", "messages", session_id=sid)


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
