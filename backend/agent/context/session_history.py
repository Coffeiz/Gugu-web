"""按 session baseline 读取连续对话历史。

读取阶段只应用 baseline 水位，不做本地 token 估算，也不推进 baseline。
预算、压缩和重试统一在 provider 请求边界处理。
"""
from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Any

from sqlalchemy import func, or_, select

logger = logging.getLogger(__name__)

_last_history_stats: ContextVar[dict[str, Any] | None] = ContextVar(
    "session_history_stats", default=None,
)


async def _hydrate_loaded_reference_contexts(db, session_id: int, history: list) -> None:
    """为旧消息恢复引用上下文；新消息已把 canonical block 写入 content_json。"""
    referenced_messages = [
        message for message in history
        if getattr(message, "role", None) == "user"
        and isinstance(getattr(message, "references_json", None), list)
        and getattr(message, "references_json", None)
    ]
    if not referenced_messages:
        return
    from app.models import ConversationSession
    from agent.context.references import hydrate_reference_history

    owner_id = await db.scalar(
        select(ConversationSession.user_id).where(ConversationSession.id == session_id)
    )
    if owner_id is not None:
        await hydrate_reference_history(db, owner_id, history)


async def load_session_history(
    db,
    session_id: int,
    baseline_message_id: int = 0,
    *,
    max_messages: int | None = None,
) -> list:
    """读取 baseline 后的连续历史，按消息时间正序返回。

    baseline 为 0 时从会话开头恢复；持久化 baseline 更新由 ``compress_conv``
    负责。已有 summary 始终放在结果第一条。显式条数上限仅供诊断脚本构造样本。
    """
    from app.models import ConversationMessage
    from agent.im.inbound_recovery import PENDING_USER_RUN_PREFIX

    summary_query = (
        select(ConversationMessage)
        .where(
            ConversationMessage.session_id == session_id,
            ConversationMessage.role == "summary",
        )
        .order_by(ConversationMessage.created_at.desc(), ConversationMessage.id.desc())
        .limit(1)
    )
    summary = list((await db.execute(summary_query)).scalars().all())

    # summary 行自带本次压缩的真实覆盖边界（与摘要同一事务写入，covers_until_id）。
    # 装载先读 session.baseline、后读 summary，两次读取之间可能隔着一次压缩落库，
    # 形成「新摘要 + 旧 baseline」竞态；取两者较大者作有效水位，防止把摘要已
    # 覆盖的原文重复拼进上下文。旧摘要行没有该水位时退回传入的 baseline。
    passed_baseline = int(baseline_message_id or 0)
    covers_until = int(getattr(summary[0], "covers_until_id", 0) or 0) if summary else 0
    effective_baseline = max(passed_baseline, covers_until)
    if covers_until > passed_baseline:
        logger.info(
            "[history-baseline-divergence] session=%s loader_baseline=%s summary_covers=%s",
            session_id, passed_baseline, covers_until,
        )

    query = (
        select(ConversationMessage)
        .where(
            ConversationMessage.session_id == session_id,
            ConversationMessage.role != "summary",
            # 早落库行（已入库但还没被任何 run 消费）不进历史：这一轮的正文本就
            # 是当前这条消息，再入史会让同一段话在上下文里出现两次。
            or_(
                ConversationMessage.run_id.is_(None),
                ConversationMessage.run_id.notlike(PENDING_USER_RUN_PREFIX + "%"),
            ),
        )
        # 按 sent_at（该消息被本轮处理的时间）排序，而不是 created_at（入库时间）：
        # 群消息在 run 跑的过程中就到了，created_at 是**到达时刻**，按它排会让晚到的
        # 消息插到上一条回复**之前**，把 provider 缓存前缀从中间截断——上一轮那段就
        # 缓存不住了。sent_at 与改动前（run 落库时刻）一致，历史顺序逐条不变。
        #
        # sent_at 为空的旧行回落 created_at：既保住老数据原来的顺序，也避开
        # Postgres（SENT_AT DESC 时 NULLS FIRST）和 SQLite（NULLS LAST）排序相反
        # 的差异，避免同一段历史在两端读出不同顺序。
        .order_by(
            func.coalesce(ConversationMessage.sent_at, ConversationMessage.created_at).desc(),
            ConversationMessage.id.desc(),
        )
    )
    if effective_baseline > 0:
        query = query.where(
            ConversationMessage.id > effective_baseline
        )
    if max_messages is not None:
        limit = max(1, int(max_messages))
        if effective_baseline <= 0:
            limit = max(0, limit - len(summary))
        query = query.limit(limit)
    newest = list((await db.execute(query)).scalars().all())
    # 真正的预算、压缩和重试统一由 provider 边界处理。
    history = list(reversed(newest))
    await _hydrate_loaded_reference_contexts(db, session_id, history)
    _last_history_stats.set({
        "history_loaded_count": len(newest),
        "history_selected_count": len(history) + len(summary),
        "history_selection": "provider-authoritative",
        "history_summary_count": len(summary),
        "history_baseline_message_id": passed_baseline,
        "history_effective_baseline_id": effective_baseline,
        "history_summary_covers_until_id": covers_until or None,
        "history_oldest_selected_id": getattr(history[0], "id", None) if history else None,
        "history_newest_selected_id": getattr(history[-1], "id", None) if history else None,
    })
    return summary + history


def restore_canonical_area(history):
    """把已完成 baseline/window/hydration 的数据库行恢复为 MessageArea。"""
    from .message_area_repository import restore_entries

    return restore_entries(history)


def consume_history_stats() -> dict[str, Any] | None:
    """取出当前任务最近一次历史窗口统计，不携带正文。"""
    stats = _last_history_stats.get()
    _last_history_stats.set(None)
    return stats
