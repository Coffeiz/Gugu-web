"""用户 Bot 的消息格式设置只接受兼容与 Markdown 两种策略。"""
import pytest
from fastapi import HTTPException

from app.api.v1 import user_bots
from app.api.v1.user_bots import BotUpdate, update_my_bot
from app.models import UserBot


@pytest.mark.asyncio
async def test_message_format_setting_persists_supported_modes_and_rejects_removed_smart_mode(
    db, user_a, monkeypatch,
):
    async def no_op(*_args, **_kwargs):
        return None

    monkeypatch.setattr(user_bots, "_touch_gateway", no_op)
    from app.core import events
    monkeypatch.setattr(events, "bump_context_revision", no_op)

    bot = UserBot(user_id=user_a.id, platform="qq", app_id="synthetic-app")
    db.add(bot)
    await db.commit()

    await update_my_bot(
        bot.id,
        BotUpdate(group_message_format="compat", private_message_format="markdown"),
        user_a,
        db,
    )
    await db.refresh(bot)
    assert (bot.group_message_format, bot.private_message_format) == ("compat", "markdown")

    with pytest.raises(HTTPException) as removed_mode:
        await update_my_bot(
            bot.id, BotUpdate(private_message_format="smart"), user_a, db
        )
    assert removed_mode.value.status_code == 400
    await db.refresh(bot)
    assert bot.private_message_format == "markdown"
