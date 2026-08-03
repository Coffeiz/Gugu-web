"""IM 消息 worker：独立进程，消费队列 → 跑非流式 agent →（暂打印）→ ack。

独立于 web 进程运行（避免多 uvicorn worker 各自重复消费长连接/队列）。
启动（从 backend/ 跑，加载 .env）：
    .venv/bin/python -m worker      # 或 python worker.py

消息体（由网关 produce，step 6 补平台用户→咕咕用户映射）：
    {platform, platform_user_id, user_id, user_name, text, session_id?}

step 3 阶段只打印回复、不发平台；发送在 step 5 接平台时补。
"""
from __future__ import annotations

import asyncio
import os
import signal
import socket

from app.core import redis as R
from agent.im.loop import (
    finish_im_activity,
    finalize_im_response,
    handle_im_command,
    apply_im_shortcut_cancel,
    bind_im_context,
    decide_im_shortcut,
    prepare_message,
    persist_im_session,
    record_passive_im_message,
    remember_im_reach,
    select_loop,
    should_record_passive_group,
    start_im_activity,
)
from agent.im.files import send_files as _send_files
from agent.im.models import PlatformMessage
from agent.im.replies import _fix_loose_bold, send_stream_with_fallback, send_text
from agent.models import AgentRequest

STREAM = R.IM_INBOUND_STREAM
GROUP = "agent-workers"
# 稳定 consumer 名：重启不换名（原来带 pid，每次重启留个死 consumer 累积，见地基 B）。
# 多 worker 时给每实例设 GUGU_WORKER_SLOT=0/1/2 区分。
_slot = os.getenv("GUGU_WORKER_SLOT", "").strip()
CONSUMER = socket.gethostname() + (f"-{_slot}" if _slot else "")

_stop = asyncio.Event()

# ── P1-① 有界并发（worker 基本在等 LLM，IO 密集，串行白白浪费事件循环）──────────
# 并发上限由 Admin 配置 agent.worker_concurrency 控制，worker 每 30s（reconcile 时）热读、无需重启。
# 实测单 MiniMax key 安全上限≈16（带工具 sem=20 全 429）；要更大吞吐 = 多备 key，不是调大此数。
_max_concurrency = 16                          # 当前生效值（_refresh_concurrency 热更新；run_once 据此留空闲槽）
_user_locks: dict[str, asyncio.Lock] = {}      # user_gate：同用户串行保序、不同用户并发
_inflight: set = set()                         # 在跑任务集：背压计数 + 优雅 drain

# ── 输入防抖：QQ 等平台「一张图一条消息」，连发的图 + 后面的指令本是一次表达。
#    不立即处理，攒进缓冲；同一用户每来一条就把「截止时刻」推后；静默到期才把缓冲里所有消息
#    合并成「一轮」处理、只回一次。**非对称窗口**：带文字的消息 = 用户说完了 → 短窗口快速回；
#    纯附件（图/文件没配文字）= 多半还在补图 / 正手打指令 → 给更长窗口等后面的指令（先发图、隔
#    几秒再打「存一下」也能并进同一轮，否则指令那轮手上没图、咕咕反问「存什么」）。
DEBOUNCE_SEC = 1.0          # 带文字：用户说完了，快速处理
DEBOUNCE_ATT_SEC = 1.0     # 纯附件：与文字同 1s（reset 仍能攒连发的图；快，但发完图停顿>1s 再打指令会拆轮）
_user_buffers: dict[str, list] = {}            # puid -> [(msg_id, payload)] 待处理缓冲
_user_deadline: dict[str, float] = {}          # puid -> 防抖截止时刻（loop.time()），每条新消息推后
_user_flush: dict[str, asyncio.Task] = {}      # puid -> 正在跑的 flush loop（每用户至多一个）
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


_DEFAULT_HINT = "你好，我是咕咕 🐦\n这个机器人还没和咕咕账号关联好，去咕咕「个人设置 → 接入咕咕」重新扫码连接一下吧。"


async def handle(msg_id: str, payload: dict):
    """处理一条：解析用户 → 未绑定回提示 / 已绑定跑 agent（带会话历史）→ 发回平台。"""
    # Phase 1：在保留旧 payload 的前提下建立平台无关消息视图；后续 IM Loop 将直接消费它。
    platform_message = PlatformMessage.from_payload(payload)
    # 后续兼容链路统一消费协议归一化结果；未知字段会由 to_payload 保留，旧 Gateway
    # 仍可继续提供 worker 尚未迁移的业务字段。
    payload = platform_message.to_payload(payload)
    prepared = await prepare_message(payload, platform_message)
    if prepared is None:
        # 认不出（bot 没 owner，理论上不该发生）：回提示，不跑大脑
        await send_text(payload, _DEFAULT_HINT)
        print(f"[worker] 未绑定用户 {payload.get('platform_user_id')}，已回提示", flush=True)
        return None

    req = prepared.request
    user_id = req.user_id
    platform = prepared.actor.platform
    puid = prepared.actor.platform_user_id
    # 群聊按群维度共享，私聊按发言人维度续聊；作用域和 session 已由 IM Loop 门面解析。
    session_route = prepared.session_route
    session_key = session_route.scope_id
    sid = prepared.session_id

    im_role = prepared.role
    allowed_tool_names = prepared.allowed_tool_names
    # 恢复全链路 trace（网关生成、payload 接力；防抖合并取最后一条的）——此后本任务内
    # 的工具轨迹/回复日志自动带同一 trace，可与网关「收到」行 grep 串联
    from agent import trace
    _tid = trace.set_trace(payload.get("trace_id"))

    # session_id 属于 worker 的路由状态，不由 Loop 门面猜测或持久化。
    req.session_id = sid
    agent_loop = select_loop(req)
    # QQ 群聊普通消息的“读取群消息”模式：只记录到同一会话，不跑模型也不回复；
    # 被 @ 的消息不走此分支，继续执行完整的回应链路。
    if should_record_passive_group(req, payload):
        passive_sid = await record_passive_im_message(req, sid)
        await persist_im_session(platform, session_key, passive_sid, group=True)
        print(f"[worker] qqbot 群聊普通消息已记录(session={passive_sid} trace={_tid})", flush=True)
        return None
    # Intent shortcut 属于 IM Loop 的业务决策；Gateway 只负责接收并入队，不提前决定
    # 是否调用 Agent。附件消息始终进入主链路，避免把媒体内容误判成短路指令。
    shortcut = await decide_im_shortcut(
        platform,
        puid or "",
        req.message,
        has_attachments=bool(req.attachments),
    )
    if shortcut["action"] == "drop":
        return None
    if shortcut["action"] in ("reply", "cancel"):
        await apply_im_shortcut_cancel(platform, puid or "", shortcut)
        await send_text(payload, shortcut["reply"])
        await finalize_im_response(platform, puid or "", shortcut["action"] == "cancel", shortcut["reply"])
        print(f"[worker] {platform} intent shortcut(trace={_tid}) → 已短路回复", flush=True)
        return None
    # 记忆控制命令（/memory /forget，中文别名 /记忆 /忘记）：确定性短路，零 LLM、不计精力、
    # 不反思、不进会话历史——与 web 路（gateway/web.py）同一处理，IM 用户同享隐私控制权（P0-5）
    cmd_reply = await handle_im_command(user_id, req.message)
    if cmd_reply is not None:
        await send_text(payload, cmd_reply)
        print(f"[worker] {platform} 记忆命令(trace={_tid}) → 已短路回复", flush=True)
        return None

    # 把 IM 上下文透传给工具层（react 工具据此给用户这条消息加表情；State Manager 据此打细粒度状态；
    # chat_type/context_token 供慢工具进度声明主动推送时直接拼 IM 回复 payload 用）
    bind_im_context(req, payload)
    # 记一份「可触达地址」：定时任务/主动推送时按 user_id 反查这里发 IM。
    await remember_im_reach(user_id, platform, payload, puid)
    # State Manager + typing：由 IM Loop 统一管理执行生命周期。
    activity = await start_im_activity(payload, platform, puid)
    stream_sent = False
    try:
        # 飞书流式回复（2026-07-09 接入）：feishu 平台走 run_stream → feishu.send_text_stream，
        # 把 token 实时 patch 到飞书卡片（IM 端模拟 SSE 体感）；其他平台继续走 run_collect 非流式。
        if platform == "feishu":
            token_iter = agent_loop.run_stream(req)
            # 回复层消费完整个 token_iter，并在流式失败时负责普通文本 fallback。
            stream_sent, resp, reply_text = await send_stream_with_fallback(payload, token_iter)
        else:
            resp = await agent_loop.run_collect(req)
    finally:
        await finish_im_activity(activity)
    await persist_im_session(
        platform,
        session_key,
        resp.session_id,
        group=bool(payload.get("chat_type") == "group"),
    )
    if resp.cancelled:
        # 用户中途「算了」：网关已回「先不继续啦」，这里不再补发任何内容
        await finalize_im_response(platform, puid, True, "")
        print(f"[worker] {platform} 任务被用户取消，跳过回复", flush=True)
        return resp
    # 表情回应已由网关「秒回」（_on_message 收到即发），这里不再补
    # QQ 的「思考中」占位只认文本/markdown 被动回复，不认媒体消息（文件/图片）。
    # 咕咕光发文件、没配文字时补一句短文本，让被动回复成立、思考态能正常消解。
    if platform != "feishu":
        reply_text = _fix_loose_bold(resp.text or "")
        if not (reply_text or "").strip():
            # 模型没出文本：有文件配一句「给你～」，纯空则给个兜底——别发空
            #（空内容发 QQ 会报「无效 markdown content」，用户啥也收不到）
            reply_text = "给你～" if resp.files else "嗯~在的，你说～"
        # 先提交媒体，再发送说明文字，避免先报「图发了」再补一条失败提示。
        file_result = await _send_files(payload, resp.files)
        if file_result.failed:
            reply_text = file_result.reason or "附件没有成功发出，你可以去网页或文件库查看。"
        await send_text(payload, reply_text)
    elif resp.files:
        await _send_files(payload, resp.files)   # 流式卡片已建立；文件仍在收尾阶段外发
    # 这条以提问/确认收尾 → 置「等回话」标志，网关下条「嗯/好/算了」就放行进 agent。
    await finalize_im_response(platform, puid, False, reply_text)
    # 隐私：不打印回复原文（此前全文不截断，比收到那侧还暴露），只留结构+指纹（见 agent/logsafe.py）
    from agent import logsafe
    print(f"[worker] {platform} 回复(session={resp.session_id} trace={_tid}) len={len(reply_text)} "
          f"fp={logsafe.fingerprint(reply_text)}", flush=True)
    return resp


def _merge_payloads(payloads: list) -> dict:
    """把同一用户连发的多条消息合并成一条：拼接非空文字、合并所有附件；路由字段（message_id /
    channel_id 等）取**最后一条**——被动回复 / 表情挂在最近那条上。"""
    base = dict(payloads[-1])
    texts, atts = [], []
    for p in payloads:
        t = (p.get("text") or "").strip()
        if t:
            texts.append(t)
        atts.extend(p.get("attachments") or [])
    base["text"] = "\n".join(texts)
    base["attachments"] = atts
    return base


async def _flush_loop(puid: str):
    """等该用户「静默满 DEBOUNCE_SEC」→ 把缓冲里所有消息合并成一轮处理、只回一次。
    处理期间新到的消息进新缓冲，本 loop 跑完会再攒再处理，直到缓冲空才退出。
    用「截止时刻不断被推后」轮询、不 cancel——cancel 会打断正在跑的 run_collect。"""
    loop = asyncio.get_event_loop()
    try:
        while True:
            # 等防抖：截止时刻被新消息不断推后，就一直等到它不再往后挪
            while True:
                now = loop.time()
                dl = _user_deadline.get(puid, now)
                if now >= dl:
                    break
                await asyncio.sleep(dl - now)
            lock = _user_locks.setdefault(puid, asyncio.Lock())
            async with lock:
                batch = _user_buffers.pop(puid, [])
                if not batch:
                    _user_deadline.pop(puid, None)
                    _user_flush.pop(puid, None)
                    return
                merged = _merge_payloads([p for _, p in batch])
                rep_msg_id = batch[-1][0]
                async with _run_sem:     # 多用户同时活跃时，跑 agent 的全局并发上限
                    try:
                        await handle(rep_msg_id, merged)
                    except Exception as e:
                        print(f"[worker] flush handle 出错（已 ack 丢弃，避免毒消息循环）: {type(e).__name__}: {e}", flush=True)
                    finally:
                        for mid, _ in batch:
                            await R.ack(STREAM, GROUP, mid)
    finally:
        _user_flush.pop(puid, None)


async def _dispatch(msg_id: str, payload: dict):
    """幂等去重 → 投入「防抖缓冲」（不立即处理）。同一用户 1s 内连发的消息攒成一轮、只回一次。"""
    # 幂等：同一 stream 条目被 claim_stale（60s）重投时跳过，防重复（在投缓冲前就丢）
    try:
        fresh = await R.get_redis().set(f"imseen:{msg_id}", "1", ex=3600, nx=True)
    except Exception:
        fresh = True
    if not fresh:
        await R.ack(STREAM, GROUP, msg_id)
        return
    puid = payload.get("platform_user_id") or msg_id
    # 投缓冲 + 把截止时刻推后；**不在这里 ack**，留到 flush（崩了未 ack → claim_stale 60s 重投兜底）
    _user_buffers.setdefault(puid, []).append((msg_id, payload))
    has_text = bool((payload.get("text") or "").strip())   # 这条带文字 = 短窗口；纯附件 = 长窗口等指令
    window = DEBOUNCE_SEC if has_text else DEBOUNCE_ATT_SEC
    _user_deadline[puid] = asyncio.get_event_loop().time() + window
    t = _user_flush.get(puid)
    if t is None or t.done():
        nt = asyncio.create_task(_flush_loop(puid))
        _user_flush[puid] = nt
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
    sched.shutdown()
    await R.reset()
    print("[worker] stopped", flush=True)


async def _reconcile_loop():
    """每 30s 从 DB 对账定时任务（增/删/改/开关即时生效，无需重启）。"""
    from app import scheduled_tasks as schedtasks
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
            await schedtasks.reconcile()
        except Exception as e:
            print(f"[worker] 定时任务 reconcile 出错: {type(e).__name__}: {e}", flush=True)


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
