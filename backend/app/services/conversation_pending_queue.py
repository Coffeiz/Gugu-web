"""Web 会话待发消息队列的数据库读写。"""

import hmac
import secrets
import time

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.tz import now_utc
from app.models import ConversationPendingQueue


class PendingQueueClaimConflict(Exception):
    """待发消息已经被其他客户端认领、发送或移除。"""


async def publish_session_pending_queue_changed(user_id, session_id: int, *, origin: str | None = None) -> None:
    """通知其他客户端刷新指定会话的待发队列；事件不包含消息正文。"""
    await events.publish(
        user_id,
        "pending_queues",
        origin=origin,
        operation="update",
        entity_id=session_id,
    )


def session_pending_queue_id(session_id: int) -> str:
    """正式会话使用稳定队列 ID；浏览器 ID 只用于尚未创建会话的草稿。"""
    return f"session-{session_id}"


def _insert_for_dialect(db: AsyncSession):
    dialect_name = db.get_bind().dialect.name
    if dialect_name == "postgresql":
        return postgres_insert(ConversationPendingQueue)
    if dialect_name == "sqlite":
        return sqlite_insert(ConversationPendingQueue)
    return None


async def _get_queue_row(
    db: AsyncSession,
    *,
    user_id,
    queue_id: str,
    lock: bool = False,
) -> ConversationPendingQueue | None:
    statement = select(ConversationPendingQueue).where(
        ConversationPendingQueue.user_id == user_id,
        ConversationPendingQueue.queue_id == queue_id,
    )
    if lock:
        statement = statement.with_for_update()
    result = await db.execute(statement)
    return result.scalars().first()


async def _get_or_create_queue_row(
    db: AsyncSession,
    *,
    user_id,
    queue_id: str,
    session_id: int | None,
) -> ConversationPendingQueue:
    row = await _get_queue_row(db, user_id=user_id, queue_id=queue_id, lock=True)
    if row is not None:
        return row
    insert = _insert_for_dialect(db)
    if insert is not None:
        await db.execute(
            insert.values(
                user_id=user_id,
                queue_id=queue_id,
                session_id=session_id,
                items=[],
                updated_at=now_utc(),
            ).on_conflict_do_nothing(index_elements=["user_id", "queue_id"])
        )
        row = await _get_queue_row(db, user_id=user_id, queue_id=queue_id, lock=True)
        if row is not None:
            return row
    row = ConversationPendingQueue(
        user_id=user_id,
        queue_id=queue_id,
        session_id=session_id,
        items=[],
    )
    db.add(row)
    await db.flush()
    return row


async def get_pending_queue_by_id(
    db: AsyncSession,
    *,
    user_id,
    queue_id: str,
) -> tuple[int | None, list[dict]]:
    row = await _get_queue_row(db, user_id=user_id, queue_id=queue_id)
    if row is None:
        return None, []
    now = time.time()
    items = row.items if isinstance(row.items, list) else []
    visible_items = [
        {
            **{key: value for key, value in item.items() if key not in {"_claim_token", "_claim_until"}},
            "queue_id": row.queue_id,
            "session_id": row.session_id,
            "claimed": bool(
                item.get("_claim_token")
                and isinstance(item.get("_claim_until"), (int, float))
                and item["_claim_until"] > now
            ),
        }
        for item in items
        if isinstance(item, dict)
    ]
    return row.session_id, visible_items


async def get_pending_queue_for_session(
    db: AsyncSession,
    *,
    user_id,
    session_id: int,
) -> list[dict]:
    """读取会话唯一队列。"""
    _, items = await get_pending_queue_by_id(
        db,
        user_id=user_id,
        queue_id=session_pending_queue_id(session_id),
    )
    return items


def _set_queue_contents(
    row: ConversationPendingQueue,
    items: list[dict],
    *,
    session_id: int | None,
) -> None:
    row.items = items
    row.session_id = session_id
    row.updated_at = now_utc()


async def replace_draft_pending_queue(
    db: AsyncSession,
    *,
    user_id,
    queue_id: str,
    items: list[dict],
) -> None:
    row = await _get_queue_row(db, user_id=user_id, queue_id=queue_id, lock=True)
    if row is None:
        if not items:
            await db.commit()
            return
        row = await _get_or_create_queue_row(
            db, user_id=user_id, queue_id=queue_id, session_id=None,
        )
    normalized = [
        dict(item)
        for item in items
        if isinstance(item, dict)
    ]
    if not normalized:
        await db.delete(row)
    else:
        _set_queue_contents(row, normalized, session_id=None)
    await db.commit()


async def patch_pending_queue(
    db: AsyncSession,
    *,
    user_id,
    queue_id: str,
    session_id: int | None,
    upsert_items: list[dict],
    remove_keys: list[int],
) -> None:
    """按 key 增量更新单会话队列，避免浏览器快照互相覆盖。"""
    row = await _get_queue_row(db, user_id=user_id, queue_id=queue_id, lock=True)
    if row is None:
        if not upsert_items:
            await db.commit()
            return
        row = await _get_or_create_queue_row(
            db, user_id=user_id, queue_id=queue_id, session_id=session_id,
        )
    if row is None:
        await db.commit()
        return

    items = {
        item.get("key"): item
        for item in (row.items if isinstance(row.items, list) else [])
        if isinstance(item, dict)
    }
    for key in remove_keys:
        items.pop(key, None)

    for incoming in upsert_items:
        key = incoming.get("key")
        existing = items.get(key, {})
        merged = {**existing, **incoming}
        # 更新消息正文时保留另一客户端取得的派发租约。
        for field in ("_claim_token", "_claim_until"):
            if field not in incoming and field in existing:
                merged[field] = existing[field]
        items[key] = merged

    if not items:
        await db.delete(row)
    else:
        _set_queue_contents(row, list(items.values()), session_id=session_id)
    await db.commit()


async def claim_pending_queue_item(
    db: AsyncSession,
    *,
    user_id,
    queue_id: str,
    session_id: int,
    item_key: int,
    lease_seconds: int = 60,
) -> str | None:
    """以行锁原子认领单条消息；进程退出时租约到期后可被其他浏览器接手。"""
    row = await _get_queue_row(db, user_id=user_id, queue_id=queue_id, lock=True)
    if row is None or row.session_id != session_id:
        return None
    now = time.time()
    items = row.items if isinstance(row.items, list) else []
    for index, item in enumerate(items):
        if not isinstance(item, dict) or item.get("key") != item_key:
            continue
        claim_until = item.get("_claim_until")
        if item.get("_claim_token") and isinstance(claim_until, (int, float)) and claim_until > now:
            await db.commit()
            return None
        token = secrets.token_urlsafe(32)
        updated = list(items)
        updated[index] = {
            **item,
            "_claim_token": token,
            "_claim_until": now + lease_seconds,
        }
        _set_queue_contents(row, updated, session_id=session_id)
        await db.commit()
        return token
    await db.commit()
    return None


async def release_pending_queue_claim(
    db: AsyncSession,
    *,
    user_id,
    queue_id: str,
    session_id: int,
    item_key: int,
    claim_token: str,
) -> bool:
    row = await _get_queue_row(db, user_id=user_id, queue_id=queue_id, lock=True)
    if row is None or row.session_id != session_id:
        return False
    items = row.items if isinstance(row.items, list) else []
    for index, item in enumerate(items):
        if (
            isinstance(item, dict)
            and item.get("key") == item_key
            and hmac.compare_digest(str(item.get("_claim_token") or ""), claim_token)
        ):
            updated = list(items)
            updated[index] = {key: value for key, value in item.items() if key not in {"_claim_token", "_claim_until"}}
            _set_queue_contents(row, updated, session_id=session_id)
            await db.commit()
            return True
    await db.commit()
    return False


async def bind_pending_queue(
    db: AsyncSession,
    *,
    user_id,
    queue_id: str | None,
    session_id: int,
    acknowledged_item_key: int | None = None,
    acknowledged_claim_token: str | None = None,
    bind_draft_items: bool = False,
) -> None:
    """绑定新会话草稿，并在用户消息事务中原子确认已接收的队列项。"""
    if not queue_id:
        if acknowledged_item_key is not None:
            raise PendingQueueClaimConflict
        return

    canonical_id = session_pending_queue_id(session_id)
    if bind_draft_items:
        draft = await _get_queue_row(db, user_id=user_id, queue_id=queue_id, lock=True)
        if draft is not None:
            if draft.session_id is not None:
                raise PendingQueueClaimConflict
            draft_items = draft.items if isinstance(draft.items, list) else []
            if draft_items:
                row = await _get_or_create_queue_row(
                    db,
                    user_id=user_id,
                    queue_id=canonical_id,
                    session_id=session_id,
                )
                by_key = {
                    item.get("key"): item
                    for item in (row.items if isinstance(row.items, list) else [])
                    if isinstance(item, dict)
                }
                by_key.update({
                    item.get("key"): item
                    for item in draft_items
                    if isinstance(item, dict)
                })
                _set_queue_contents(row, list(by_key.values()), session_id=session_id)
            await db.delete(draft)

    if acknowledged_item_key is None:
        return
    if queue_id != canonical_id:
        raise PendingQueueClaimConflict
    row = await _get_queue_row(db, user_id=user_id, queue_id=canonical_id, lock=True)
    if row is None:
        raise PendingQueueClaimConflict
    items = row.items if isinstance(row.items, list) else []
    matching = next((
        item for item in items
        if isinstance(item, dict) and item.get("key") == acknowledged_item_key
    ), None)
    if matching is None:
        raise PendingQueueClaimConflict
    stored_claim = matching.get("_claim_token")
    if stored_claim and (
        not acknowledged_claim_token
        or not hmac.compare_digest(str(stored_claim), acknowledged_claim_token)
    ):
        raise PendingQueueClaimConflict
    if acknowledged_claim_token and (
        not stored_claim or not hmac.compare_digest(str(stored_claim), acknowledged_claim_token)
    ):
        raise PendingQueueClaimConflict
    remaining = [item for item in items if item.get("key") != acknowledged_item_key]
    if remaining:
        _set_queue_contents(row, remaining, session_id=session_id)
    else:
        await db.delete(row)
