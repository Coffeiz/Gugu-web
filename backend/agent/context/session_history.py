"""按 session baseline 读取连续对话历史。

读取阶段只应用 baseline 水位，不做本地 token 估算，也不推进 baseline。
预算、压缩和重试统一在 provider 请求边界处理。
"""
from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Any

from sqlalchemy import LargeBinary, Text, case, cast, func, or_, select

logger = logging.getLogger(__name__)

# 历史图片快照会包含 base64。正文历史仍按原有策略完整加载；图片仅从最近 48 条
# 用户消息中挑选，最多回放 12 个图片块且限制总读取量，避免多图消息绕过图片上限。
_MAX_HISTORY_IMAGE_SNAPSHOT_MESSAGES = 12
_MAX_HISTORY_IMAGE_BLOCKS = 12
_MAX_HISTORY_IMAGE_BYTES = 8 * 1024 * 1024
_HISTORY_IMAGE_BLOCK_TYPES = frozenset({"image", "image_url"})


def _history_order_key(message):
    """按有效事件时间恢复历史；同一毫秒内保持锚点前缀和会话顺序。"""
    from datetime import datetime, timezone

    # 排序采用消息实际发生/到达时间。早落库行被某轮消费时，sent_at 会改成
    # 处理时间；它不能覆盖平台时间、网关接收时间或保留的 created_at 到达时间。
    def _value(name):
        return message.get(name) if isinstance(message, dict) else getattr(message, name, None)

    platform_sent_ms = _value("im_platform_sent_ms") or _value("platform_sent_ms")
    received_ms = _value("im_event_received_ms") or _value("event_received_ms")
    if isinstance(platform_sent_ms, (int, float)) and platform_sent_ms > 0:
        timestamp = datetime.fromtimestamp(platform_sent_ms / 1000, timezone.utc)
    elif isinstance(received_ms, (int, float)) and received_ms > 0:
        timestamp = datetime.fromtimestamp(received_ms / 1000, timezone.utc)
    else:
        timestamp = _value("created_at") or _value("sent_at")
    if isinstance(timestamp, datetime):
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        timestamp_key = timestamp.timestamp()
    else:
        timestamp_key = float("-inf")
    received_ms = received_ms if isinstance(received_ms, (int, float)) else 0
    anchor_seq = getattr(message, "history_anchor_seq", None)
    sequence = int(anchor_seq or getattr(message, "conversation_seq", 0) or 0)
    is_anchor_prefix = 0 if anchor_seq is not None else 1
    return timestamp_key, received_ms, sequence, is_anchor_prefix, int(
        getattr(message, "conversation_seq", 0) or 0
    )

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


def _recent_image_candidate_ids(history: list) -> list[int]:
    """只检查最近 48 条用户消息；更早图片不保证跨长文本对话回放。"""
    return [
        int(message.id) for message in reversed(history)
        if getattr(message, "role", None) == "user"
        and getattr(message, "id", None) is not None
    ][:_MAX_HISTORY_IMAGE_SNAPSHOT_MESSAGES * 4]


def _select_image_ids_within_budget(candidate_ids: list[int], size_by_id: dict[int, int]):
    selected_ids: list[int] = []
    used_bytes = 0
    for message_id in candidate_ids:
        size = size_by_id.get(message_id)
        if size is None or size > _MAX_HISTORY_IMAGE_BYTES - used_bytes:
            continue
        selected_ids.append(message_id)
        used_bytes += size
        if len(selected_ids) >= _MAX_HISTORY_IMAGE_SNAPSHOT_MESSAGES:
            break
    return selected_ids, used_bytes


def _limit_image_blocks(payload: list, remaining: int) -> tuple[list, int]:
    """保留非图片内容，并将图片块裁剪到剩余的历史图片预算内。"""
    limited: list = []
    image_count = 0
    for block in payload:
        if not isinstance(block, dict) or block.get("type") not in _HISTORY_IMAGE_BLOCK_TYPES:
            limited.append(block)
            continue
        if image_count >= remaining:
            continue
        limited.append(block)
        image_count += 1
    return limited, image_count


async def _hydrate_recent_provider_images(db, history: list) -> tuple[int, int]:
    """只取最近且受总字节预算约束的图片快照，不 eager-load 全部 JSON。"""
    from app.models import ConversationMessage

    candidate_ids = _recent_image_candidate_ids(history)
    if not candidate_ids:
        return 0, 0

    dialect_name = getattr(getattr(getattr(db, "bind", None), "dialect", None), "name", None)
    stored_value = cast(
        ConversationMessage.provider_image_content,
        LargeBinary if dialect_name == "sqlite" else Text,
    )
    size_function = func.length if dialect_name == "sqlite" else func.octet_length
    sizes_result = await db.execute(
        select(
            ConversationMessage.id,
            size_function(stored_value),
        ).where(
            ConversationMessage.id.in_(candidate_ids),
            ConversationMessage.provider_image_content.is_not(None),
        )
    )
    size_by_id = {
        int(message_id): max(0, int(size or 0))
        for message_id, size in sizes_result.all()
    }
    selected_ids, used_bytes = _select_image_ids_within_budget(candidate_ids, size_by_id)
    if not selected_ids:
        return 0, 0

    payload_result = await db.execute(
        select(ConversationMessage.id, ConversationMessage.provider_image_content)
        .where(ConversationMessage.id.in_(selected_ids))
    )
    payload_by_id = {
        int(message_id): payload
        for message_id, payload in payload_result.all()
        if isinstance(payload, list)
    }
    # selected_ids 按最近优先排列。先给较新的消息分配图片预算，再按原历史顺序
    # 将裁剪后的快照挂回 ORM 对象，确保多图消息不能把 12 张上限扩成 12 条消息。
    remaining_images = _MAX_HISTORY_IMAGE_BLOCKS
    limited_payload_by_id: dict[int, list] = {}
    for message_id in selected_ids:
        payload = payload_by_id.get(message_id)
        if payload is None or remaining_images <= 0:
            continue
        limited_payload, image_count = _limit_image_blocks(payload, remaining_images)
        if image_count:
            limited_payload_by_id[message_id] = limited_payload
            remaining_images -= image_count

    for message in history:
        payload = limited_payload_by_id.get(int(getattr(message, "id", 0) or 0))
        if payload is not None:
            # 直接写入 ORM instance state，避免触发 deferred column 的隐式异步 I/O。
            vars(message)["provider_image_content"] = payload
    return len(limited_payload_by_id), used_bytes


async def load_session_history(
    db,
    session_id: int,
    baseline_message_seq: int = 0,
    *,
    max_messages: int | None = None,
) -> list:
    """读取 baseline 后的连续历史，按平台事件时间返回。

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
        .order_by(
            func.coalesce(
                ConversationMessage.history_anchor_seq,
                ConversationMessage.conversation_seq,
            ).desc(),
            case((ConversationMessage.history_anchor_seq.is_not(None), 0), else_=1).desc(),
            ConversationMessage.conversation_seq.desc(),
        )
        .limit(1)
    )
    summary = list((await db.execute(summary_query)).scalars().all())

    # summary 行自带本次压缩的真实覆盖边界（与摘要同一事务写入，covers_until_seq）。
    # 装载先读 session.baseline、后读 summary，两次读取之间可能隔着一次压缩落库，
    # 形成「新摘要 + 旧 baseline」竞态；取两者较大者作有效水位，防止把摘要已
    # 覆盖的原文重复拼进上下文。旧摘要行没有该水位时退回传入的 baseline。
    passed_baseline = int(baseline_message_seq or 0)
    covers_until = int(getattr(summary[0], "covers_until_seq", 0) or 0) if summary else 0
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
        # 先按会话序号读取候选行；最终历史再按平台发送时间排序，旧消息和
        # 没有平台时间的消息则由事件到达时间、入库时间和会话序号稳定回退。
        .order_by(
            func.coalesce(
                ConversationMessage.history_anchor_seq,
                ConversationMessage.conversation_seq,
            ).desc(),
            case((ConversationMessage.history_anchor_seq.is_not(None), 0), else_=1).desc(),
            ConversationMessage.conversation_seq.desc(),
        )
    )
    if effective_baseline > 0:
        query = query.where(
            func.coalesce(
                ConversationMessage.history_anchor_seq,
                ConversationMessage.conversation_seq,
            ) > effective_baseline
        )
    newest = list((await db.execute(query)).scalars().all())
    # 会话序号用于 baseline 和稳定回退，不代表群聊平台上的实际发生顺序。
    # provider 历史和 UI 均以平台发送时间为先，缺失时再回退事件到达/入库时间。
    history = sorted(newest, key=_history_order_key)
    if max_messages is not None:
        limit = max(1, int(max_messages))
        if effective_baseline <= 0:
            limit = max(0, limit - len(summary))
        history = history[-limit:] if limit else []
    image_count, image_bytes = await _hydrate_recent_provider_images(db, history)
    await _hydrate_loaded_reference_contexts(db, session_id, history)
    _last_history_stats.set({
        "history_loaded_count": len(newest),
        "history_selected_count": len(history) + len(summary),
        "history_selection": "provider-authoritative",
        "history_summary_count": len(summary),
        "history_baseline_message_seq": passed_baseline,
        "history_effective_baseline_seq": effective_baseline,
        "history_summary_covers_until_seq": covers_until or None,
        "history_image_snapshots_loaded": image_count,
        "history_image_snapshot_bytes": image_bytes,
        "history_oldest_selected_seq": (
            getattr(history[0], "history_anchor_seq", None)
            or getattr(history[0], "conversation_seq", None)
        ) if history else None,
        "history_newest_selected_seq": (
            getattr(history[-1], "history_anchor_seq", None)
            or getattr(history[-1], "conversation_seq", None)
        ) if history else None,
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
