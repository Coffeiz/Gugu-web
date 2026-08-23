"""斜杠控制命令测试。"""

import pytest

from agent import commands, router


def test_router_recognizes_compact_without_starting_agent():
    result = router.decide("/compact", "idle")
    assert result == {"action": "compact"}


@pytest.mark.parametrize("text", ["@小北 /compact", "＠小北　／compact", "<@bot-placeholder> /compact"])
def test_router_recognizes_group_command_after_bot_mention(text):
    assert router.decide(text, "idle", allow_leading_mention=True) == {"action": "compact"}


def test_router_does_not_treat_mention_in_normal_text_as_command():
    assert router.decide("@小北 这次不用 /compact 了", "idle", allow_leading_mention=True)["action"] == "agent"


def test_router_does_not_strip_mentions_without_group_context():
    assert router.decide("@小北 /compact", "idle")["action"] == "agent"


@pytest.mark.asyncio
async def test_command_handler_accepts_group_mention():
    assert await commands.handle(
        "user-1", "@小北 /compact", allow_leading_mention=True
    ) == "当前还没有可压缩的对话。"


@pytest.mark.asyncio
async def test_compact_without_session_is_deterministic():
    assert await commands.handle("user-1", "/compact") == "当前还没有可压缩的对话。"


@pytest.mark.asyncio
async def test_compact_forces_compression_instead_of_using_threshold(monkeypatch):
    captured = {}

    async def fake_compact(*_args, **_kwargs):
        captured.update(_kwargs)
        return False

    monkeypatch.setattr("agent.context.compress_conv.compress_if_needed", fake_compact)

    class AI:
        context_tokens = 100

    class Settings:
        ai = AI()

    monkeypatch.setattr("app.core.config.get_settings", lambda: Settings())
    result = await commands.handle("user-1", "/compact", session_id=12)
    assert captured == {"force": True}
    assert result == "当前历史还不够长，暂时无需整理上下文。"


@pytest.mark.asyncio
async def test_compact_reports_success(monkeypatch):
    async def fake_compact(*_args, **_kwargs):
        return True

    monkeypatch.setattr("agent.context.compress_conv.compress_if_needed", fake_compact)

    class AI:
        context_tokens = 100

    class Settings:
        ai = AI()

    monkeypatch.setattr("app.core.config.get_settings", lambda: Settings())
    result = await commands.handle("user-1", "/compact", session_id=12)
    assert result == "上下文已经整理好了，旧对话已压缩为摘要。"
