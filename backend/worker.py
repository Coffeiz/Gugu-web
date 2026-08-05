"""IM 消息 worker：独立进程，只负责消费队列、去重、防抖、并发和优雅退出。

独立于 web 进程运行（避免多 uvicorn worker 各自重复消费长连接/队列）。
启动（从 backend/ 跑，加载 .env）：
    .venv/bin/python -m worker      # 或 python worker.py

消息体（由网关 produce，step 6 补平台用户→咕咕用户映射）：
    {platform, platform_user_id, user_id, user_name, text, session_id?}

身份、权限、Agent 执行和平台回复由 ``agent.im.loop`` 统一编排。
"""
from __future__ import annotations

import asyncio
import os
import signal
import socket

from app.core import redis as R
from agent.im.session import ImConversationKey, conversation_key

STREAM = R.IM_INBOUND_STREAM
GROUP = "agent-workers"
REFLECTION_GROUP = "memory-reflection-workers"
CLEANUP_GROUP = "memory-cleanup-workers"
# 稳定 consumer 名：重启不换名（原来带 pid，每次重启留个死 consumer 累积，见地基 B）。
# 多 worker 时给每实例设 GUGU_WORKER_SLOT=0/1/2 区分。
_slot = os.getenv("GUGU_WORKER_SLOT", "").strip()
CONSUMER = socket.gethostname() + (f"-{_slot}" if _slot else "")
REFLECTION_CONSUMER = CONSUMER + "-memory"
CLEANUP_CONSUMER = CONSUMER + "-cleanup"

_stop = asyncio.Event()

# ── P1-① 有界并发（worker 基本在等 LLM，IO 密集，串行白白浪费事件循环）──────────
# 并发上限由 Admin 配置 agent.worker_concurrency 控制，worker 每 30s（reconcile 时）热读、无需重启。
# 实测单 MiniMax key 安全上限≈16（带工具 sem=20 全 429）；要更大吞吐 = 多备 key，不是调大此数。
_max_concurrency = 16                          # 当前生效值（_refresh_concurrency 热更新；run_once 据此留空闲槽）
# user_gate：同一会话串行保序、不同会话并发。key 是 ImConversationKey（platform+bot_id+
# chat_type+scope_id），不是裸 platform_user_id——同一用户跨 bot、跨群或私聊/群聊同时
# 发消息，用 puid 当 key 会被误合并到同一轮/同一把锁（PRD-IM-2 Phase 5 §1 P1）。
_user_locks: dict[ImConversationKey, asyncio.Lock] = {}
_passive_locks: dict[ImConversationKey, asyncio.Lock] = {}
_inflight: set = set()                         # 在跑任务集：背压计数 + 优雅 drain

# ── 输入防抖：QQ 等平台「一张图一条消息」，连发的图 + 后面的指令本是一次表达。
#    不立即处理，攒进缓冲；同一会话每来一条就把「截止时刻」推后；静默到期才把缓冲里所有消息
#    合并成「一轮」处理、只回一次。**非对称窗口**：带文字的消息 = 用户说完了 → 短窗口快速回；
#    纯附件（图/文件没配文字）= 多半还在补图 / 正手打指令 → 给更长窗口等后面的指令（先发图、隔
#    几秒再打「存一下」也能并进同一轮，否则指令那轮手上没图、咕咕反问「存什么」）。
DEBOUNCE_SEC = 1.0          # 带文字：用户说完了，快速处理
DEBOUNCE_ATT_SEC = 1.0     # 纯附件：与文字同 1s（reset 仍能攒连发的图；快，但发完图停顿>1s 再打指令会拆轮）
_user_buffers: dict[ImConversationKey, list] = {}   # key -> [(msg_id, payload)] 待处理缓冲
_user_deadline: dict[ImConversationKey, float] = {} # key -> 防抖截止时刻（loop.time()），每条新消息推后
_user_flush: dict[ImConversationKey, asyncio.Task] = {}  # key -> 正在跑的 flush loop（每会话至多一个）
_buffer_lock = asyncio.Lock()                  # 保护缓冲注册，避免并发 _dispatch 重复创建 flush loop
_flush_tasks: set = set()                       # 所有 flush loop：供优雅 drain 等它们跑完
_run_sem = asyncio.Semaphore(_max_concurrency)  # flush 阶段真正跑 agent 的全局并发上限


def _refresh_concurrency():
    """从 config.override.json 直接热读并发上限（隔离读，不动全局 settings 缓存）。"""
    global _max_concurrency
    val = 16
    try:
        import json as _json
        from app.core.config import OVERRIDE_FILE
        if OVERRIDE_FILE.exists():
            ov = _json.loads(OVERRIDE_FILE.read_text(encoding="utf-8"))
            v = (ov.get("agent") or {}).get("worker_concurrency")
            if v is not None:
                val = int(v)
    except Exception:
        pass
    new = max(1, min(64, val))
    if new != _max_concurrency:
        print(f"[worker] 并发上限 {_max_concurrency} → {new}", flush=True)
    _max_concurrency = new


async def handle(msg_id: str, payload: dict):
    """队列条目的业务处理入口，实际编排由 IM Loop 负责。"""
    from agent.im.loop import dispatch_im_message

    return await dispatch_im_message(payload)


def _merge_payloads(payloads: list) -> dict:
    """把同一用户连发的多条消息合并成一条：拼接非空文字、合并所有附件；路由字段（message_id /
    channel_id 等）取**最后一条**——被动回复 / 表情挂在最近那条上。"""
    base = dict(payloads[-1])
    texts, atts, emoji_refs = [], [], []
    has_face_marker = any(bool(p.get("qq_face_marker")) for p in payloads)
    for p in payloads:
        t = (p.get("text") or "").strip()
        if t:
            if has_face_marker and t == "[QQ表情]" and p.get("qq_face_marker"):
                t = ""
            if t:
                texts.append(t)
        atts.extend(p.get("attachments") or [])
        emoji_refs.extend(
            ref for ref in (p.get("emoji_refs") or [])
            if isinstance(ref, dict)
        )
    base["text"] = "\n".join(texts)
    base["attachments"] = atts
    base["emoji_refs"] = emoji_refs
    base["qq_face_marker"] = has_face_marker
    return base


def _is_passive_group_payload(payload: dict) -> bool:
    """判断消息是否可以绕过正在运行的 Agent，直接记录到群会话。

    这条判断必须只依赖 Gateway 已经写入的回应方式字段，不能提前解析身份或
    读取数据库；这样被动消息才能在同一群的主动模型任务期间实时落库并推送前端。
    """
    return bool(
        payload.get("platform") == "qq"
        and payload.get("chat_type") == "group"
        and payload.get("chat_id")
        and (
            payload.get("group_read_enabled")
            or (
                payload.get("group_requires_at")
                and not payload.get("group_mentioned")
            )
        )
    )


async def _flush_loop(key: ImConversationKey):
    """等该会话「静默满 DEBOUNCE_SEC」→ 把缓冲里所有消息合并成一轮处理、只回一次。
    处理期间新到的消息进新缓冲，本 loop 跑完会再攒再处理，直到缓冲空才退出。
    用「截止时刻不断被推后」轮询、不 cancel——cancel 会打断正在跑的 run_collect。"""
    loop = asyncio.get_event_loop()
    try:
        while True:
            # 等防抖：截止时刻被新消息不断推后，就一直等到它不再往后挪
            while True:
                now = loop.time()
                dl = _user_deadline.get(key, now)
                if now >= dl:
                    break
                await asyncio.sleep(dl - now)
            lock = _user_locks.setdefault(key, asyncio.Lock())
            async with lock:
                batch = _user_buffers.pop(key, [])
                if not batch:
                    _user_deadline.pop(key, None)
                    _user_flush.pop(key, None)
                    return
                merged = _merge_payloads([p for _, p in batch])
                rep_msg_id = batch[-1][0]
                async with _run_sem:     # 多会话同时活跃时，跑 agent 的全局并发上限
                    try:
                        await handle(rep_msg_id, merged)
                    except Exception as e:
                        print(f"[worker] flush handle 出错（已 ack 丢弃，避免毒消息循环）: {type(e).__name__}: {e}", flush=True)
                    finally:
                        for mid, _ in batch:
                            await R.ack(STREAM, GROUP, mid)
    finally:
        _user_flush.pop(key, None)


async def _dispatch(msg_id: str, payload: dict):
    """幂等去重 → 投入「防抖缓冲」（不立即处理）。同一会话 1s 内连发的消息攒成一轮、只回一次。"""
    # 幂等：同一 stream 条目被 claim_stale（60s）重投时跳过，防重复（在投缓冲前就丢）
    try:
        fresh = await R.get_redis().set(f"imseen:{msg_id}", "1", ex=3600, nx=True)
    except Exception:
        fresh = True
    if not fresh:
        await R.ack(STREAM, GROUP, msg_id)
        return
    key = conversation_key(payload)
    if not key.scope_id:
        # 路由字段缺失（理论上不该发生）：退化成按 msg_id 各自成轮，不合并、不跟别的会话共用锁。
        key = ImConversationKey(key.platform, key.bot_id, key.chat_type, msg_id)

    # 静默记录/未被 @ 的群消息不应该排队等当前 LLM 任务结束；否则用户在咕咕
    # 搜索期间发出的消息会一直留在 buffer，直到回复完成才出现在 GuguChat。
    # 被动消息使用独立锁保持群内写入顺序，但不占用主动回复的会话锁。
    if _is_passive_group_payload(payload):
        lock = _passive_locks.setdefault(key, asyncio.Lock())
        try:
            async with lock:
                await handle(msg_id, payload)
        except Exception as e:
            print(f"[worker] 被动群消息处理出错（已 ack 丢弃）: {type(e).__name__}: {e}", flush=True)
        finally:
            await R.ack(STREAM, GROUP, msg_id)
        return

    # 投缓冲 + 把截止时刻推后；**不在这里 ack**，留到 flush（崩了未 ack → claim_stale 60s 重投兜底）。
    # _dispatch 由多个消费 task 并发调用，必须把“注册缓冲 + 创建 flush task”作为
    # 一个临界区，否则两个 task 都可能看到空的 _user_flush，从而把同一群拆成多条 session。
    async with _buffer_lock:
        _user_buffers.setdefault(key, []).append((msg_id, payload))
        has_text = bool((payload.get("text") or "").strip())   # 这条带文字 = 短窗口；纯附件 = 长窗口等指令
        window = DEBOUNCE_SEC if has_text else DEBOUNCE_ATT_SEC
        _user_deadline[key] = asyncio.get_event_loop().time() + window
        t = _user_flush.get(key)
        if t is None or t.done():
            nt = asyncio.create_task(_flush_loop(key))
            _user_flush[key] = nt
            _flush_tasks.add(nt)
            nt.add_done_callback(_flush_tasks.discard)


async def run_once(block_ms: int = 5000) -> int:
    """消费一批并发派发（不阻塞等处理）。按在跑数留空闲槽，防任务无界堆积。返回派发条数。"""
    free = _max_concurrency - len(_inflight)
    if free <= 0:
        await asyncio.sleep(0.1)
        return 0
    # 先回收崩溃 worker 的遗留（>60s 未 ack），再收新消息，合计不超过空闲槽
    msgs = list(await R.claim_stale(STREAM, GROUP, CONSUMER, min_idle_ms=60000, count=free))
    need = free - len(msgs)
    if need > 0:
        msgs += await R.consume(STREAM, GROUP, CONSUMER, count=need, block_ms=block_ms)
    for msg_id, payload in msgs:
        t = asyncio.create_task(_dispatch(msg_id, payload))
        _inflight.add(t)
        t.add_done_callback(_inflight.discard)
    handled = len(msgs)
    return handled


async def _reflection_loop():
    """消费记忆反思任务；业务执行留在 memory executor，不放进 worker 路由层。"""
    from agent.memory.im_reflection import execute_job
    from app.core.config import get_settings

    while not _stop.is_set():
        try:
            messages = await R.consume(
                "memory:reflection",
                REFLECTION_GROUP,
                REFLECTION_CONSUMER,
                count=1,
                block_ms=1000,
            )
            for msg_id, payload in messages:
                job_id = payload.get("job_id")
                try:
                    if job_id is not None:
                        await execute_job(int(job_id), get_settings())
                except Exception as exc:
                    print(
                        f"[worker] 记忆反思任务出错: {type(exc).__name__}",
                        flush=True,
                    )
                finally:
                    await R.ack("memory:reflection", REFLECTION_GROUP, msg_id)
        except asyncio.CancelledError:
            return
        except Exception as exc:
            print(f"[worker] 记忆反思队列出错: {type(exc).__name__}", flush=True)
            await asyncio.sleep(2)


async def _cleanup_loop():
    """消费 scope 删除任务；删除业务不进入 IM 路由和反思执行器。"""
    from agent.memory.scope_lifecycle import CLEANUP_GROUP, CLEANUP_STREAM, execute_scope_deletion

    while not _stop.is_set():
        try:
            messages = await R.consume(
                CLEANUP_STREAM,
                CLEANUP_GROUP,
                CLEANUP_CONSUMER,
                count=1,
                block_ms=1000,
            )
            for msg_id, payload in messages:
                try:
                    tombstone_id = payload.get("tombstone_id")
                    if tombstone_id is not None:
                        await execute_scope_deletion(int(tombstone_id))
                except Exception as exc:
                    print(f"[worker] 记忆 scope 清理出错: {type(exc).__name__}", flush=True)
                finally:
                    await R.ack(CLEANUP_STREAM, CLEANUP_GROUP, msg_id)
        except asyncio.CancelledError:
            return
        except Exception as exc:
            print(f"[worker] 记忆清理队列出错: {type(exc).__name__}", flush=True)
            await asyncio.sleep(2)


async def _heartbeat():
    from app.core import health
    from app.core import scheduler as sched
    while not _stop.is_set():
        jobs = [{
            "id": j.id, "name": j.name,
            "next": j.next_run_time.strftime("%Y-%m-%d %H:%M") if j.next_run_time else None,
        } for j in sched.jobs()]
        await health.beat("worker", {"consumer": CONSUMER, "jobs": jobs})
        for _ in range(health.INTERVAL):
            if _stop.is_set():
                break
            await asyncio.sleep(1)


async def serve():
    await R.ensure_group(STREAM, GROUP)
    await R.ensure_group("memory:reflection", REFLECTION_GROUP)
    await R.ensure_group("memory:cleanup", CLEANUP_GROUP)
    # worker 启动时预热一次数据库引擎，后续 IM 请求复用同一连接池。
    from app.db import session as db_session
    db_session.ensure_engine()
    _refresh_concurrency()
    try:
        n = await R.cleanup_dead_consumers(STREAM, GROUP, CONSUMER)
        if n:
            print(f"[worker] 清理死 consumer {n} 个", flush=True)
    except Exception:
        pass
    print(f"[worker] started · consumer={CONSUMER} · stream={STREAM} · 并发={_max_concurrency}", flush=True)
    hb = asyncio.create_task(_heartbeat())
    # 定时任务引擎：worker 是单实例进程，唯一 owner（web 多 worker 不会重复跑）
    from app.core import scheduler as sched
    from app import scheduled_tasks as schedtasks
    sched.start()
    try:
        await schedtasks.reconcile()             # 立即从 DB 加载一遍
    except Exception as e:
        print(f"[worker] 定时任务初始化出错: {type(e).__name__}: {e}", flush=True)
    sched_task = asyncio.create_task(_reconcile_loop())
    reflection_task = asyncio.create_task(_reflection_loop())
    cleanup_task = asyncio.create_task(_cleanup_loop())
    while not _stop.is_set():
        try:
            await run_once()
        except Exception as e:
            print(f"[worker] loop 出错，2s 后重试: {type(e).__name__}: {e}", flush=True)
            await asyncio.sleep(2)
    # 优雅 drain：收到 SIGTERM 停收新消息后，等在跑的处理完再退（并发后必须，别截断回复）
    #   含防抖 flush loop——停收新消息后它们各自把缓冲清空就退出，别截断正在生成的回复。
    pending = list(_inflight) + list(_flush_tasks)
    if pending:
        print(f"[worker] drain：等 {len(_inflight)} 条派发 + {len(_flush_tasks)} 个缓冲收尾…", flush=True)
        await asyncio.gather(*pending, return_exceptions=True)
    hb.cancel()
    sched_task.cancel()
    reflection_task.cancel()
    cleanup_task.cancel()
    await asyncio.gather(reflection_task, return_exceptions=True)
    await asyncio.gather(cleanup_task, return_exceptions=True)
    sched.shutdown()
    await R.reset()
    print("[worker] stopped", flush=True)


async def _reconcile_loop():
    """每 30s 从 DB 对账定时任务（增/删/改/开关即时生效，无需重启）。"""
    from app import scheduled_tasks as schedtasks
    retry_elapsed = 0
    while not _stop.is_set():
        for _ in range(30):
            if _stop.is_set():
                return
            await asyncio.sleep(1)
        _refresh_concurrency()                   # 顺带热读并发上限（Admin 改了 ≤30s 生效）
        try:
            from app.core.config import get_settings
            get_settings.cache_clear()           # 清缓存 → worker 也热读 Admin 配置（模型策略/分流/行为等，≤30s 生效）
        except Exception:
            pass
        try:
            from agent.memory.reflection import flush_due_group_owner_reflections
            from app.core.config import get_settings

            await flush_due_group_owner_reflections(get_settings())
        except Exception as exc:
            print(f"[worker] owner 群记忆缓冲收束出错: {type(exc).__name__}", flush=True)
        try:
            await schedtasks.reconcile()
        except Exception as e:
            print(f"[worker] 定时任务 reconcile 出错: {type(e).__name__}: {e}", flush=True)
        retry_elapsed += 30
        if retry_elapsed >= 30:
            retry_elapsed = 0
            try:
                from agent.memory.reflection_jobs import requeue_due_jobs
                from agent.memory.scope_lifecycle import requeue_pending_cleanups

                await requeue_due_jobs()
                await requeue_pending_cleanups()
            except Exception as exc:
                print(f"[worker] 记忆反思重试补偿出错: {type(exc).__name__}", flush=True)
        # 空闲收束的产品阈值是 15 分钟，不能跟每小时的失败补偿共用调度周期。
        # settle_idle_scopes() 本身用 last_message_at/settled_at 做幂等闸门，
        # 每 30 秒扫描一次只会增加及时性，不会重复投递同一段消息。
        try:
            from agent.memory.reflection_jobs import settle_idle_scopes

            await settle_idle_scopes()
        except Exception as exc:
            print(f"[worker] 记忆反思空闲收束出错: {type(exc).__name__}", flush=True)


def _install_signals(loop):
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _stop.set)
        except NotImplementedError:
            pass  # 某些平台不支持


def main():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _install_signals(loop)
    try:
        loop.run_until_complete(serve())
    finally:
        loop.close()


if __name__ == "__main__":
    main()
