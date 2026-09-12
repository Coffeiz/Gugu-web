"""按 session baseline 读取连续对话历史。

读取阶段只应用 baseline 水位和非 token 的条数安全上限；不做本地 token 估算，
也不推进 baseline。预算、压缩和重试统一在 provider 请求边界处理。
"""
from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Any

from sqlalchemy import select

from .tokens import HISTORY_MAX_MSGS


logger = logging.getLogger(__name__)

_last_history_stats: ContextVar[dict[str, Any] | None] = ContextVar(
    "session_history_stats", default=None,
)


async def load_session_history(
    db,
    session_id: int,
    baseline_message_id: int = 0,
    *,
    max_messages: int = HISTORY_MAX_MSGS,
) -> list:
    """读取 baseline 之后的历史，按数据库消息 id 正序返回。

    读取窗口只保护当前 run，不推进 baseline。持久化 baseline 更新由
    ``compress_conv`` 负责；summary 行始终保留在结果第一条，由 history builder
    在发送边界规范化为普通 user 历史消息。
    """
    from app.models import ConversationMessage

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
        )
        .order_by(ConversationMessage.created_at.desc(), ConversationMessage.id.desc())
        .limit(max(1, int(max_messages)))
    )
    if effective_baseline > 0:
        query = query.where(
            ConversationMessage.id > effective_baseline
        )
    newest = list((await db.execute(query)).scalars().all())
    # 不在数据库读取阶段使用本地 token 估算。历史只受非 token 的条数安全上限
    # 保护；真正的预算、压缩和重试统一由 provider 边界处理。
    history = list(reversed(newest))
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


def consume_history_stats() -> dict[str, Any] | None:
    """取出当前任务最近一次历史窗口统计，不携带正文。"""
    stats = _last_history_stats.get()
    _last_history_stats.set(None)
    return stats
