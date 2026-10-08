"""通知气泡的已读补弹策略。"""

from sqlalchemy import select

from app.api.v1.notifications import clear_notifications, latest_bubble, list_notifications
from app.models import NotificationDismissal, NotificationRead, SiteNotification


async def test_admin_history_excludes_scheduled_task_notifications(db):
    from app.api.v1.notifications_admin import history

    admin = SiteNotification(title="后台广播", content="内容", target="all", created_by="admin")
    scheduled = SiteNotification(title="用户任务", content="内容", target="user", created_by="scheduled_task")
    db.add_all([admin, scheduled])
    await db.commit()

    result = await history(db=db)

    assert [item["title"] for item in result] == ["后台广播"]


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


async def test_clearing_notifications_hides_them_only_for_current_user(db, user_a, user_b):
    notification = SiteNotification(
        title="共享通知",
        content="内容",
        target="all",
        bubble=True,
        persist=True,
    )
    db.add(notification)
    await db.commit()

    result = await clear_notifications(current_user=user_a, db=db)

    assert result == {"ok": True, "dismissed": 1}
    assert await list_notifications(current_user=user_a, db=db) == []
    assert [item["id"] for item in await list_notifications(current_user=user_b, db=db)] == [notification.id]
    assert (await latest_bubble(current_user=user_a, db=db)) == {"bubble": None}
    assert await db.scalar(
        select(NotificationDismissal.id).where(
            NotificationDismissal.user_id == user_a.id,
            NotificationDismissal.notification_id == notification.id,
        )
    ) is not None
