"""群聊参与度是按 Bot 保存的用户配置。"""
import pytest
from fastapi import HTTPException

from app.api.v1 import user_bots
from app.api.v1.user_bots import BotUpdate, update_my_bot
from app.models import UserBot


@pytest.mark.asyncio
async def test_attention_mode_defaults_to_autonomous_and_is_independent_of_reply_mode(
    db, user_a, monkeypatch,
):
    async def no_op(*_args, **_kwargs):
        return None

    monkeypatch.setattr(user_bots, "_touch_gateway", no_op)

    bot = UserBot(user_id=user_a.id, platform="qq", app_id="synthetic-app")
    db.add(bot)
    await db.commit()
    assert user_bots._out(bot)["group_attention_mode"] == "autonomous"

    await update_my_bot(
        bot.id,
        BotUpdate(group_attention_mode="active", group_response_mode="reply_mentions"),
        user_a,
        db,
    )
    await db.refresh(bot)
    assert bot.group_attention_mode == "active"
    assert bot.group_attention_config_version == 1
    assert bot.group_requires_at is True

    await update_my_bot(
        bot.id, BotUpdate(group_response_mode="reply_all"), user_a, db
    )
    await db.refresh(bot)
    assert bot.group_attention_mode == "active"
    assert bot.group_attention_config_version == 1

    await update_my_bot(
        bot.id, BotUpdate(group_attention_mode="active"), user_a, db
    )
    await db.refresh(bot)
    assert bot.group_attention_config_version == 1


@pytest.mark.asyncio
async def test_attention_mode_accepts_only_supported_values(db, user_a, monkeypatch):
    async def no_op(*_args, **_kwargs):
        return None

    monkeypatch.setattr(user_bots, "_touch_gateway", no_op)
    bot = UserBot(user_id=user_a.id, platform="telegram", app_id="synthetic-app")
    db.add(bot)
    await db.commit()

    with pytest.raises(HTTPException) as invalid:
        await update_my_bot(
            bot.id, BotUpdate(group_attention_mode="shadow"), user_a, db
        )
    assert invalid.value.status_code == 400
    await db.refresh(bot)
    assert bot.group_attention_mode == "autonomous"
