"""定时任务：DB 驱动的引擎（reconcile）+ 执行 + 投递。

worker 进程每 ~30s 调 `reconcile()`：从 `scheduled_tasks` 表读启用任务，同步到 APScheduler。
任务触发 → `execute_task` → 构造上下文 prompt → agent 生成回复 →
  ① SSE notification 事件（前端侧边栏铃铛弹窗）
  ② IM 主动 DM（飞书可主动；QQ best-effort）
"""
from __future__ import annotations
from app.core.tz import LOCAL_TZ, now_utc

import json
import uuid as _uuid
from datetime import datetime, timedelta

from app.core.tz import local_now

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


_ONCE_GC_GRACE = timedelta(seconds=120)   # 一次性任务过点后多久可被 GC（正常触发的由 execute_task 即时删；这宽限只避开正在触发的那一下）


def _once_expired(cron: str, now: datetime) -> bool:
    """判断一次性任务是否过期，兼容旧数据中的 naive/aware ISO 时间。

    历史任务可能保存为本地无时区时间，也可能保存为带 ``+08:00`` 的时间；
    两者先统一到项目本地时区，再进行比较，避免 naive/aware 混用导致列表接口 500。
    解析不了的不动（宁留勿误删）。仅过去超过宽限期才算过期，避开正在触发的那一下。
    """
    c = cron or ""
    if not c.startswith("@once:"):
        return False
    try:
        when = datetime.fromisoformat(c[6:])
    except Exception:
        return False
    if when.tzinfo is None:
        when = when.replace(tzinfo=LOCAL_TZ)
    else:
        when = when.astimezone(LOCAL_TZ)
    if now.tzinfo is None:
        now = now.replace(tzinfo=LOCAL_TZ)
    else:
        now = now.astimezone(LOCAL_TZ)
    return when < now - _ONCE_GC_GRACE


async def _notify_tasks_changed(user_ids) -> None:
    """定时任务有**自动**变化（GC 清理 / 一次性触发即删）→ 推 `scheduled_tasks` 事件，
    网页定时面板实时刷（咕咕主动建/改/删走 tool dispatch 的 RESOURCE_BY_TOOL，不在此列）。永不抛。"""
    from app.core import events
    for uid in set(user_ids):
        try:
            await events.publish(uid, "scheduled_tasks")
        except Exception:
            pass


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
        all_tasks = (await db.execute(select(ScheduledTask))).scalars().all()
        # GC 过期的一次性任务：一次性任务过点就「用完了」——正常触发的已被 execute_task 即时删，
        # 这里兜底清理漏网的（misfire 没触发、被停用、或残留），否则它们永远僵在面板里。
        now = local_now()
        gc = [t for t in all_tasks if _once_expired(t.cron, now)]
        gc_ids = {t.id for t in gc}
        if gc:
            gc_uids = {t.user_id for t in gc}
            for t in gc:
                await db.delete(t)
            await db.commit()
            print(f"[sched] GC {len(gc)} 个过期一次性任务: {sorted(gc_ids)}", flush=True)
            await _notify_tasks_changed(gc_uids)   # 自动清 → 定时面板实时刷
        tasks = [t for t in all_tasks if t.enabled and t.id not in gc_ids]

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
async def execute_task(task_id: int, is_trial: bool = False) -> dict:
    """执行一次任务，返回各渠道投递结果 {渠道: 状态}（试运行据此给用户反馈）。"""
    import app.db.session as ss
    from app.models import ScheduledTask
    result: dict = {}
    async with ss._SessionLocal() as db:
        t = await db.get(ScheduledTask, task_id)
        if not t or not t.enabled:
            return {"错误": "任务不存在或已停用"}
        payload, uid, name = t.payload or "", t.user_id, t.name
        context_config = t.context_config
        chans = {c for c in (t.channels or "").split(",") if c}
        t.last_run_at = now_utc()
        once_deleted = not is_trial and (t.cron or "").startswith("@once:")
        if once_deleted:
            await db.delete(t)
        await db.commit()
    if once_deleted:
        await _notify_tasks_changed([uid])   # 一次性任务触发即删 → 定时面板实时刷
    try:
        now_str = local_now().strftime("%Y-%m-%d %H:%M")
        delivery_targets = _scheduled_delivery_targets(chans)
        prompt = (
            f"[定时任务触发：{name}]\n"
            f"现在是 {now_str}，用户设置了一条定时任务：{payload}\n"
            f"本轮消息将由系统投递到：{delivery_targets}。\n"
            "请以咕咕的身份完成这项任务，只生成要发给用户的正文。"
            "消息会由定时任务系统自动投递到已配置的渠道，不需要你调用发送工具，"
            "也不要提及渠道、推送、工具不可用或无法发送。"
        )
        text = await _run_agent(uid, prompt, context_config)
        result = await deliver_to_channels(uid, name, text, chans)
    except Exception as e:
        import traceback
        result["错误"] = f"{type(e).__name__}: {e}"
        print(f"[sched] 执行任务 {task_id} 出错: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
    return result


async def deliver_to_channels(uid, name: str, text: str, chans: set) -> dict:
    """把 text 投递到选定渠道，返回 {渠道: 状态}。供定时任务执行 / 提醒测试复用。
    chat=web 历史别名；im=发到用过的所有 IM 平台（旧任务兼容）。"""
    result: dict = {}
    if {"web", "chat"} & chans:
        from app.core import events as _ev
        await _ev.publish(uid, notification={"title": name, "content": text})
        result["web 通知"] = "已发送"
    im_targets = {_CHAN_PLATFORM[c] for c in chans if c in _CHAN_PLATFORM}
    if "im" in chans:
        im_targets.update(_CHAN_PLATFORM.values())
    for platform in im_targets:
        lbl = _PLAT_LABEL.get(platform, platform)
        try:
            sent = await _deliver_im(uid, f"⏰ {name}\n\n{text}", platform)
            result[lbl] = "已发送" if sent else "无可触达地址（先给该 bot 发条消息）"
            if sent:
                # 把推送写进 IM 会话历史，用户回复时咕咕才有上下文（隐藏临时会话，回复即转正）
                try:
                    await _persist_push_im(uid, platform, name, text)
                except Exception as e:
                    print(f"[sched] {platform} 推送入会话失败: {type(e).__name__}: {e}", flush=True)
        except Exception as e:
            result[lbl] = f"失败：{type(e).__name__}"
            print(f"[sched] {platform} 投递失败: {type(e).__name__}: {e}", flush=True)
    return result


async def _persist_push_im(uid, platform: str, title: str, text: str) -> None:
    """把一条主动推送 append 到该用户在 IM 的最近会话（imsession 指向的那个），使下次回复带上上下文。
    无 imsession（如隔夜冷启）→ 建一个普通会话并把 imsession 指过去。刷新 imsession 12h TTL，
    保证「推送后 12h 内回复」能路由回此会话。"""
    from app.core import redis as R
    import app.db.session as ss
    from app.models import ConversationSession, ConversationMessage

    reach = await get_imreach(uid, platform)
    puid = (reach or {}).get("puid")
    if not puid:
        return
    r = R.get_redis()
    sess_key = f"imsession:{platform}:{puid}"   # 与 worker._im_sess_key 同格式
    try:
        raw = await r.get(sess_key)
        sid = int(raw) if raw else None
    except (TypeError, ValueError):
        sid = None

    uid_u = _as_uuid(uid)
    async with ss._SessionLocal() as db:
        session = await db.get(ConversationSession, sid) if sid else None
        if session is None or session.user_id != uid_u:
            session = ConversationSession(user_id=uid_u, title=(title[:50] or "主动消息"), source=platform)
            db.add(session)
            await db.flush()
        db.add(ConversationMessage(session_id=session.id, role="assistant", content=f"⏰ {title}\n\n{text}"))
        session.updated_at = now_utc()
        await db.commit()
        new_sid = session.id

    try:
        await r.set(sess_key, str(new_sid), ex=12 * 3600)
    except Exception:
        pass


async def _run_agent(user_id, prompt: str, context_config: dict | None = None) -> str:
    from agent.runner import run_ephemeral
    import app.db.session as ss
    from app.models import User
    async with ss._SessionLocal() as db:
        u = await db.get(User, _as_uuid(user_id))
        uname = (u.display_name or u.username) if u else ""
    text = await run_ephemeral(user_id, uname, prompt, context_config=context_config)
    return text or "（咕咕这次没有产出内容）"


# 渠道 → IM 平台标识（worker 里 QQ 的 platform 是 "qqbot"）
_CHAN_PLATFORM = {"feishu": "feishu", "qq": "qqbot", "wechat": "wechat"}
_PLAT_LABEL = {"feishu": "飞书", "qqbot": "QQ", "wechat": "微信"}


def _scheduled_delivery_targets(chans: set) -> str:
    """把任务配置转换成模型可理解的投递范围；只描述配置，不承诺实际触达。"""
    labels = []
    if {"web", "chat"} & chans:
        labels.append("网页通知")
    for channel, platform in _CHAN_PLATFORM.items():
        if channel in chans:
            labels.append(_PLAT_LABEL[platform])
    if "im" in chans:
        labels.append("已配置的即时通讯平台")
    return "、".join(dict.fromkeys(labels)) or "未指定渠道"


# ── IM 投递 ──────────────────────────────────────────────────────────────────
async def _has_enabled_bot(user_id, platform: str) -> bool:
    """该用户在该平台是否有 enabled 的 bot。保险二：解绑后即使地址残留也不投递。"""
    import app.db.session as ss
    from app.models import UserBot
    from sqlalchemy import select
    async with ss._SessionLocal() as db:
        row = (await db.execute(
            select(UserBot.id).where(
                UserBot.user_id == _as_uuid(user_id),
                UserBot.platform == platform,
                UserBot.enabled.is_(True),
            )
        )).first()
    return row is not None


async def _deliver_im(user_id, text: str, platform: str | None = None) -> bool:
    """主动 DM 到指定 IM 平台。platform=None 时发到最近一次可触达平台（兜底）。
    飞书可主动；QQ 主动受限，best-effort。返回是否真的投出（无地址/无活绑定=False）。"""
    # 保险二：必须有该平台的 enabled bot 才发——解绑后绝不发给旧账号
    if platform and not await _has_enabled_bot(user_id, platform):
        return False
    reach = await get_imreach(user_id, platform)
    if not reach:
        return False   # 该平台没用过/无可触达地址，跳过
    import worker
    payload = {
        "platform": reach.get("platform"),
        "channel_id": reach.get("channel_id"),
        "chat_id": reach.get("chat_id"),
        "platform_user_id": reach.get("puid"),
        "context_token": reach.get("context_token", ""),   # 微信 iLink 必需，其他平台为空
    }
    await worker._send(payload, text)
    return True


# ── IM 可触达地址（worker 收到消息时记一份，主动推送时用）──────────────────────
def _reach_key(user_id, platform: str | None = None) -> str:
    return f"imreach:{user_id}:{platform}" if platform else f"imreach:{user_id}"


async def save_imreach(user_id, platform, channel_id, chat_id, puid, context_token: str = "") -> None:
    from app.core import redis as R
    data = json.dumps({"platform": platform, "channel_id": channel_id, "chat_id": chat_id, "puid": puid,
                       "context_token": context_token})
    try:
        r = R.get_redis()
        # 按平台键（精确投递）+ 最近键（兜底/旧逻辑），都 90 天滚动刷新
        await r.set(_reach_key(user_id, platform), data, ex=90 * 86400)
        await r.set(_reach_key(user_id), data, ex=90 * 86400)
    except Exception:
        pass


async def get_imreach(user_id, platform: str | None = None) -> dict | None:
    from app.core import redis as R
    try:
        r = R.get_redis()
        if platform:
            v = await r.get(_reach_key(user_id, platform))
            if v:
                return json.loads(v)
            v = await r.get(_reach_key(user_id))   # 兜底：最近键正好是该平台
            d = json.loads(v) if v else None
            return d if d and d.get("platform") == platform else None
        v = await r.get(_reach_key(user_id))
        return json.loads(v) if v else None
    except Exception:
        return None


async def clear_imreach(user_id, platform: str) -> None:
    """解绑某平台时清掉可触达地址：删按平台键 + 若最近键正好是该平台也删（保险一）。"""
    from app.core import redis as R
    try:
        r = R.get_redis()
        await r.delete(_reach_key(user_id, platform))
        v = await r.get(_reach_key(user_id))
        if v and json.loads(v).get("platform") == platform:
            await r.delete(_reach_key(user_id))
    except Exception:
        pass
