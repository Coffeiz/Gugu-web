"""对话历史压缩：run 完成后按软预算后台 checkpoint，或由 ``/compact`` 主动执行。

手动/请求内触发时，把"超出保留窗口的最老一批"压成摘要。**滚动**：把上一版 summary
一并喂给摘要器合并，不从头重压。
存为每 session 一条 role="summary" 的 ConversationMessage（覆盖更新）。

注入：`select_history` 把 summary 置顶取出，**入口编排（runner/web）把它从消息列表里
弹出、追加进 system prompt**——不能当成 role="summary" 的消息发给 LLM（API 只认 user/
assistant，且要交替）。见 `pop_summary`。

自动路径不再按数据库累计 token 触发摘要；本轮实际上下文的预算检查由
``agent.core`` 负责。数据库积累很多旧消息但当前请求仍在预算内时，不会无谓调用摘要模型。
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from sqlalchemy import delete, select

from agent.context import session_snapshot
from agent.context.budget import HARD_TARGET_RATIO, POST_RUN_CHECKPOINT_RATIO
from agent.context.tokens import content_text, estimate_tokens, msg_tokens
from agent.context.audit import session_scope, summary_change

logger = logging.getLogger(__name__)

# 手动压缩的默认窗口仍保留，自动请求预算由 agent.core 的实际组装长度统一判定。
# 后台 checkpoint 保留软预算以内的最近原文；硬预算 fallback 使用统一的 20%目标。
CHECKPOINT_KEEP_TARGET = 1.0
FORCE_COMPRESS_TARGET = HARD_TARGET_RATIO  # 手动 /compact 保留统一的 20%目标
_MAX_COMPRESS_TOKENS = 12000   # 单次喂给摘要器的原文上限（保护摘要器自身上下文；超出取最近一段，老的靠上一版 summary）
_COMPRESS_LOCK_TIMEOUT = 300

_PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "compress_conv.md"
_SUMMARY_HEADER = "## 早前对话摘要（供参考，非最新消息）"
_checkpoint_tasks: dict[int, asyncio.Task] = {}


def pop_summary(history: list) -> tuple[str | None, list]:
    """从 select_history 的输出里弹出 summary 条，返回 (摘要正文, 去掉 summary 的历史)。

    供 runner/web 用：summary 不能当消息发给 LLM，要追加进 system prompt。
    """
    summary_text = None
    rest = []
    for h in history:
        if getattr(h, "role", None) == "summary":
            summary_text = (getattr(h, "content", "") or "").strip() or None
        else:
            rest.append(h)
    return summary_text, rest


def summary_context_block(summary_text: str) -> str:
    """把摘要正文包成固定历史上下文消息。"""
    return f"\n\n{_SUMMARY_HEADER}\n{summary_text}"


def fixed_context_parts(snapshot_injection: dict | None, summary_text: str | None) -> list[dict]:
    """统一组装固定上下文：摘要在前，session snapshot 在后。"""
    parts: list[dict] = []
    if summary_text:
        parts.append({"role": "user", "content": summary_context_block(summary_text)})
    if snapshot_injection:
        parts.append(snapshot_injection)
    return parts


async def compress_if_needed(
    session_id: int,
    user_id: int,
    settings,
    token_budget: int,
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
    try:
        return await _compress_if_needed_unlocked(
            session_id, user_id, settings, token_budget, force=force,
        )
    finally:
        await lock.release()


def schedule_checkpoint(
    session_id: int,
    user_id: int,
    settings,
    context_tokens: int,
) -> None:
    """在 run 完成后按 90% 软阈值后台创建 checkpoint。"""
    if not session_id:
        return
    existing = _checkpoint_tasks.get(session_id)
    if existing is not None and not existing.done():
        return
    task = asyncio.create_task(
        compress_if_needed(
            session_id,
            user_id,
            settings,
            max(1, int(context_tokens * POST_RUN_CHECKPOINT_RATIO)),
            force=False,
        ),
        name=f"context-checkpoint:{session_id}",
    )
    _checkpoint_tasks[session_id] = task

    def _cleanup(done: asyncio.Task) -> None:
        if _checkpoint_tasks.get(session_id) is done:
            _checkpoint_tasks.pop(session_id, None)
        try:
            done.exception()
        except (asyncio.CancelledError, Exception):
            # 后台 checkpoint 失败不影响已经完成的 run；下一条消息仍会硬预检。
            pass

    task.add_done_callback(_cleanup)


async def wait_for_checkpoint(session_id: int | None) -> None:
    """下一条消息消费同一个 checkpoint，避免与后台任务并发读取/写 baseline。"""
    if not session_id:
        return
    task = _checkpoint_tasks.get(session_id)
    if task is None:
        return
    try:
        await task
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("[compress_conv] session=%s 后台 checkpoint 失败", session_id)


async def _compress_if_needed_unlocked(
    session_id: int,
    user_id: int,
    settings,
    token_budget: int,
    *,
    force: bool = False,
) -> bool:
    """检查并执行压缩，返回是否实际执行了压缩。

    ``force`` 只跳过自动阈值，并把保留窗口收窄到预算的 20%；没有可整理的
    旧消息时仍然返回 False，避免凭空调用摘要模型。
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
    all_msgs = [m for m in rows if m.role != "summary" and m.id > baseline_id]
    if not all_msgs:
        return False

    total = sum(msg_tokens(m) for m in all_msgs)
    if not force and total <= token_budget:
        return False   # 仅供显式调用方使用；正常请求不会走数据库累计判定

    # 后台 checkpoint 保留软预算以内的完整窗口；手动 /compact 主动把旧内容整理到 20% 安全基线。
    target_keep = int(token_budget * (FORCE_COMPRESS_TARGET if force else CHECKPOINT_KEEP_TARGET))
    tail_tokens = 0
    split_idx = 0
    for i in range(len(all_msgs) - 1, -1, -1):
        t = msg_tokens(all_msgs[i])
        if tail_tokens + t > target_keep:
            split_idx = i + 1
            break
        tail_tokens += t

    to_compress = all_msgs[:split_idx]
    if not to_compress:
        return False

    # 统一读取普通正文和 content_json，工具轮次不能因为正文不在 content 而丢失。
    # 超 _MAX_COMPRESS_TOKENS 时取最近一段（更老的靠上一版 summary 兜底，避免撑爆摘要器）。
    lines, acc = [], 0
    for m in reversed(to_compress):
        raw = m.content_json if m.content_json is not None else m.content
        text = content_text(raw).strip()
        if not text:
            continue
        t = estimate_tokens(text)
        if acc + t > _MAX_COMPRESS_TOKENS and lines:
            break
        lines.append(f"{'用户' if m.role == 'user' else '咕咕'}：{text}")
        acc += t
    lines.reverse()
    if not lines:
        return False
    conv_text = "\n\n".join(lines)

    summary = await _call_llm(conv_text, prev_summary, settings)
    if not summary:
        return False

    async with _sess._SessionLocal() as db:
        await db.execute(delete(ConversationMessage).where(
            ConversationMessage.session_id == session_id,
            ConversationMessage.role == "summary",
        ))
        summary_message = ConversationMessage(session_id=session_id, role="summary", content=summary)
        db.add(summary_message)
        await db.flush()
        session = await db.get(ConversationSession, session_id)
        if session is not None:
            session.baseline_message_id = to_compress[-1].id
            session.baseline_message_hash = session_snapshot.baseline_hash(to_compress)
            session_snapshot.checkpoint_snapshot(
                session,
                [{"role": "summary", "content": summary}],
                baseline_message_id=session.baseline_message_id,
            )
            # compact 是安全刷新点：下一轮重新读取最新的业务 snapshot，
            # 但不在后台压缩任务中直接加载整套上下文。
            session_snapshot.invalidate_snapshot(session)
        await db.commit()

    audit_scope = session_scope(session)
    # summary_change 的 source 是审计事件名，不能与会话自身的 source 字段重复传入。
    audit_scope.pop("source", None)
    summary_change(
        source="persistent_compaction",
        old=prev_summary,
        new=summary,
        trigger="force" if force else "budget",
        baseline_before=baseline_id,
        baseline_after=to_compress[-1].id,
        compressed_messages=len(to_compress),
        **audit_scope,
    )

    logger.info("[compress_conv] session %s：%d 条 → summary（%d token，%s）",
                session_id, len(to_compress), estimate_tokens(summary),
                "滚动合并" if prev_summary else "首次")
    return True


async def _call_llm(conv_text: str, prev_summary: str | None, settings) -> str:
    """调 LLM 生成/合并摘要，复用现有 provider 路由。"""
    from agent.memory._llm import complete_text
    try:
        sys_prompt = _PROMPT_PATH.read_text(encoding="utf-8").strip()
    except Exception:
        sys_prompt = "请将以下对话压缩为简洁摘要，保留关键决定、事实和用户偏好，控制在300字以内："
    if prev_summary:
        user_text = (f"【已有摘要（更早的对话，需与下面新增内容合并、保留全部关键信息）】\n{prev_summary}\n\n"
                     f"【新增对话】\n{conv_text}")
    else:
        user_text = conv_text
    return await complete_text(sys_prompt, user_text, settings, max_tokens=600)
