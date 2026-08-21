"""斜杠控制命令测试。"""

import pytest

from agent import commands, router


def test_router_recognizes_compact_without_starting_agent():
    result = router.decide("/compact", "idle")
    assert result == {"action": "compact"}


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
    assert result == "当前没有可整理的旧对话。"


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
