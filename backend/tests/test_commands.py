"""斜杠控制命令测试。"""

import pytest

from agent import commands, router
from agent.llm.genstream import immediate_stream
from app.models import ConversationSession


def test_router_recognizes_compact_without_starting_agent():
    result = router.decide("/compact", "idle")
    assert result == {"action": "compact"}


@pytest.mark.asyncio
async def test_immediate_stream_emits_one_complete_token():
    events = [line async for line in immediate_stream("/help 输出")]
    assert len(events) == 1
    assert '"content": "/help 输出"' in events[0]


def test_help_lists_all_commands():
    result = router.decide("/help", "idle")
    assert result["action"] == "reply"
    for command in ("/stop", "/status", "/compact", "/new", "/memory", "/forget", "/workspace"):
        assert command in result["reply"]
    assert "/unlimited" in result["reply"]


@pytest.mark.parametrize("text", ["/stop help", "/status help", "/help workspace"])
def test_router_supports_command_help(text):
    result = router.decide(text, "idle")
    assert result["action"] == "reply"
    assert "用法" in result["reply"]


@pytest.mark.parametrize("text", ["@小北 /compact", "＠小北　／compact", "<@bot-placeholder> /compact"])
def test_router_recognizes_group_command_after_bot_mention(text):
    assert router.decide(text, "idle", allow_leading_mention=True) == {"action": "compact"}


def test_router_does_not_treat_mention_in_normal_text_as_command():
    assert router.decide("@小北 这次不用 /compact 了", "idle", allow_leading_mention=True)["action"] == "agent"


def test_chinese_slash_command_names_are_not_supported():
    assert router.decide("/状态", "idle")["action"] == "agent"


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
@pytest.mark.parametrize("text", [
    "/compact help", "/new help", "/memory help", "/forget help", "/workspace help",
])
async def test_each_command_supports_help(text):
    result = await commands.handle("user-1", text)
    assert "用法" in result


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


def test_new_is_parsed_as_a_control_command():
    assert commands.parse("/new") == ("new", "")
    assert commands.parse("/new help") == ("new", "help")


@pytest.mark.asyncio
async def test_new_without_session_is_deterministic():
    assert await commands.handle("user-1", "/new") == "当前还没有可重置的对话。"


def test_goal_is_parsed_as_a_control_command():
    assert commands.parse("/goal 整理项目") == ("goal", "整理项目")
    assert commands.parse("/goal cancel") == ("goal", "cancel")
    assert commands.is_goal_start("/goal 整理项目") == (True, "整理项目")
    assert commands.is_goal_start("/goal status") == (False, "")
    assert commands.is_goal_start("/goal cancel") == (False, "")


@pytest.mark.asyncio
async def test_goal_mode_is_persisted_and_can_be_disabled(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="长任务测试", source="web")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    assert "已创建目标任务" in await commands.handle(user_a.id, "/goal 整理这批文件", session_id=session.id)
    await db.refresh(session)
    assert session.session_context == {
        "goal_text": "整理这批文件", "goal_status": "active", "goal_mode": True,
    }
    assert "整理这批文件" in await commands.handle(user_a.id, "/goal status", session_id=session.id)

    assert "暂停" in await commands.handle(user_a.id, "/goal pause", session_id=session.id)
    await db.refresh(session)
    assert session.session_context["goal_status"] == "paused"
    assert session.session_context["goal_mode"] is False

    assert "恢复" in await commands.handle(user_a.id, "/goal resume", session_id=session.id)
    await db.refresh(session)
    assert session.session_context["goal_status"] == "active"
    assert session.session_context["goal_mode"] is True

    assert "已取消" in await commands.handle(user_a.id, "/goal cancel", session_id=session.id)
    await db.refresh(session)
    assert session.session_context == {"goal_mode": False}


@pytest.mark.asyncio
async def test_unlimited_mode_does_not_enable_goal_loop(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="无限工具测试", source="web")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    assert "已开启无限工具调用模式" in await commands.handle(
        user_a.id, "/unlimited", session_id=session.id,
    )
    await db.refresh(session)
    assert session.session_context == {"unlimited_mode": True}
