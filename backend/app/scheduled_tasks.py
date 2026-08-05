"""定时任务：DB 驱动的引擎（reconcile）+ 执行 + 投递。

worker 进程每 ~30s 调 `reconcile()`：从 `scheduled_tasks` 表读启用任务，同步到 APScheduler。
任务触发 → `execute_task` → 构造上下文 prompt → agent 生成回复 →
  ① SSE notification 事件（前端侧边栏铃铛弹窗）
  ② IM 主动 DM（飞书可主动；QQ best-effort）
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid as _uuid
from datetime import datetime, timedelta

from sqlalchemy import select

from app.core.redaction import diag_log, redact
from app.core.tz import LOCAL_TZ, local_now, now_utc

_synced: dict[str, str] = {}   # job_id -> 上次同步用的 updated_at，变了才重挂
logger = logging.getLogger(__name__)


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
        gc = [t for t in all_tasks if t.last_run_at is None and _once_expired(t.cron, now)]
        gc_ids = {t.id for t in gc}
        if gc:
            gc_uids = {t.user_id for t in gc}
            for t in gc:
                await db.delete(t)
            await db.commit()
            print(f"[sched] GC {len(gc)} 个过期一次性任务: {sorted(gc_ids)}", flush=True)
            await _notify_tasks_changed(gc_uids)   # 自动清 → 定时面板实时刷
        # 崩溃的一次性任务（跑过、没标失败、锁也没了）不能只等用户凑巧打开面板才
        # 被修复——这里每轮 reconcile 都顺手扫一遍，转成失败态，让用户能在面板里
        # 看到并重试，而不是无声无息地卡在"跑过但没结果"的状态里。
        abandoned = await _reap_abandoned_once_tasks(db, [t for t in all_tasks if t.id not in gc_ids])
        if abandoned:
            print(f"[sched] {len(abandoned)} 个一次性任务判定为崩溃，已标记失败: {sorted(t.id for t in abandoned)}", flush=True)
            await _notify_tasks_changed({t.user_id for t in abandoned})
        tasks = [
            t for t in all_tasks
            if t.enabled
            and t.id not in gc_ids
            and not ((t.cron or "").startswith("@once:") and t.last_run_at is not None)
        ]

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
            diag_log("app.scheduled_tasks.build_trigger", e)
            print(f"[sched] 任务 {t.id} 触发器非法: {redact(type(e).__name__)}", flush=True)
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
# 跨进程任务锁：调度触发（Worker 进程）和「立即试运行」（Web 进程）都调同一个
# execute_task()，用户连点两次试运行也会并行。没有锁的话，会调 create_project/
# update_file 这类工具的任务可能重复产生副作用和重复消息。timeout 是崩溃兜底
# （进程死掉忘记 release 时自动过期），不是正常执行时长上限。
_SCHEDULED_LOCK_TIMEOUT = 600   # 秒
_SCHEDULED_LOCK_RENEW_INTERVAL = 180   # 秒；须显著小于 timeout，留够网络抖动的余量


def _scheduled_lock_key(task_id: int) -> str:
    return f"scheduled:lock:{task_id}"


async def _renew_lock_periodically(lock) -> None:
    """任务执行期间的锁续租心跳：Agent 调用可能远超 timeout（复杂工具链/慢响应），
    没有续租的话锁会在任务还在跑的时候过期，导致 `_once_task_is_in_flight()` 误判
    成"已崩溃"，用户点重试后两个正式执行并发跑，产生重复的工具副作用和重复消息。
    只在自己被取消（finally 释放锁）时停止，异常单次续租失败不致命——下一轮重试。"""
    while True:
        await asyncio.sleep(_SCHEDULED_LOCK_RENEW_INTERVAL)
        try:
            await lock.extend(_SCHEDULED_LOCK_TIMEOUT, replace_ttl=True)
        except Exception as e:
            diag_log("app.scheduled_tasks.renew_lock", e)


async def _once_task_is_in_flight(task_id: int, last_run_at) -> bool:
    """判断一次性任务是不是"正在执行、还没写完结果"，而不是真的已经完结（成功/失败）。

    只看 last_run_at/last_run_failed 区分不出"还在跑"和"跑崩了没收尾"——两者都是
    last_run_at 非空、last_run_failed=False。这里额外查 Redis 锁：锁还在，就是真的
    正在跑；锁没了但离 last_run_at 还没超过锁的 timeout，给一段宽限（避免执行刚结束、
    锁刚释放，DB 还没来得及写 last_run_failed 的那一瞬间被误判成"已经完结"）；
    过了这段宽限锁还没了，说明进程大概率是崩了——不再当成"正在跑"，允许被当作
    失败对待（不再挡列表清理/重新触发）。
    """
    if last_run_at is None:
        return False
    from app.core.redis import get_redis
    try:
        if await get_redis().exists(_scheduled_lock_key(task_id)):
            return True
    except Exception:
        # Redis 查不到就保守当作"可能还在跑"，不能因为 Redis 抖动就把正在执行的
        # 任务当成崩溃清理掉。
        return True
    from datetime import timezone as _tz
    at = last_run_at if last_run_at.tzinfo else last_run_at.replace(tzinfo=_tz.utc)
    return (now_utc() - at) < timedelta(seconds=_SCHEDULED_LOCK_TIMEOUT)


async def _reap_abandoned_once_tasks(db, tasks) -> list:
    """把"跑过、没标失败、没在跑（锁也没了）"的一次性任务转成失败态。

    供 list_tasks()（用户开面板时）和 reconcile()（worker 每 ~30s 一轮，不依赖
    用户主动打开面板）共用——否则崩溃任务只有在用户凑巧点开定时任务面板时才会
    被修复成可重试状态，reconcile() 本身此前对这批任务视而不见。
    """
    abandoned = []
    now = local_now()
    for t in tasks:
        if not (t.cron or "").startswith("@once:"):
            continue
        if t.last_run_at is None or t.last_run_failed or not _once_expired(t.cron, now):
            continue
        if await _once_task_is_in_flight(t.id, t.last_run_at):
            continue
        abandoned.append(t)
    if abandoned:
        for t in abandoned:
            t.last_run_failed = True
        await db.commit()
    return abandoned


async def execute_task(task_id: int, is_trial: bool = False) -> dict:
    """执行一次任务，返回各渠道投递结果 {渠道: 状态}（试运行据此给用户反馈）。

    同一 task_id 同一时刻只允许一处在跑：试运行和正式触发共用同一把 Redis 锁，
    拿不到锁直接返回「正在执行」，不排队等待（避免堆积重复触发）。
    """
    from app.core.redis import get_redis
    from redis.exceptions import LockError

    # thread_local=False：asyncio 单线程多协程共享 threading.local()，用默认值会
    # 让并发的其它协程也读到这把锁的 token，release 时的 token 校验形同虚设。
    lock = get_redis().lock(
        _scheduled_lock_key(task_id), timeout=_SCHEDULED_LOCK_TIMEOUT, thread_local=False,
    )
    if not await lock.acquire(blocking=False):
        return {"错误": "任务正在执行，请稍后再试"}

    renew_task = asyncio.create_task(_renew_lock_periodically(lock))
    try:
        import app.db.session as ss
        from app.models import ScheduledTask
        result: dict = {}
        async with ss._SessionLocal() as db:
            t = await db.get(ScheduledTask, task_id)
            if not t or not t.enabled:
                return {"错误": "任务不存在或已停用"}
            payload, uid, name = t.payload or "", t.user_id, t.name
            target_map = t.delivery_targets
            chans = {c for c in (t.channels or "").split(",") if c}
            is_once = (t.cron or "").startswith("@once:")
            # last_run_failed=True：上次触发过但失败了，允许再触发一次；只有"已经成功"
            # 或"正在跑"（last_run_at 非空且没标失败）才拒绝。
            if not is_trial and is_once and t.last_run_at is not None and not t.last_run_failed:
                return {"错误": "一次性任务已经执行过或正在执行"}
            if not is_trial:
                t.last_run_at = now_utc()
                if is_once:
                    t.last_run_failed = False   # 先乐观清掉，失败了 except/失败分支会重新标
            await db.commit()
        try:
            now_str = local_now().strftime("%Y-%m-%d %H:%M")
            target_description = _scheduled_delivery_targets(chans)
            prompt = (
                f"[定时任务触发：{name}]\n"
                f"现在是 {now_str}，用户设置了一条定时任务：{payload}\n"
                f"本轮消息将由系统投递到：{target_description}。\n"
                "请以咕咕的身份完成这项任务，只生成要发给用户的正文。"
                "消息会由定时任务系统自动投递到已配置的渠道，不需要你调用发送工具，"
                "也不要提及渠道、推送、工具不可用或无法发送。"
            )
            text = await _run_agent(uid, prompt, trial=is_trial)
            result = await deliver_to_channels(uid, name, text, chans, target_map)
            if not is_trial and is_once:
                if _delivery_succeeded(result):
                    await _delete_completed_once(task_id, uid)
                else:
                    await _mark_once_failed(task_id)
        except Exception as e:
            diag_log("app.scheduled_tasks.execute_task", e)
            result["错误"] = "任务执行失败"
            print(f"[sched] 执行任务 {task_id} 出错: {redact(type(e).__name__)}", flush=True)
            if not is_trial and is_once:
                await _mark_once_failed(task_id)
        return result
    finally:
        renew_task.cancel()
        try:
            await renew_task
        except asyncio.CancelledError:
            pass
        try:
            await lock.release()
        except LockError:
            pass   # 已经因 timeout 自动过期释放，不是错误


def _delivery_succeeded(result: dict) -> bool:
    """一次性任务只有在所有选定渠道确认发送后才删除。"""
    return not result or all(value == "已发送" for value in result.values())


async def _delete_completed_once(task_id: int, user_id) -> None:
    """成功投递后删除一次性任务；失败/进程中断时保留，便于手动重试。"""
    import app.db.session as ss
    from app.models import ScheduledTask

    async with ss._SessionLocal() as db:
        task = await db.get(ScheduledTask, task_id)
        if task and (task.cron or "").startswith("@once:"):
            await db.delete(task)
            await db.commit()
    await _notify_tasks_changed([user_id])


async def _mark_once_failed(task_id: int) -> None:
    """一次性任务触发但没有成功投递：标记 last_run_failed，允许再触发一次。

    跟 last_run_at（"触发过"）分开：last_run_at 非空 + last_run_failed=True 才是
    "触发过但失败了"，reconcile()/execute_task() 据此区分"已成功"（last_run_at
    非空、行已经被删）、"正在跑或已成功"（last_run_at 非空、没标失败）、
    "失败待重试"（last_run_at 非空、标了失败）三种状态。
    """
    import app.db.session as ss
    from app.models import ScheduledTask

    async with ss._SessionLocal() as db:
        task = await db.get(ScheduledTask, task_id)
        if task:
            task.last_run_failed = True
            await db.commit()


async def deliver_to_channels(
    uid,
    name: str,
    text: str,
    chans: set,
    delivery_targets: dict | None = None,
) -> dict:
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
    targets = delivery_targets if isinstance(delivery_targets, dict) else {}
    for platform in im_targets:
        lbl = _PLAT_LABEL.get(platform, platform)
        channel = next(
            (key for key, value in _CHAN_PLATFORM.items() if value == platform),
            platform,
        )
        target = targets.get(channel)
        if target is None:
            # 旧任务没有保存 delivery_targets。不能再把最近一次群聊地址当成
            # 私聊提醒目标，否则用户在群里聊天后，历史任务会误发到该群。
            target = await _legacy_private_target(uid, platform)
        print(json.dumps({
            "event": "before-send",
            "platform": platform,
            "chat_type": (target or {}).get("chat_type"),
            "has_target": bool(target),
            "has_puid": bool((target or {}).get("puid")),
            "has_chat_id": bool((target or {}).get("chat_id")),
            "has_channel_id": bool((target or {}).get("channel_id")),
        }, ensure_ascii=False), flush=True)
        try:
            sent = await _deliver_im(uid, f"⏰ {name}\n\n{text}", platform, target)
            print(json.dumps({
                "event": "after-send",
                "platform": platform,
                "chat_type": (target or {}).get("chat_type"),
                "ok": sent,
            }, ensure_ascii=False), flush=True)
            if sent:
                result[lbl] = "已发送"
            elif target:
                result[lbl] = "发送失败（请检查该平台连接）"
            else:
                result[lbl] = "无可触达地址（先给该 bot 发条消息）"
            if sent:
                # 把推送写进 IM 会话历史，用户回复时咕咕才有上下文（隐藏临时会话，回复即转正）
                try:
                    await _persist_push_im(uid, platform, name, text, target)
                except Exception as e:
                    diag_log("app.scheduled_tasks.persist_push_im", e)
                    print(f"[sched] {platform} 推送入会话失败: {redact(type(e).__name__)}", flush=True)
        except Exception as e:
            result[lbl] = f"失败：{type(e).__name__}"
            diag_log("app.scheduled_tasks.deliver_to_channels", e)
            print(f"[sched] {platform} 投递失败: {redact(type(e).__name__)}", flush=True)
    return result


async def _persist_push_im(
    uid,
    platform: str,
    title: str,
    text: str,
    target: dict | None = None,
) -> None:
    """把一条主动推送 append 到该用户在 IM 的最近会话（imsession 指向的那个），使下次回复带上上下文。
    无 imsession（如隔夜冷启）→ 建一个普通会话并把 imsession 指过去。刷新 imsession 12h TTL，
    保证「推送后 12h 内回复」能路由回此会话。"""
    from app.core import redis as R
    import app.db.session as ss
    from app.models import ConversationSession, ConversationMessage

    reach = target or await get_imreach(uid, platform)
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


async def _run_agent(
    user_id,
    prompt: str,
    *,
    trial: bool = False,
) -> str:
    """编排定时任务的 execution/report，runner 只负责单阶段 AgentLoop。"""
    import app.db.session as ss
    from app.models import User

    async with ss._SessionLocal() as db:
        u = await db.get(User, _as_uuid(user_id))
        uname = (u.display_name or u.username) if u else ""

    from agent import sanitize
    from agent.runner import run_scheduled_execution, run_scheduled_report

    max_rounds = 2
    last_text = "咕咕这次没有产出内容"
    for round_index in range(max_rounds):
        round_no = round_index + 1
        logger.info(
            "[scheduled-phase] %s",
            json.dumps({"event": "execution-start", "round": round_no, "trial": trial}, ensure_ascii=False),
        )
        execution_text, execution_failed, meta = await run_scheduled_execution(
            user_id, uname, prompt
        )
        meta = meta or {}
        last_text = execution_text or last_text
        mutated = bool(meta.get("mutated"))
        tool_count = len(meta.get("tool_names", []))
        logger.info(
            "[scheduled-phase] %s",
            json.dumps(
                {
                    "event": "execution-finish",
                    "round": round_no,
                    "ok": not execution_failed,
                    "tool_count": tool_count,
                    "mutated": mutated,
                },
                ensure_ascii=False,
            ),
        )
        if execution_failed:
            if mutated or round_no >= max_rounds:
                return sanitize.strip_disallowed_emoji(last_text)
            logger.info(
                "[scheduled-phase] %s",
                json.dumps({"event": "execution-retry", "next_round": round_no + 1}, ensure_ascii=False),
            )
            continue

        if not meta.get("tool_names"):
            logger.info(
                "[scheduled-phase] %s",
                json.dumps({"event": "report-skipped", "round": round_no, "reason": "no-tools"}, ensure_ascii=False),
            )
            return sanitize.strip_disallowed_emoji(execution_text or last_text)

        logger.info(
            "[scheduled-phase] %s",
            json.dumps({"event": "report-start", "round": round_no}, ensure_ascii=False),
        )
        report_text, report_failed = await run_scheduled_report(
            user_id, uname, prompt, execution_text
        )
        logger.info(
            "[scheduled-phase] %s",
            json.dumps({"event": "report-finish", "round": round_no, "ok": not report_failed}, ensure_ascii=False),
        )
        if not report_failed:
            return sanitize.strip_disallowed_emoji(report_text or execution_text or last_text)

        logger.info(
            "[scheduled-phase] %s",
            json.dumps({"event": "report-retry-start", "round": round_no}, ensure_ascii=False),
        )
        report_text, report_failed = await run_scheduled_report(
            user_id, uname, prompt, execution_text
        )
        logger.info(
            "[scheduled-phase] %s",
            json.dumps({"event": "report-retry-finish", "round": round_no, "ok": not report_failed}, ensure_ascii=False),
        )
        if report_failed:
            # report 两次都失败：execution 已经成功产出了内容，report 只是负责把它
            # 转述成更合适的措辞——report 失败时错误文案通常也非空，`report_text or
            # execution_text` 这种写法会优先把错误文案发给用户，而不是已经有的
            # execution 结果。两次都失败就直接用 execution 的产出兜底，不用 report_text。
            return sanitize.strip_disallowed_emoji(execution_text or last_text)
        return sanitize.strip_disallowed_emoji(report_text or execution_text or last_text)

    return sanitize.strip_disallowed_emoji(last_text)


# 渠道 → IM 平台标识（worker 里 QQ 的 platform 是 "qq"）
_CHAN_PLATFORM = {"feishu": "feishu", "qq": "qq", "wechat": "wechat"}
_PLAT_LABEL = {"feishu": "飞书", "qq": "QQ", "wechat": "微信"}


async def owner_private_targets(db, user_id, channels: set | list[str] | None) -> dict | None:
    """为网页创建的任务解析固定私聊目标，不依赖最近一次 IM 会话。"""
    channels = set(channels or [])
    wanted = {"qq": "qq", "feishu": "feishu", "wechat": "wechat"}
    selected = {channel: platform for channel, platform in wanted.items() if channel in channels}
    if not selected:
        return None

    from app.models import UserBot

    targets = {}
    for channel, platform in selected.items():
        row = (
            await db.execute(
                select(UserBot)
                .where(
                    UserBot.user_id == _as_uuid(user_id),
                    UserBot.platform == platform,
                    UserBot.enabled.is_(True),
                )
                .order_by(UserBot.id.asc())
            )
        ).scalars().first()
        targets[channel] = {
            "platform": platform,
            "chat_type": "c2c",
            "chat_id": None,
            "puid": row.owner_platform_user_id if row else None,
            "channel_id": str(row.id) if row else None,
        }
    return targets


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


async def _legacy_private_target(user_id, platform: str) -> dict | None:
    """解析没有固定目标的旧任务，只返回 owner 私聊地址。

    早期任务没有 ``delivery_targets``，只能兼容旧的可触达地址。群聊地址
    不属于安全的兼容目标：它通常只是用户最近一次发言的群，不能代表用户
    创建任务时的投递意图。
    """
    import app.db.session as ss
    from app.models import UserBot

    async with ss._SessionLocal() as db:
        row = (await db.execute(
            select(UserBot).where(
                UserBot.user_id == _as_uuid(user_id),
                UserBot.platform == platform,
                UserBot.enabled.is_(True),
            ).order_by(UserBot.id.asc())
        )).scalars().first()
    if row and row.owner_platform_user_id:
        return {
            "platform": platform,
            "chat_type": "c2c",
            "chat_id": None,
            "puid": row.owner_platform_user_id,
            "channel_id": str(row.id),
        }

    reach = await get_imreach(user_id, platform)
    if not reach or reach.get("chat_type") == "group" or reach.get("chat_id"):
        return None
    return reach


async def _deliver_im(
    user_id,
    text: str,
    platform: str | None = None,
    target: dict | None = None,
) -> bool:
    """主动 DM 到指定 IM 平台。未传目标时只兼容 owner 私聊地址。
    飞书可主动；QQ 主动受限，best-effort。返回是否真的投出（无地址/无活绑定=False）。"""
    # 保险二：必须有该平台的 enabled bot 才发——解绑后绝不发给旧账号
    if platform and not await _has_enabled_bot(user_id, platform):
        return False
    reach = target or await _legacy_private_target(user_id, platform)
    if not reach:
        return False   # 该平台没用过/无可触达地址，跳过
    payload = {
        "platform": reach.get("platform"),
        "channel_id": reach.get("channel_id"),
        "chat_id": reach.get("chat_id"),
        "platform_user_id": reach.get("puid"),
        "chat_type": reach.get("chat_type") or ("group" if reach.get("chat_id") else "c2c"),
        "context_token": reach.get("context_token", ""),   # 微信 iLink 必需，其他平台为空
    }
    from agent.im.replies import send_text
    return await send_text(payload, text)


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
