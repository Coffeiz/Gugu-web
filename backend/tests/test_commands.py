"""斜杠控制命令测试。"""

import pytest
from sqlalchemy import select

from agent import commands, router
from agent.llm.genstream import immediate_stream
from app.models import ConversationSession, Folder


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


def test_help_lists_subcommands_on_separate_lines():
    result = router.decide("/help workspace", "idle")
    lines = result["reply"].splitlines()
    assert "子命令：/workspace show　查看当前绑定" in lines
    assert "子命令：/workspace status　查看沙箱权限状态" in lines
    assert "子命令：/workspace delete <ID> confirm　确认删除工作区" in lines


def test_goal_help_lists_each_subcommand_on_its_own_line():
    result = router.decide("/help goal", "idle")
    lines = result["reply"].splitlines()
    assert "用法：/goal <目标>　创建目标任务" in lines
    assert "子命令：/goal pause　暂停目标任务" in lines
    assert "子命令：/goal resume　恢复目标任务" in lines


@pytest.mark.asyncio
async def test_help_follows_requested_locale():
    result = await commands.handle("user-1", "/unlimited help", locale="en-US")
    assert "Subcommand: /unlimited on - Enable" in result
    assert "子命令" not in result


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


@pytest.mark.asyncio
async def test_workspace_delete_requires_explicit_confirmation(db, user_a):
    from app.services.workspaces import create_workspace
    from app.services.interactions import consume_action

    folder = Folder(user_id=user_a.id, name="工作区目录")
    db.add(folder)
    await db.flush()
    workspace = await create_workspace(
        db, user_a.id, name="待删除工作区", kind="folder", folder_id=folder.id,
    )
    session = ConversationSession(user_id=user_a.id, title="工作区命令测试", source="web")
    session.workspace_id = workspace.id
    db.add(session)
    await db.commit()

    pending = await commands.handle(
        user_a.id, f"/workspace delete {workspace.id}", session_id=session.id,
    )
    assert pending["_command_interaction"] is True
    prompt = pending["prompt"]
    confirm = next(option for option in prompt["options"] if option["id"] == "confirm")
    result = await consume_action(
        db, user_id=user_a.id, prompt_id=prompt["prompt_id"], token=confirm["token"],
    )
    assert result["result"]["status"] == "confirmed"
    assert result["result"]["text"] == "已删除工作区「待删除工作区」（ID %s），项目和文件未受影响。" % workspace.id
    await db.refresh(session)
    assert session.workspace_id is None


@pytest.mark.asyncio
async def test_workspace_god_requires_confirmation_and_grants_current_session(db, user_a, enable_filesystem_authorization):
    from agent.commands import handle
    from app.services.filesystem_authorization import resolve_filesystem_policy
    from app.services.interactions import consume_action

    session = ConversationSession(user_id=user_a.id, title="沙箱授权测试", source="web")
    db.add(session)
    await db.commit()

    pending = await handle(user_a.id, "/workspace god", session_id=session.id)
    assert pending["_command_interaction"] is True
    assert "完整用户沙箱" in pending["prompt"]["body"]
    confirm = next(option for option in pending["prompt"]["options"] if option["id"] == "confirm")
    result = await consume_action(
        db, user_id=user_a.id, prompt_id=pending["prompt"]["prompt_id"], token=confirm["token"],
    )
    assert result["result"]["status"] == "confirmed"
    policy = await resolve_filesystem_policy(db, user_a.id, subject_id=session.id)
    assert policy.full_user_sandbox is True


@pytest.mark.asyncio
async def test_workspace_revoke_restores_read_only_library_policy(db, user_a, enable_filesystem_authorization):
    from app.services.filesystem_authorization import grant_session_filesystem_access, resolve_filesystem_policy

    session = ConversationSession(user_id=user_a.id, title="沙箱撤销测试", source="web")
    db.add(session)
    await db.commit()
    await grant_session_filesystem_access(db, user_a.id, session.id)
    await db.commit()
    assert (await resolve_filesystem_policy(db, user_a.id, subject_id=session.id)).full_user_sandbox

    reply = await commands.handle(user_a.id, "/workspace revoke", session_id=session.id)
    assert "已撤销" in reply
    assert (await resolve_filesystem_policy(db, user_a.id, subject_id=session.id)).full_user_sandbox is False


@pytest.mark.asyncio
async def test_ask_user_can_request_fixed_filesystem_authorization(db, user_a, enable_filesystem_authorization):
    from agent.tools.meta import _ask_user
    from app.services.interactions import create_agent_prompt, consume_action
    from app.models import FilesystemAuthorizationGrant

    session = ConversationSession(user_id=user_a.id, title="askuser 授权测试", source="web")
    db.add(session)
    await db.commit()
    payload = await _ask_user(None, user_a.id, {"authorization": "user_sandbox"})
    assert [item["id"] for item in payload["options"]] == ["confirm", "cancel"]
    prompt, actions = await create_agent_prompt(
        user_id=user_a.id, session_id=session.id, tool_call_id="tool-1",
        tool_name="ask_user", payload=payload,
    )
    result = await consume_action(
        db, user_id=user_a.id, prompt_id=prompt.id,
        token=next(item["token"] for item in actions if item["id"] == "confirm"),
    )
    assert result["result"]["status"] == "confirmed"
    grant = await db.scalar(
        select(FilesystemAuthorizationGrant).where(
            FilesystemAuthorizationGrant.user_id == user_a.id,
            FilesystemAuthorizationGrant.subject_id == str(session.id),
        )
    )
    assert grant.granted_by == "askuser"


@pytest.mark.asyncio
async def test_filesystem_grant_is_isolated_by_user_and_expires(db, user_a, user_b, enable_filesystem_authorization):
    from datetime import timedelta
    from app.core.tz import now_utc
    from app.models import FilesystemAuthorizationGrant
    from app.services.filesystem_authorization import (
        grant_session_filesystem_access, resolve_filesystem_policy,
    )

    session = ConversationSession(user_id=user_a.id, title="授权隔离测试", source="web")
    db.add(session)
    await db.commit()
    await grant_session_filesystem_access(db, user_a.id, session.id)
    await db.commit()
    assert (await resolve_filesystem_policy(db, user_b.id, subject_id=session.id)).full_user_sandbox is False

    grant = await db.scalar(
        select(FilesystemAuthorizationGrant).where(
            FilesystemAuthorizationGrant.user_id == user_a.id,
            FilesystemAuthorizationGrant.subject_id == str(session.id),
        )
    )
    grant.expires_at = now_utc() - timedelta(seconds=1)
    await db.commit()
    assert (await resolve_filesystem_policy(db, user_a.id, subject_id=session.id)).full_user_sandbox is False


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
