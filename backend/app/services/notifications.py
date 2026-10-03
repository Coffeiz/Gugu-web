"""用户可见通知的持久化查询与状态操作。"""
from __future__ import annotations

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.models import NotificationDismissal, NotificationRead, SiteNotification, User


def _visible(user: User):
    # 新用户不补看注册前的广播，避免首登与新手引导气泡冲突。
    return and_(
        or_(SiteNotification.target == "all", SiteNotification.target == str(user.id)),
        SiteNotification.created_at >= user.created_at,
    )


async def list_persisted_notifications(
    db: AsyncSession, user: User, *, limit: int,
) -> tuple[list[SiteNotification], set[int]]:
    """返回用户当前可见且未清除的持久通知，以及该用户已读 ID。"""
    rows = (await db.execute(
        select(SiteNotification)
        .where(
            _visible(user),
            SiteNotification.persist == True,
            ~exists().where(
                NotificationDismissal.user_id == user.id,
                NotificationDismissal.notification_id == SiteNotification.id,
            ),
        )
        .order_by(SiteNotification.created_at.desc())
        .limit(max(1, min(limit, 100)))
    )).scalars().all()
    read_ids = set((await db.execute(
        select(NotificationRead.notification_id).where(NotificationRead.user_id == user.id)
    )).scalars().all())
    return rows, read_ids


async def latest_unread_bubble(db: AsyncSession, user: User) -> SiteNotification | None:
    """取最近一条有效、未读且未隐藏的气泡通知。"""
    return (await db.execute(
        select(SiteNotification)
        .where(
            _visible(user),
            SiteNotification.bubble == True,
            or_(SiteNotification.bubble_expire_at.is_(None), SiteNotification.bubble_expire_at > now_utc()),
            ~exists().where(
                NotificationRead.user_id == user.id,
                NotificationRead.notification_id == SiteNotification.id,
            ),
            ~exists().where(
                NotificationDismissal.user_id == user.id,
                NotificationDismissal.notification_id == SiteNotification.id,
            ),
        )
        .order_by(SiteNotification.created_at.desc())
        .limit(1)
    )).scalars().first()


async def mark_notifications_read(
    db: AsyncSession, user: User, notification_ids: list[int] | None,
) -> int:
    target_ids = notification_ids or (await db.execute(
        select(SiteNotification.id).where(_visible(user))
    )).scalars().all()
    existing = set((await db.execute(
        select(NotificationRead.notification_id).where(NotificationRead.user_id == user.id)
    )).scalars().all())
    added = 0
    for notification_id in target_ids:
        if notification_id not in existing:
            db.add(NotificationRead(user_id=user.id, notification_id=notification_id))
            added += 1
    if added:
        await db.commit()
    return added


async def dismiss_persisted_notifications(db: AsyncSession, user: User) -> int:
    """只为该用户写 dismissal，不删除广播通知本体。"""
    target_ids = (await db.execute(
        select(SiteNotification.id).where(
            _visible(user),
            SiteNotification.persist == True,
        )
    )).scalars().all()
    if not target_ids:
        return 0
    existing = set((await db.execute(
        select(NotificationDismissal.notification_id).where(
            NotificationDismissal.user_id == user.id,
            NotificationDismissal.notification_id.in_(target_ids),
        )
    )).scalars().all())
    added = 0
    for notification_id in target_ids:
        if notification_id not in existing:
            db.add(NotificationDismissal(user_id=user.id, notification_id=notification_id))
            added += 1
    if added:
        await db.commit()
    return added
