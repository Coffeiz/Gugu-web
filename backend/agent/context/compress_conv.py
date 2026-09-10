"""对话历史压缩：达到 provider 上下文阈值时推进 baseline，或由 ``/compact`` 主动执行。

手动/请求内触发时，把"超出保留窗口的最老一批"压成摘要。**滚动**：把上一版 summary
一并喂给摘要器合并，不从头重压。
存为每 session 一条 role="summary" 的 ConversationMessage（覆盖更新），并与唯一 baseline 原子推进。

注入：`select_history` 把唯一 summary 置于 history 头部；入口编排将其规范化为
普通的 user history message。它是 baseline 的历史起点，不是动态尾部，也不是另一份
system/snapshot 状态。

自动路径由 ``agent.core`` 根据 provider 实际上下文 usage 达到 90% 时触发；普通 run
收尾不会再按固定字符窗口裁剪。压缩保留窗口只决定达到阈值后的压缩目标，摘要请求的
输入/输出预算跟随本轮实际模型配置。
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from uuid import uuid4

from redis.exceptions import LockNotOwnedError
from sqlalchemy import delete, select

from agent.context import session_snapshot
from agent.context.tokens import content_text, estimate_tokens
from agent.context.audit import session_scope, summary_change

logger = logging.getLogger(__name__)

# provider 实际上下文达到该比例后，由 agent.core 在当前 round 内触发压缩。
AUTO_COMPACTION_RATIO = 0.90
_RECENT_HISTORY_KEEP_CHARS = 20_000
_COMPRESS_LOCK_TIMEOUT = 300
_SESSION_RUN_LOCK_TIMEOUT = 300
_SESSION_RUN_HEARTBEAT_INTERVAL = 15
_BASELINE_WAIT_INTERVAL = 0.1


def _session_lock_key(request) -> str:
    """返回 canonical session 锁键；路由元数据不得生成第二个 session 锁。"""
    session_id = getattr(request, "session_id", None)
    if not session_id:
        raise ValueError("session_run_gate 需要 canonical session_id")
    return f"agent:context:session-run:{int(session_id)}"


def _baseline_matches(session, baseline_id: int, baseline_hash: str) -> bool:
    """判断摘要请求开始时的 baseline 是否仍是当前水位。"""
    current_id = int(getattr(session, "baseline_message_id", 0) or 0)
    current_hash = str(getattr(session, "baseline_message_hash", "") or "")
    return current_id == int(baseline_id or 0) and current_hash == str(baseline_hash or "")


async def _read_execution_state(session_id: int) -> str | None:
    """读取持久化执行状态，供不同 worker 之间共享 baseline 水位。"""
    import app.db.session as _sess
    from app.models import ConversationSession

    async with _sess._SessionLocal() as db:
        session = await db.get(ConversationSession, session_id)
        return str(session.execution_state) if session is not None else None


async def recover_orphaned_session(session_id: int, user_id=None) -> bool:
    """回收进程退出后遗留的 ``running`` / ``baseline_updating`` 会话状态。

    生成任务正常结束会在 genstream 和会话行上分别收口；worker 被杀死或重启
    时，任务的 ``finally`` 不会执行，数据库可能永久停在 ``running``。两种情况
    允许修复：① Redis 明确可用且生成快照、owner、lease 全部消失；② 快照仍在
    但 run 进程心跳已断（probe.stale，crash 后 TTL 内的僵尸快照）——此时同时
    清掉 Redis 残留，否则 is_active 会在整个 TTL 窗口内挡住新消息、让终止按钮
    和续看全部空转。``baseline_updating`` 是基线提交被打断后的孤儿态：只有
    压缩锁（带 TTL）也已消失时才认定写进程不在了，锁还在就仍在提交中。
    """
    from agent.llm import genstream
    from app.models import ConversationSession
    import app.db.session as _sess

    status = await genstream.probe(session_id)
    if not status.get("redis_ok") or (status.get("active") and not status.get("stale")):
        return False
    if status.get("stale"):
        await genstream.reap(session_id)

    baseline_stuck = False
    async with _sess._SessionLocal() as db:
        session = await db.get(ConversationSession, session_id, with_for_update=True)
        if session is None or session.execution_state not in {"running", "baseline_updating"}:
            return False
        if user_id is not None and session.user_id != user_id:
            return False
        if session.execution_state == "baseline_updating":
            # 压缩锁在 baseline_updating 之前取得（见 compress_session），锁消失
            # 才能证明写进程已不在；锁有 TTL，崩溃后最多 _COMPRESS_LOCK_TIMEOUT 秒。
            from app.core import redis as redis_core
            try:
                baseline_stuck = not await redis_core.get_redis().exists(
                    f"agent:context:compress:{session_id}"
                )
            except Exception:
                return False
            if not baseline_stuck:
                return False
        session.execution_state = "idle"
        session.active_run_id = None
        await db.commit()
        if user_id is not None and session.user_id != user_id:
            return False
        session.execution_state = "idle"
        session.active_run_id = None
        await db.commit()

    logger.warning("[compress_conv] session=%s 回收进程退出遗留的生成状态", session_id)
    return True


async def _wait_for_baseline_idle(session_id: int) -> None:
    """等待持久化 baseline 更新结束，而不是只看当前进程的 Task。

    等待期间顺带做孤儿检测：基线提交进程崩溃后 ``baseline_updating`` 没人
    收口（写进程的 finally 不会执行），新消息会一直干等到超时。recover 的
    判据自带压缩锁检查，误伤面为零；这里按低频节流调用即可。
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _COMPRESS_LOCK_TIMEOUT
    next_recover_at = 0.0
    while True:
        state = await _read_execution_state(session_id)
        if state != "baseline_updating":
            return
        now = loop.time()
        if now >= next_recover_at:
            next_recover_at = now + 5.0
            try:
                await recover_orphaned_session(session_id)
            except Exception:
                logger.debug("[compress_conv] session=%s baseline 孤儿检测失败", session_id, exc_info=True)
                await asyncio.sleep(_BASELINE_WAIT_INTERVAL)
                continue
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise TimeoutError(f"session {session_id} baseline 更新等待超时")
        await asyncio.sleep(min(_BASELINE_WAIT_INTERVAL, remaining))


async def _claim_session_run(session_id: int, run_id: str, marked_pending: bool) -> bool:
    """在会话行锁内确认 baseline 已空闲并认领生成状态。"""
    import app.db.session as _sess
    from app.models import ConversationSession

    async with _sess._SessionLocal() as db:
        session = await db.get(ConversationSession, session_id, with_for_update=True)
        if session is None:
            return True
        if session.execution_state == "baseline_updating":
            return False
        if marked_pending:
            session.pending_message_count = max(0, int(session.pending_message_count or 0) - 1)
        session.execution_state = "running"
        session.active_run_id = run_id
        await db.commit()
        return True


@asynccontextmanager
async def session_run_gate(request, run_id: str | None = None):
    """阻止同一 session 的并行生成，并持久化排队状态。

    Redis 只提供跨 worker 的短租约；execution_state/pending_message_count 才是
    session 的事实状态。被动群消息不经过此 gate，因此不会进入主动 pending。
    """
    session_id = getattr(request, "session_id", None)
    run_id = str(run_id or f"run-{uuid4().hex[:16]}")
    marked_pending = False
    if not session_id:
        # 新会话尚未获得数据库 session_id，不存在可竞争的 canonical session；
        # 创建完成后后续请求才进入 session gate。
        yield run_id
        return
    if session_id:
        import app.db.session as _sess
        from app.models import ConversationSession

        async with _sess._SessionLocal() as db:
            session = await db.get(ConversationSession, session_id, with_for_update=True)
            if session is not None and session.execution_state in {"running", "baseline_updating"}:
                session.pending_message_count = int(session.pending_message_count or 0) + 1
                marked_pending = True
                await db.commit()

    from app.core import redis as redis_core
    from agent.llm import genstream

    lock_key = _session_lock_key(request)
    redis = redis_core.get_redis()
    # 进程重启不会执行旧任务的 finally。只有在同一会话没有活跃租约时，
    # 才回收遗留的 Redis 锁；Redis 不可用时 has_live_lease fail-open，避免
    # 把正常运行误判为孤儿。
    try:
        # baseline 压缩阶段生成租约可能已经结束，但外层 session gate 仍必须
        # 持有到压缩完成；此时新请求应排队，不能把这把锁误判成重启遗留锁。
        execution_state = await _read_execution_state(session_id)
        if (
            execution_state != "baseline_updating"
            and await redis.exists(lock_key)
            and not await genstream.has_live_lease(session_id)
        ):
            await redis.delete(lock_key)
            logger.warning("[compress_conv] session=%s 回收重启遗留的会话锁", session_id)
    except Exception:
        logger.debug("[compress_conv] session=%s 检查遗留会话锁失败", session_id, exc_info=True)

    lock = redis.lock(
        lock_key,
        timeout=_SESSION_RUN_LOCK_TIMEOUT,
        blocking=True,
    )
    lock_acquired = False
    session_lock_lost = False
    gate_claimed = False
    pending_consumed = False
    session_claimed = False
    try:
        # 先在拿会话锁前等待一次，减少 baseline 更新期间占住生成队列的时间。
        await _wait_for_baseline_idle(session_id)
        await lock.acquire(blocking=True)
        lock_acquired = True
        while True:
            # baseline 可能在第一次检查后才切到 updating；行锁内的二次检查
            # 与这里的轮询共同消除“检查通过后立即启动”的竞态窗口。
            await _wait_for_baseline_idle(session_id)
            if await _claim_session_run(session_id, run_id, marked_pending):
                pending_consumed = marked_pending
                session_claimed = True
                break
            await asyncio.sleep(_BASELINE_WAIT_INTERVAL)
        await genstream.claim_lease(session_id, run_id)
        gate_claimed = True
    except BaseException:
        if marked_pending and not pending_consumed:
            import app.db.session as _sess
            from app.models import ConversationSession

            async with _sess._SessionLocal() as db:
                session = await db.get(ConversationSession, session_id, with_for_update=True)
                if session is not None:
                    session.pending_message_count = max(0, int(session.pending_message_count or 0) - 1)
                    await db.commit()
        if session_claimed:
            import app.db.session as _sess
            from app.models import ConversationSession

            async with _sess._SessionLocal() as db:
                session = await db.get(ConversationSession, session_id, with_for_update=True)
                if session is not None and session.active_run_id == run_id:
                    # baseline 更新任务可能已经把状态切到 updating；
                    # 清理生成认领时不能覆盖这个状态，否则下一 run 会
                    # 绕过等待直接读取旧 baseline。
                    if session.execution_state != "baseline_updating":
                        session.execution_state = "idle"
                    session.active_run_id = None
                    await db.commit()
        if lock_acquired:
            try:
                await lock.release()
            except Exception:
                logger.exception("[compress_conv] session run gate 释放失败")
        raise

    async def keep_session_lease_alive() -> None:
        nonlocal lock_acquired, session_lock_lost
        while True:
            await asyncio.sleep(_SESSION_RUN_HEARTBEAT_INTERVAL)
            # 两个租约职责不同：生成租约决定前端是否仍可续看，会话锁只负责
            # 防并行。续期其中一个失败时不能短路另一个，否则一次 Redis 抖动
            # 就会让正常生成在下一次心跳后变成“中断”。
            try:
                if not await genstream.renew_lease(session_id, run_id):
                    # 生成租约控制前端续看，会话锁仍负责防止同一 session 并行；
                    # 不能因为前者失效就停止后者续租。
                    logger.warning("[compress_conv] session=%s 生成租约已失效，继续维护会话锁", session_id)
            except LockNotOwnedError:
                session_lock_lost = True
                lock_acquired = False
                logger.warning("[compress_conv] session=%s 会话锁已失效，跳过释放", session_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("[compress_conv] session=%s 生成租约续期失败", session_id)
            try:
                lock_reacquired = await lock.reacquire()
                if lock_reacquired is False:
                    logger.warning("[compress_conv] session=%s 会话锁续期失败", session_id)
                    # redis-py 返回 False 表示当前 token 已不再持有这把锁；
                    # 退出时不能再调用 release()，否则只会制造二次异常。
                    session_lock_lost = True
                    lock_acquired = False
            except asyncio.CancelledError:
                raise
            except Exception:
                # 生成租约仍在时，会话锁偶发续期失败不应中断当前任务；下一次
                # 请求仍会被 DB 状态和生成租约保护，避免并行生成。
                logger.warning("[compress_conv] session=%s 会话锁续期异常", session_id)

    heartbeat = asyncio.create_task(
        keep_session_lease_alive(), name=f"session-lease:{session_id}"
    )
    try:
        yield run_id
    finally:
        if gate_claimed:
            heartbeat.cancel()
            try:
                await heartbeat
            except asyncio.CancelledError:
                pass
            await genstream.release_lease(session_id, run_id)
            if session_id:
                import app.db.session as _sess
                from app.models import ConversationSession

                async with _sess._SessionLocal() as db:
                    session = await db.get(ConversationSession, session_id, with_for_update=True)
                    if session is not None and session.active_run_id == run_id:
                        # 生成结束与 baseline 更新是两个生命周期；不能把后台
                        # baseline_updating 覆盖成 idle，避免竞态放行下一 run。
                        if session.execution_state != "baseline_updating":
                            session.execution_state = "idle"
                        session.active_run_id = None
                        await db.commit()
        if lock_acquired and not session_lock_lost:
            try:
                await lock.release()
            except LockNotOwnedError:
                # 锁可能在最后一次状态检查和 release 之间自然过期；这不是业务失败。
                logger.warning("[compress_conv] session=%s 会话锁已失效，跳过释放", session_id)
            except Exception:
                logger.exception("[compress_conv] session run gate 释放失败")


def fixed_context_parts(snapshot_injection: dict | None) -> list[dict]:
    """只组装稳定 snapshot；summary 由 history builder 放在历史第一条。"""
    return [snapshot_injection] if snapshot_injection else []


async def compress_if_needed(
    session_id: int,
    user_id: int,
    settings,
    *,
    force: bool = False,
    reuse_summary: str | None = None,
    reuse_before_message_id: int | None = None,
) -> bool:
    """按 session 串行执行压缩，避免后台任务与手动命令覆盖 baseline。

    ``reuse_summary``：本 run 刚在 provider round 边界生成的压缩摘要。run 内压缩
    的分支请求已与主对话共享前缀（能命中缓存），baseline 再用摊平文本重放一次
    是一次结构性全冷的 3 万 token 调用，因此 run 收尾时直接复用该摘要，只重算
    baseline 水位。``reuse_before_message_id``（通常是本轮用户消息 id）用来把
    可压缩范围限制在本 run 开始之前——run 内摘要不覆盖本轮自身的消息，复用时
    水位绝不能推进到它们之上。
    """
    from app.core import redis as redis_core

    lock = redis_core.get_redis().lock(
        f"agent:context:compress:{session_id}",
        timeout=_COMPRESS_LOCK_TIMEOUT,
        blocking=force,
        blocking_timeout=15 if force else None,
    )
    if not await lock.acquire(blocking=force, blocking_timeout=15 if force else None):
        logger.info("[compress_conv] session=%s 已有压缩任务运行，跳过重复任务", session_id)
        return False
    await _set_baseline_state(session_id, "baseline_updating")
    persisted = False
    try:
        result = await _compress_if_needed_unlocked(
            session_id, user_id, settings, force=force,
            reuse_summary=reuse_summary,
            reuse_before_message_id=reuse_before_message_id,
        )
        persisted = bool(result)
        return result
    finally:
        await _set_baseline_state(session_id, "idle")
        logger.info(
            "[runtime-baseline-lifecycle] %s",
            {
                "session_id": session_id,
                "persisted": persisted,
                "execution_state": "idle",
            },
        )
        await lock.release()


async def _set_baseline_state(session_id: int, state: str) -> None:
    """把 baseline 更新状态写入 session，避免只依赖进程内 task。"""
    import app.db.session as _sess
    from app.models import ConversationSession

    async with _sess._SessionLocal() as db:
        session = await db.get(ConversationSession, session_id, with_for_update=True)
        if session is None:
            return
        session.execution_state = state
        await db.commit()


async def _compress_if_needed_unlocked(
    session_id: int,
    user_id: int,
    settings,
    *,
    force: bool = False,
    reuse_summary: str | None = None,
    reuse_before_message_id: int | None = None,
) -> bool:
    """检查并执行压缩，返回是否实际执行了压缩。

    ``force`` 仅用于记录主动压缩触发来源；压缩后的完整上下文统一不超过模型上限的 50%。
    没有可整理的旧消息时仍然返回 False，避免凭空调用摘要模型。
    """
    import app.db.session as _sess
    from app.models import ConversationMessage, ConversationSession

    async with _sess._SessionLocal() as db:
        session = await db.get(ConversationSession, session_id)
        if session is None:
            return False
        rows = (await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == session_id)
            .order_by(ConversationMessage.id.asc())
        )).scalars().all()

    prev_summary = next((m.content for m in rows if m.role == "summary"), None)
    baseline_id = int(getattr(session, "baseline_message_id", 0) or 0)
    baseline_hash_before = str(getattr(session, "baseline_message_hash", "") or "")
    all_msgs = [m for m in rows if m.role != "summary" and m.id > baseline_id]
    if reuse_before_message_id:
        # 复用 run 内摘要时，可压缩范围只允许覆盖本 run 开始之前的历史：run 内
        # 压缩把本轮消息整体保护，不会写进摘要；水位若推进到它们之上会丢上下文。
        # 本 run 的消息（含 RAG/姿态注入）都在 finalize 里才拿到 id，因此必然
        # 落在 ``>= reuse_before_message_id`` 一侧，被这条过滤整体排除。
        all_msgs = [m for m in all_msgs if m.id < reuse_before_message_id]
    if not all_msgs:
        return False

    # 不把本地 token 估算用于决定哪些 history 被保留；保留窗口采用字符硬上限。
    # 复用 run 内摘要时这条规则同时保证水位安全：run 内的保留窗口不超过
    # RECENT_HISTORY_KEEP_CHARS 且按工具单元（更粗的粒度）回退，这里的 20k
    # 按单条消息回退、只会保留得更多，因此水位最多推进到 run 内摘要已覆盖的
    # 位置，不会越过被压缩内容。
    target_keep_chars = _RECENT_HISTORY_KEEP_CHARS
    tail_chars = 0
    split_idx = 0
    for i in range(len(all_msgs) - 1, -1, -1):
        raw = all_msgs[i].content_json if all_msgs[i].content_json is not None else all_msgs[i].content
        chars = len(content_text(raw).strip())
        if tail_chars + chars > target_keep_chars:
            split_idx = i + 1
            break
        tail_chars += chars

    to_compress = all_msgs[:split_idx]
    if not to_compress:
        return False

    # 统一读取普通正文和 content_json，工具轮次不能因为正文不在 content 而丢失。
    # content_items 给本地有界兜底用；history_messages 重建出角色序列给追加式摘要用。
    content_items: list[str] = []
    history_messages: list[dict] = []
    for m in to_compress:
        raw = m.content_json if m.content_json is not None else m.content
        text = content_text(raw).strip()
        if not text:
            continue
        content_items.append(f"{'用户' if m.role == 'user' else '咕咕'}：{text}")
        history_messages.append(
            {"role": "user" if m.role == "user" else "assistant", "content": text})
    if not content_items:
        return False

    # 摘要候选只读取 history 快照，不持有数据库事务；结果仍需在下方按
    # baseline hash 做 CAS 后才能写回。
    from agent.context.compaction import (
        _generate_append_summary,
        resolve_compaction_limits,
    )
    from agent.llm.modelctx import effective_ai
    model_cfg = effective_ai(settings)

    limits = resolve_compaction_limits(model_cfg=model_cfg)
    if reuse_summary:
        # run 内压缩刚生成过同一批历史的摘要（且那次分支请求命中了缓存），
        # 不再重放一遍。水位边界仍按上面的保留窗口规则计算。
        summary = reuse_summary
        compression_mode = "run-reuse"
    else:
        # 手动 /compact 等无 run 摘要可复用的场景：从 DB 行重建消息序列走追加式，
        # 与 run 内压缩同一条摘要生成路径（超预算自动分块滚动）。该请求不带
        # 主 run 的 system/工具声明，不指望命中前缀缓存——冷是已知边界，
        # 换来的是全站只剩一条摘要生成路径。
        summary = await _generate_append_summary(
            history_messages, prev_summary, model_cfg=model_cfg,
        )
        compression_mode = "append-replay"
    from agent.context.compaction import validate_compact_summary

    summary_ok, summary_reason = validate_compact_summary(
        summary,
        max_output_tokens=limits.output_tokens,
    )
    if not summary_ok:
        # baseline 更新属于持久化保护路径：供应商超时/返回空时也必须把历史
        # 收敛到有界状态，否则下一轮会再次带上同一批旧消息并重复压缩。
        from agent.context.compaction import _deterministic_summary
        fallback = _deterministic_summary(
            content_items,
            prev_summary,
            max_output_tokens=limits.output_tokens,
        )
        fallback_ok, fallback_reason = validate_compact_summary(
            fallback,
            max_output_tokens=limits.output_tokens,
        )
        if not fallback_ok:
            logger.warning(
                "[compress_conv] session=%s 摘要候选校验失败: %s; 本地兜底失败: %s",
                session_id, summary_reason, fallback_reason,
            )
            return False
        summary = fallback
        compression_mode = "deterministic-fallback"
        logger.warning(
            "[compress_conv] session=%s Provider 摘要不可用，使用本地有界摘要",
            session_id,
        )

    async with _sess._SessionLocal() as db:
        # 重新锁定并读取水位。摘要模型运行期间可能已有另一个进程完成了
        # baseline 更新；旧任务不能把水位回写到更早的位置。
        session = await db.get(ConversationSession, session_id, with_for_update=True)
        if session is None:
            return False
        current_baseline = int(getattr(session, "baseline_message_id", 0) or 0)
        current_baseline_hash = str(getattr(session, "baseline_message_hash", "") or "")
        if not _baseline_matches(session, baseline_id, baseline_hash_before):
            logger.info(
                "[compress_conv] session=%s baseline 已由更新水位接管，跳过旧结果 baseline=%s/%s current=%s/%s",
                session_id, baseline_id, baseline_hash_before[:8],
                current_baseline, current_baseline_hash[:8],
            )
            await db.rollback()
            return False

        await db.execute(delete(ConversationMessage).where(
            ConversationMessage.session_id == session_id,
            ConversationMessage.role == "summary",
        ))
        summary_message = ConversationMessage(session_id=session_id, role="summary", content=summary)
        db.add(summary_message)
        await db.flush()
        session.baseline_message_id = to_compress[-1].id
        session.baseline_message_hash = session_snapshot.baseline_hash(to_compress)
        baseline_after = int(session.baseline_message_id)
        baseline_hash_after = str(session.baseline_message_hash or "")
        session_snapshot.update_baseline_snapshot(
            session,
            [{"role": "summary", "content": summary}],
            baseline_message_id=session.baseline_message_id,
        )
        await db.commit()
        session_snapshot.record_baseline_update(session)

    audit_scope = session_scope(session)
    # summary_change 的 source 是审计事件名，不能与会话自身的 source 字段重复传入。
    audit_scope.pop("source", None)
    summary_change(
        source="persistent_baseline_update",
        old=prev_summary,
        new=summary,
        trigger="force" if force else ("run_reuse" if reuse_summary else "budget"),
        baseline_before=baseline_id,
        baseline_after=to_compress[-1].id,
        compressed_messages=len(to_compress),
        **audit_scope,
    )

    logger.info(
        "[runtime-baseline-lifecycle] %s",
        {
            "session_id": session_id,
            "baseline_before": baseline_id,
            "baseline_after": baseline_after,
            "baseline_hash_before": baseline_hash_before[:12],
            "baseline_hash_after": baseline_hash_after[:12],
            "compaction_applied": True,
            "persisted": True,
            "execution_state": "baseline_updating",
        },
    )

    logger.info("[compress_conv] session %s：%d 条 → summary（%d 字符，%s，mode=%s）",
                session_id, len(to_compress), len(summary),
                "滚动合并" if prev_summary else "首次", compression_mode)
    return True
