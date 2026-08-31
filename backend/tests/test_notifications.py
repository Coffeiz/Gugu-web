"""通知气泡的已读补弹策略。"""

from app.api.v1.notifications import latest_bubble
from app.models import NotificationRead, SiteNotification


async def _create_bubble(db, *, title: str) -> SiteNotification:
    notification = SiteNotification(
        title=title,
        content="测试通知",
        target="all",
        bubble=True,
        persist=False,
    )
    db.add(notification)
    await db.commit()
    await db.refresh(notification)
    return notification


async def test_latest_bubble_excludes_notifications_marked_read(db, user_a):
    notification = await _create_bubble(db, title="已关闭的气泡")

    first = await latest_bubble(user_a, db)
    assert first["bubble"]["id"] == notification.id

    db.add(NotificationRead(user_id=user_a.id, notification_id=notification.id))
    await db.commit()

    second = await latest_bubble(user_a, db)
    assert second == {"bubble": None}


async def test_latest_bubble_skips_read_latest_and_returns_unread_older_bubble(db, user_a):
    older = await _create_bubble(db, title="仍未读的气泡")
    latest = await _create_bubble(db, title="已关闭的最新气泡")

    db.add(NotificationRead(user_id=user_a.id, notification_id=latest.id))
    await db.commit()

    result = await latest_bubble(user_a, db)
    assert result["bubble"]["id"] == older.id
