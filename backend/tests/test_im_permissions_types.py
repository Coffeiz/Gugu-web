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
    assert result.allowed_tool_names == ["web_search", "image_search"]


@pytest.mark.asyncio
async def test_non_numeric_bot_policy_defaults_to_disabled():
    from agent.im.permissions import resolve_group_policy

    assert await resolve_group_policy("platform-bot-id") == (False, True, False)
