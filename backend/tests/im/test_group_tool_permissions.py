"""群成员 Provider 搜索权限应被显式保存、过滤并运行时授权。"""
import pytest
from fastapi import HTTPException

from agent.im.permissions import filter_tool_names
from app.api.v1 import user_bots
from app.api.v1.user_bots import BotUpdate, update_my_bot
from app.models import UserBot
from app.services.im_identity import normalize_group_allowed_tools


def test_provider_search_is_a_supported_group_permission_and_unknown_names_are_removed():
    allowed = normalize_group_allowed_tools([
        "web_search", "xng_search", "http_get", "web_search", "inspect_images", "retired_tool",
    ])

    assert allowed == ["web_search", "xng_search", "http_get"]
    assert filter_tool_names(["web_search", "xng_search", "http_get"], allowed) == allowed


@pytest.mark.asyncio
async def test_group_tool_update_accepts_provider_search_but_rejects_unknown_names(
    db, user_a, monkeypatch,
):
    async def no_op(*_args, **_kwargs):
        return None

    from app.core import events

    monkeypatch.setattr(user_bots, "_touch_gateway", no_op)
    monkeypatch.setattr(events, "publish", no_op)
    bot = UserBot(user_id=user_a.id, platform="qq", app_id="synthetic-app")
    db.add(bot)
    await db.commit()

    await update_my_bot(
        bot.id, BotUpdate(group_allowed_tools=["web_search"]), user_a, db,
    )
    await db.refresh(bot)
    assert bot.group_allowed_tools == ["web_search", "http_get"]

    with pytest.raises(HTTPException) as unsupported:
        await update_my_bot(
            bot.id,
            BotUpdate(group_allowed_tools=["web_search", "retired_tool"]),
            user_a,
            db,
        )
    assert unsupported.value.status_code == 400
    await db.refresh(bot)
    assert bot.group_allowed_tools == ["web_search", "http_get"]
