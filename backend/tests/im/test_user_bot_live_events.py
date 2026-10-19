"""用户 Bot 变更必须通知已打开的客户端刷新 IM 状态。"""

import pytest

from app.api.v1 import user_bots
from app.api.v1.user_bots import delete_my_bot
from app.core import events
from app.models import UserBot


@pytest.mark.asyncio
async def test_deleting_bot_publishes_im_channel_refresh_after_commit(
    db, user_a, monkeypatch,
):
    bot = UserBot(user_id=user_a.id, platform="qq", app_id="synthetic-app")
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    bot_id = bot.id

    published = []

    async def publish(user_id, *resources, **kwargs):
        # The notification follows the committed deletion, so other tabs can
        # immediately reload the authoritative bot list without seeing stale data.
        assert await db.get(UserBot, bot_id) is None
        published.append((user_id, resources, kwargs))

    async def no_op(*_args, **_kwargs):
        return None

    monkeypatch.setattr(events, "publish", publish)
    monkeypatch.setattr(user_bots, "_touch_gateway", no_op)

    await delete_my_bot(bot_id, user_a, db)

    assert published == [
        (user_a.id, ("im_channels",), {"operation": "refresh"}),
    ]
