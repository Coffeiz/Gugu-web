"""对话历史压缩：run 完成后按软预算后台推进 baseline，或由 ``/compact`` 主动执行。

手动/请求内触发时，把"超出保留窗口的最老一批"压成摘要。**滚动**：把上一版 summary
一并喂给摘要器合并，不从头重压。
存为每 session 一条 role="summary" 的 ConversationMessage（覆盖更新），并与唯一 baseline 原子推进。

注入：`select_history` 把唯一 summary 置于 history 头部；入口编排将其规范化为
普通的 user history message。它是 baseline 的历史起点，不是动态尾部，也不是另一份
system/snapshot 状态。

自动路径不再按数据库累计 token 触发摘要；本轮实际上下文的预算检查由
``agent.core`` 负责。数据库积累很多旧消息但当前请求仍在预算内时，不会无谓调用摘要模型。
压缩保留窗口仍使用字符硬上限；摘要请求的输入/输出预算跟随本轮实际模型配置。
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from sqlalchemy import delete, select

from agent.context import session_snapshot
from agent.context.tokens import content_text, estimate_tokens
from agent.context.audit import session_scope, summary_change

logger = logging.getLogger(__name__)

# 自动请求预算由 agent.core 的实际组装长度统一判定；baseline 更新后的完整
# 上下文上限统一为模型上下文的 50%，没有额外的低水位目标。
BASELINE_UPDATE_RATIO = 0.90
_RECENT_HISTORY_KEEP_CHARS = 20_000
# 在模型预算允许时，优先从当前 session history 分支出一次摘要请求，保持稳定
# provider 前缀；超出该上限才退回分块滚动，避免一次摘要输入超过 provider 硬限制。
_COMPRESS_LOCK_TIMEOUT = 300

_PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "compress_conv.md"
_baseline_tasks: dict[int, asyncio.Task] = {}
_SESSION_RUN_LOCK_TIMEOUT = 1800


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


@asynccontextmanager
async def session_run_gate(request):
    """阻止同一 session 的并行生成，并持久化排队状态。

    Redis 只提供跨 worker 的短租约；execution_state/pending_message_count 才是
    session 的事实状态。被动群消息不经过此 gate，因此不会进入主动 pending。
    """
    session_id = getattr(request, "session_id", None)
    marked_pending = False
    if not session_id:
        # 新会话尚未获得数据库 session_id，不存在可竞争的 canonical session；
        # 创建完成后后续请求才进入 session gate。
        yield
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

    lock = redis_core.get_redis().lock(
        _session_lock_key(request),
        timeout=_SESSION_RUN_LOCK_TIMEOUT,
        blocking=True,
    )
    await lock.acquire(blocking=True)
    run_id = f"run-{uuid4().hex[:16]}"
    try:
        if session_id:
            import app.db.session as _sess
            from app.models import ConversationSession

            async with _sess._SessionLocal() as db:
                session = await db.get(ConversationSession, session_id, with_for_update=True)
                if session is not None:
                    if marked_pending:
                        session.pending_message_count = max(0, int(session.pending_message_count or 0) - 1)
                    session.execution_state = "running"
                    session.active_run_id = run_id
                    await db.commit()
        yield
    finally:
        if session_id:
            import app.db.session as _sess
            from app.models import ConversationSession

            async with _sess._SessionLocal() as db:
                session = await db.get(ConversationSession, session_id, with_for_update=True)
                if session is not None and session.active_run_id == run_id:
                    session.execution_state = "idle"
                    session.active_run_id = None
                    await db.commit()
        try:
            await lock.release()
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
    """按 provider usage 或本轮压缩结果调度唯一 baseline 更新。

    正常请求不以本地估算触发；``actual_usage_tokens`` 来自 provider 的输入 usage，
    ``compaction_applied`` 覆盖 overflow 后已经在内存中完成的压缩/确定性兜底。
    """
    if not session_id:
        return
    context_tokens = max(1, int(context_tokens or 0))
    usage_ratio = max(0.0, float(actual_usage_tokens or 0) / context_tokens)
    logger.info(
        "[runtime-baseline-lifecycle] %s",
        {
            "session_id": session_id,
            "provider_usage_tokens": int(actual_usage_tokens or 0),
            "model_context_tokens": context_tokens,
            "usage_ratio": round(usage_ratio, 4),
            "compaction_applied": bool(compaction_applied),
            "phase": "schedule",
        },
    )
    if not compaction_applied and usage_ratio < BASELINE_UPDATE_RATIO:
        return
    existing = _baseline_tasks.get(session_id)
    if existing is not None and not existing.done():
        return
    task = asyncio.create_task(
        compress_if_needed(
            session_id,
            user_id,
            settings,
            force=False,
        ),
        name=f"context-baseline:{session_id}",
    )
    _baseline_tasks[session_id] = task

    def _cleanup(done: asyncio.Task) -> None:
        if _baseline_tasks.get(session_id) is done:
            _baseline_tasks.pop(session_id, None)
        try:
            done.exception()
        except asyncio.CancelledError:
            # 服务关闭时允许任务取消，不把取消当成业务失败。
            pass
        except Exception:
            # 后台 baseline 更新失败不影响已经完成的 run；下一轮仍可从持久状态
            # 继续处理，但必须留下诊断日志，避免 baseline 永久停在旧水位却无人知晓。
            logger.exception("[compress_conv] session=%s 后台 baseline 更新失败", session_id)

    task.add_done_callback(_cleanup)


async def wait_for_baseline_update(session_id: int | None) -> None:
    """等待同一个 baseline 更新，避免并发读取/写入唯一 baseline。"""
    if not session_id:
        return
    task = _baseline_tasks.get(session_id)
    if task is None:
        return
    try:
        await task
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("[compress_conv] session=%s 后台 baseline 更新失败", session_id)


async def _compress_if_needed_unlocked(
    session_id: int,
    user_id: int,
    settings,
    *,
    force: bool = False,
) -> bool:
    """检查并执行压缩，返回是否实际执行了压缩。

    ``force`` 只跳过自动阈值；压缩后的完整上下文统一不超过模型上限的 50%。
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

    # 自动路径由 provider usage/overflow 决定；不把本地 token 估算用于决定哪些
    # history 被保留。保留窗口采用字符硬上限。
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
        logger.warning("[compress_conv] session=%s 摘要候选校验失败: %s", session_id, summary_reason)
        return False

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
