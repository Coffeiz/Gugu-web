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
from pathlib import Path
from uuid import uuid4

from redis.exceptions import LockNotOwnedError
from sqlalchemy import delete, select

from agent.context import session_snapshot
from agent.context.tokens import content_text, estimate_tokens
from agent.context.audit import session_scope, summary_change

logger = logging.getLogger(__name__)

# provider 预算阈值由 agent.core 读取，普通 run 收尾不推进 baseline。
BASELINE_UPDATE_RATIO = 0.90
_RECENT_HISTORY_KEEP_CHARS = 20_000
# 在模型预算允许时，优先从当前 session history 分支出一次摘要请求，保持稳定
# provider 前缀；超出该上限才退回分块滚动，避免一次摘要输入超过 provider 硬限制。
_COMPRESS_LOCK_TIMEOUT = 300

_PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "compress_conv.md"
_baseline_tasks: dict[int, asyncio.Task] = {}
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


async def _wait_for_baseline_idle(session_id: int) -> None:
    """等待持久化 baseline 更新结束，而不是只看当前进程的 Task。"""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _COMPRESS_LOCK_TIMEOUT
    while True:
        state = await _read_execution_state(session_id)
        if state != "baseline_updating":
            return
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
) -> bool:
    """按 session 串行执行压缩，避免后台任务与手动命令覆盖 baseline。"""
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


def schedule_baseline_update(
    session_id: int,
    user_id: int,
    settings,
    context_tokens: int,
    *,
    actual_usage_tokens: int = 0,
    compaction_applied: bool = False,
) -> None:
    """仅在 provider usage 达到 90% 或本轮已压缩时推进 baseline。"""
    if not session_id:
        return
    context_tokens = max(1, int(context_tokens or 0))
    usage_ratio = max(0.0, float(actual_usage_tokens or 0) / context_tokens)
    logger.info("[runtime-baseline-lifecycle] %s", {
        "session_id": session_id,
        "provider_usage_tokens": int(actual_usage_tokens or 0),
        "model_context_tokens": context_tokens,
        "usage_ratio": round(usage_ratio, 4),
        "compaction_applied": bool(compaction_applied),
        "phase": "schedule",
    })
    if not compaction_applied and usage_ratio < BASELINE_UPDATE_RATIO:
        return
    existing = _baseline_tasks.get(session_id)
    if existing is not None and not existing.done():
        return
    task = asyncio.create_task(
        compress_if_needed(session_id, user_id, settings, force=False),
        name=f"context-baseline:{session_id}",
    )
    _baseline_tasks[session_id] = task

    def _cleanup(done: asyncio.Task) -> None:
        if _baseline_tasks.get(session_id) is done:
            _baseline_tasks.pop(session_id, None)
        try:
            done.exception()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("[compress_conv] session=%s 后台 baseline 更新失败", session_id)

    task.add_done_callback(_cleanup)


async def wait_for_baseline_update(session_id: int | None) -> None:
    """等待当前进程任务和持久化状态，避免下一 run 读取旧水位。"""
    if not session_id:
        return
    task = _baseline_tasks.get(session_id)
    if task is not None:
        try:
            await task
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[compress_conv] session=%s 后台 baseline 更新失败", session_id)
    await _wait_for_baseline_idle(session_id)


async def _compress_if_needed_unlocked(
    session_id: int,
    user_id: int,
    settings,
    *,
    force: bool = False,
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
    if not all_msgs:
        return False

    # 不把本地 token 估算用于决定哪些 history 被保留；保留窗口采用字符硬上限。
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
    # 分支/滚动边界由 compaction.generate_compact_summary 统一管理。
    content_items: list[str] = []
    for m in to_compress:
        raw = m.content_json if m.content_json is not None else m.content
        text = content_text(raw).strip()
        if not text:
            continue
        content_items.append(f"{'用户' if m.role == 'user' else '咕咕'}：{text}")
    if not content_items:
        return False

    # 分支式候选只读取 history 快照，不持有数据库事务；共享策略超限时自动
    # 使用滚动 fallback，结果仍需在下方按 baseline hash 做 CAS 后才能写回。
    from agent.context.compaction import (
        generate_compact_summary,
        resolve_compaction_limits,
    )
    from agent.llm.modelctx import effective_ai
    model_cfg = effective_ai(settings)

    async def call_once(items, previous):
        return await _call_llm(
            "\n\n".join(items), previous, settings, model_cfg=model_cfg,
        )

    summary = await generate_compact_summary(
        content_items,
        prev_summary,
        call_once,
        model_cfg=model_cfg,
    )
    limits = resolve_compaction_limits(model_cfg=model_cfg)
    compression_mode = (
        "branch"
        if estimate_tokens("\n".join(content_items)) + estimate_tokens(prev_summary or "") <= limits.input_tokens
        else "rolling-fallback"
    )
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
        trigger="force" if force else "budget",
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


async def _call_llm(
    conv_text: str,
    prev_summary: str | None,
    settings,
    *,
    model_cfg,
) -> str:
    """通过 ContextBranch 生成/合并摘要，保持与反思相同的 provider 路由。"""
    from agent.context.branch import ContextBranch
    from agent.context.branch_types import BranchInput, BranchPolicy
    from agent.context.compaction import resolve_compaction_limits
    try:
        sys_prompt = _PROMPT_PATH.read_text(encoding="utf-8").strip()
    except Exception:
        sys_prompt = "请将以下对话压缩为简洁摘要，保留关键决定、事实和用户偏好，控制在300字以内："
    if prev_summary:
        user_text = (f"【已有摘要（更早的对话，需与下面新增内容合并、保留全部关键信息）】\n{prev_summary}\n\n"
                     f"【新增对话】\n{conv_text}")
    else:
        user_text = conv_text
    result = await ContextBranch().run(
        BranchInput(stable_system=sys_prompt, delta=user_text, scope="conversation-compaction"),
        BranchPolicy(
            name="compaction",
            output_mode="text",
            max_tokens=resolve_compaction_limits(model_cfg=model_cfg).output_tokens,
            max_retries=0,
        ),
        settings,
    )
    return str(result.output or "").strip() if result.ok else ""
