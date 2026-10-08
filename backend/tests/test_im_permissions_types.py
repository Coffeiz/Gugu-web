import pytest


@pytest.mark.asyncio
async def test_non_numeric_platform_bot_id_fails_closed(monkeypatch):
    from agent.im.permissions import resolve_access

    result = await resolve_access(
        "qq",
        "group",
        "platform-bot-id",
        "owner-1",
        "member-1",
    )
    assert result.role == "unknown"
    assert result.allowed_tool_names == ["web_search", "http_get", "image_search", "read_file", "send_file"]


@pytest.mark.asyncio
async def test_non_numeric_bot_policy_defaults_to_disabled():
    from agent.im.permissions import resolve_group_policy

    assert await resolve_group_policy("platform-bot-id") == (False, True, False, True, True)


@pytest.mark.asyncio
async def test_group_policy_uses_platform_specific_enable_field(monkeypatch):
    from types import SimpleNamespace
    import app.db.session as db_session
    from agent.im.permissions import resolve_group_policy

    bots = {
        11: SimpleNamespace(
            platform="qq", group_chat_enabled=False, feishu_group_chat_enabled=True,
            group_requires_at=False, group_read_enabled=False,
            group_memory_enabled=True, member_memory_enabled=True,
        ),
        12: SimpleNamespace(
            platform="feishu", group_chat_enabled=False, feishu_group_chat_enabled=False,
            group_requires_at=True, group_read_enabled=True,
            group_memory_enabled=False, member_memory_enabled=True,
        ),
        13: SimpleNamespace(
            platform="feishu", group_chat_enabled=False, feishu_group_chat_enabled=None,
            group_requires_at=False, group_read_enabled=False,
            group_memory_enabled=True, member_memory_enabled=False,
        ),
    }

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def get(self, _model, bot_id):
            return bots.get(bot_id)

    monkeypatch.setattr(db_session, "_engine", object())
    monkeypatch.setattr(db_session, "_SessionLocal", Session)

    assert (await resolve_group_policy("11", "qq"))[0] is False
    assert (await resolve_group_policy("12", "feishu")) == (False, True, True, False, True)
    # NULL 表示升级前的飞书连接，保持既有群聊可用行为。
    assert (await resolve_group_policy("13", "feishu")) == (True, False, False, True, False)
    # 平台错配不能通过另一个 IM 的 Bot 行绕过各自的开关。
    assert (await resolve_group_policy("12", "qq"))[0] is False
