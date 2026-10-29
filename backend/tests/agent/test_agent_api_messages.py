"""API 层直调测试：会话消息读取端点的窗口/过滤/工具气泡契约。

沿用 test_trash_folders 的姿势——直接调路由函数（current_user/db 显式传），
不起 HTTP 层；conftest 提供内存 SQLite 与双用户夹具。
对应 CRAP-FULL 高危清单里最大的单体：get_session_messages（CC=50）。
"""

import pytest
from fastapi import HTTPException

from app.api.v1 import agent as agent_api
from app.models import ConversationMessage, ConversationSession, UserMcpServer
from app.db.migrations.chat_timeline import migrate_session_timeline
from sqlalchemy import select


@pytest.fixture(autouse=True)
def _api_env(monkeypatch):
    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr("agent.context.compress_conv.recover_orphaned_session", _noop)
    monkeypatch.setattr("app.api.v1.agent_routes.sessions.filesystem_authorization_enabled", lambda: False)


async def _upgrade_timeline(db, session_id):
    rows = list((await db.execute(select(ConversationMessage).where(
        ConversationMessage.session_id == session_id).order_by(ConversationMessage.id))).scalars())
    updates = migrate_session_timeline(rows)
    for row in rows:
        if row.id in updates:
            row.display_timeline = updates[row.id]
    from app.db.migrations.display_events import migrate_display_events
    for message_id, timeline in migrate_display_events(rows).items():
        next(row for row in rows if row.id == message_id).display_timeline = timeline
    await db.commit()


async def _mk_session(db, user) -> ConversationSession:
    session = ConversationSession(user_id=user.id)
    db.add(session)
    await db.flush()
    return session


async def _mk_message(db, session_id: int, role: str, content: str, **kwargs) -> ConversationMessage:
    message = ConversationMessage(session_id=session_id, role=role, content=content, **kwargs)
    db.add(message)
    await db.flush()
    if message.display_timeline:
        from app.db.migrations.display_events import migrate_display_events
        updates = migrate_display_events([message])
        if message.id in updates:
            message.display_timeline = updates[message.id]
    return message


async def test_get_session_messages_404_for_foreign_or_missing_session(db, user_a, user_b):
    session = await _mk_session(db, user_b)
    with pytest.raises(HTTPException) as exc:
        await agent_api.get_session_messages(session.id, current_user=user_a, db=db)
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as missing:
        await agent_api.get_session_messages(424242, current_user=user_a, db=db)
    assert missing.value.status_code == 404




async def test_get_session_messages_preserves_run_identity_for_plain_replies(db, user_a):
    """普通正文也暴露已存 run 身份，浏览器恢复不能误取下一条队列 run。"""
    session = await _mk_session(db, user_a)
    await _mk_message(db, session.id, "user", "合成问题", run_id="run-current", round_id="round-1")
    reply = await _mk_message(db, session.id, "assistant", "合成回复", run_id="run-current", round_id="round-2")
    await db.commit()
    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)
    result = next(item for item in payload["messages"] if item["id"] == reply.id)
    assert result["runId"] == "run-current"
    assert result["roundId"] == "round-2"


async def test_get_qq_session_messages_hides_legacy_attachment_protocol_text(db, user_a):
    marker = '<attachmentType="image/jpeg",attachmentIndex=0,description="opaque">'
    session = ConversationSession(
        user_id=user_a.id, source="qq", chat_type="group", chat_id="group-synthetic",
    )
    db.add(session)
    await db.flush()
    message = await _mk_message(
        db,
        session.id,
        "user",
        marker,
        files=[{
            "attach_id": "synthetic-attachment",
            "mime": "image/jpeg",
            "quoted": False,
        }],
    )
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)

    result = next(item for item in payload["messages"] if item["id"] == message.id)
    assert result["content"] == ""
    assert result["files"][0]["attach_id"] == "synthetic-attachment"


async def test_get_qq_session_messages_preserves_unmatched_attachment_like_user_text(db, user_a):
    marker = '<attachmentType="image/jpeg",attachmentIndex=0,description="opaque">'
    session = ConversationSession(
        user_id=user_a.id, source="qq", chat_type="group", chat_id="group-synthetic",
    )
    db.add(session)
    await db.flush()
    message = await _mk_message(
        db,
        session.id,
        "user",
        marker,
        files=[{
            "attach_id": "synthetic-attachment",
            "mime": "image/png",
            "quoted": False,
        }],
    )
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)

    result = next(item for item in payload["messages"] if item["id"] == message.id)
    assert result["content"] == marker


async def test_run_history_query_returns_only_target_run_after_commit(db, user_a):
    session = await _mk_session(db, user_a)
    for run_id in ('run-target', 'run-next'):
        await _mk_message(db, session.id, 'assistant', '合成回复', run_id=run_id, display_timeline=[
            {'kind': 'assistant', 'text': run_id, 'runId': run_id, 'roundId': 'r1'}])
    await db.commit()
    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db, run_id='run-target')
    assert [item['runId'] for item in payload['timelineEvents']] == ['run-target']
    assert payload['timelineEvents'][0]['eventId']


async def test_web_secret_link_and_submit_are_owner_scoped_for_group_session(db, user_a, user_b):
    from app.api.v1.agent import SecretInteractionRequest
    from app.services.interactions import create_agent_prompt

    server = UserMcpServer(
        user_id=user_a.id, scope="user", name="group_web_secret",
        endpoint="https://m.example.com", credential_slots=[
            {"id": "key", "label": "Key", "target": "header", "name": "X-Key"},
        ],
    )
    session = ConversationSession(
        user_id=user_a.id, title="group secret", source="qq", bot_id="bot-a",
        chat_type="group", chat_id="group-a", platform_user_id="member-a",
    )
    db.add_all([server, session])
    await db.commit()
    prompt, _ = await create_agent_prompt(
        user_id=user_a.id, session_id=session.id, tool_call_id="group-web-secret",
        tool_name="manage_mcp_servers", payload={
            "_interaction": "ask_user", "kind": "form", "title": "补全凭据",
            "secret_fields": [{"name": "key", "label": "Key", "type": "secret"}],
            "secret_target": {"kind": "mcp_credentials", "server_id": str(server.id)},
        },
    )
    await db.commit()

    assert await agent_api.get_interaction_session(
        prompt.id, current_user=user_a, db=db,
    ) == {"session_id": session.id}
    with pytest.raises(HTTPException) as link_denied:
        await agent_api.get_interaction_session(prompt.id, current_user=user_b, db=db)
    assert link_denied.value.status_code == 404
    with pytest.raises(HTTPException) as submit_denied:
        await agent_api.submit_secret_interaction(
            prompt.id, SecretInteractionRequest(values={"key": "private-value"}),
            current_user=user_b, db=db,
        )
    assert submit_denied.value.status_code == 404

    result = await agent_api.submit_secret_interaction(
        prompt.id, SecretInteractionRequest(values={"key": "private-value"}),
        current_user=user_a, db=db,
    )
    assert result == {"ok": True, "prompt_id": prompt.id}


async def test_get_session_messages_window_filters_and_has_more(db, user_a):
    session = await _mk_session(db, user_a)
    for index in range(4):
        await _mk_message(db, session.id, "user" if index % 2 == 0 else "assistant", f"m{index}")
    # 两类必须被过滤的行：压缩摘要（role=summary）与工具中间消息（content_json 非空）
    await _mk_message(db, session.id, "summary", "压缩摘要不进气泡")
    await _mk_message(db, session.id, "assistant", "", content_json=[{"type": "tool_use", "id": "c"}])
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, limit=2, current_user=user_a, db=db)

    # 分页只消耗展示行，canonical 上下文和摘要均不占窗口。
    assert [item["content"] for item in payload["messages"]] == ["m2", "m3"]
    assert payload["pagination"] == {
        "limit": 2, "hasMore": True, "hasNewer": False,
        "oldestId": payload["messages"][0]["id"], "newestId": payload["messages"][-1]["id"],
    }
    assert payload["session"]["id"] == session.id
    assert payload["active"] is False
    assert payload["executionState"] == session.execution_state


async def test_get_session_messages_before_id_page_is_oldest_first(db, user_a):
    session = await _mk_session(db, user_a)
    for index in range(3):
        await _mk_message(db, session.id, "user", f"m{index}")
    await db.commit()

    # before_id 是已加载窗口最旧 id；取更早的最近一页，并统一按旧→新返回。
    payload = await agent_api.get_session_messages(
        session.id, limit=10, before_id=3, current_user=user_a, db=db)

    assert [item["content"] for item in payload["messages"]] == ["m0", "m1"]
    # 同页消息不能被误判成下一页；游标名称与实际 ID 顺序一致。
    assert payload["pagination"]["hasMore"] is False
    assert payload["pagination"]["oldestId"] == payload["messages"][0]["id"]
    assert payload["pagination"]["newestId"] == payload["messages"][1]["id"]


async def test_get_session_messages_emits_timeline_and_suppresses_tool_events(db, user_a):
    session = await _mk_session(db, user_a)
    timeline = [
        {"kind": "tool", "name": "http_get"},
        {"kind": "assistant", "text": "结果"},
        {
            "kind": "assistant",
            "text": "",
            "linkButtons": {
                "message": "相关入口",
                "buttons": [{"id": "docs", "label": "文档", "url": "https://example.com/docs"}],
            },
        },
    ]
    await _mk_message(db, session.id, "user", "问题")
    timeline_message = await _mk_message(
        db, session.id, "assistant", "", display_timeline=timeline)
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)

    # 带 display_timeline 的 assistant 轮次走 timelineEvents，不重复进正文列表
    assert all(not (m["role"] == "assistant" and m["content"] == "") for m in payload["messages"])
    events = payload["timelineEvents"]
    assert [event["kind"] for event in events] == ["tool", "assistant", "assistant"]
    assert events[0]["timelineOrder"] == timeline_message.id * 1_000_000 + 1
    assert events[2]["linkButtons"]["buttons"][0]["url"] == "https://example.com/docs"
    assert "toolEvents" not in payload  # 不再暴露第二套工具展示协议


async def test_get_session_messages_replaces_legacy_timeline_media_payload(db, user_a):
    """历史工具详情按需读取，且展开时仍清理旧时间线中的媒体载荷。"""
    session = await _mk_session(db, user_a)
    await _mk_message(db, session.id, "user", "查看视频")
    await _mk_message(db, session.id, "assistant", "", display_timeline=[
        {
            "kind": "tool", "toolName": "read_file", "toolCallId": "video-call",
            "toolResult": [{"type": "video", "source": {"type": "base64", "data": "synthetic-media-payload"}}],
        },
    ])
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)

    event = payload["timelineEvents"][0]
    assert event["toolName"] == "read_file"
    assert event["detailsAvailable"] is True
    assert "toolResult" not in event
    details = await agent_api.get_session_tool_event_details(
        session.id, source="timeline", message_id=event["messageId"], timeline_index=0,
        current_user=user_a, db=db,
    )
    assert details["toolResult"] == [{"type": "text", "text": "[视频已查看]"}]


async def test_migrated_session_timeline_preserves_legacy_files(db, user_a):
    """旧版只写 assistant.files 的消息也要在时间线中恢复附件卡。"""
    session = await _mk_session(db, user_a)
    await _mk_message(db, session.id, "user", "发图")
    await _mk_message(
        db, session.id, "assistant", "", display_timeline=[
            {"kind": "assistant", "text": "图片已发送"},
        ], files=[{
            "attach_id": "attachment-1", "name": "结果.png", "ext": "png",
            "kind": "image",
        }])
    await db.commit()

    await _upgrade_timeline(db, session.id)
    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)

    assert payload["timelineEvents"][-1]["files"][0]["attach_id"] == "attachment-1"


@pytest.mark.parametrize("source,chat_type", [
    ("web", None), ("qq", "c2c"), ("qq", "group"),
    ("feishu", "c2c"), ("feishu", "group"),
    ("wechat", "c2c"), ("wechat", "group"),
])
@pytest.mark.parametrize("kind,ext", [
    ("image", "png"), ("audio", "flac"), ("video", "mp4"),
    ("file", "pdf"), ("file", "txt"),
])
async def test_user_attachment_never_becomes_assistant_timeline_event(
    db, user_a, source, chat_type, kind, ext,
):
    """跨端用户附件只展示一次，不凭空生成未调用模型的助手回复。"""
    session = await _mk_session(db, user_a)
    session.source, session.chat_type = source, chat_type
    files = [{"attach_id": "synthetic-upload", "kind": kind, "ext": ext, "upload": True}]
    message = await _mk_message(db, session.id, "user", "查看附件", files=files)
    await db.commit()

    for after_id in (None, message.id - 1):
        payload = await agent_api.get_session_messages(
            session.id, after_id=after_id, current_user=user_a, db=db,
        )
        assert len(payload["messages"]) == 1
        assert payload["messages"][0]["role"] == "user"
        assert payload["messages"][0]["files"] == files
        assert payload["timelineEvents"] == []


async def test_assistant_attachment_without_timeline_is_not_duplicated(db, user_a):
    """没有时间线的旧助手附件由消息本体展示，不再补一个重复附件事件。"""
    session = await _mk_session(db, user_a)
    files = [{"attach_id": "synthetic-result", "kind": "file", "ext": "pdf"}]
    await _mk_message(db, session.id, "assistant", "结果", files=files)
    await db.commit()
    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)
    assert payload["messages"][0]["files"] == files
    assert payload["timelineEvents"] == []


async def test_get_session_messages_pairs_tool_events_within_window(db, user_a):
    session = await _mk_session(db, user_a)
    await _mk_message(db, session.id, "user", "帮我抓个网页")
    await _mk_message(
        db, session.id, "assistant", "",
        content_json=[{"type": "tool_use", "id": "call-1", "name": "http_get", "input": {"url": "https://x"}}],
        run_id="run-1", round_id="round-1")
    result_message = await _mk_message(
        db, session.id, "tool", "",
        content_json=[{"type": "tool_result", "tool_call_id": "call-1", "content": [
            {"type": "video", "source": {"type": "base64", "data": "synthetic-media-payload"}},
        ]}], run_id="run-1", round_id="round-1")
    await _mk_message(db, session.id, "assistant", "抓到了")
    await db.commit()

    await _upgrade_timeline(db, session.id)
    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)

    # 升级后工具展示和详情均来自持久时间线，canonical 正文保留但不参与显示。
    assert [item["content"] for item in payload["messages"]] == ["帮我抓个网页"]
    assert len(payload["timelineEvents"]) == 2
    event = payload["timelineEvents"][0]
    assert event["toolCallId"] == "call-1"
    assert event["detailsAvailable"] is True
    assert "toolInput" not in event and "toolResult" not in event
    details = await agent_api.get_session_tool_event_details(
        session.id, source="timeline", message_id=event["messageId"], timeline_index=0,
        current_user=user_a, db=db,
    )
    assert details["toolResult"] == [{"type": "text", "text": "[视频已查看]"}]
    # 配对后时间线位置取「结果所在消息」，恢复窗口时才不会把工具气泡排到结果之前
    assert event["timelineOrder"] < payload['timelineEvents'][1]['timelineOrder']
    assert payload['timelineEvents'][1]['text'] == '抓到了'


async def test_older_message_pages_walk_to_start_without_duplicates(db, user_a):
    session = await _mk_session(db, user_a)
    for index in range(7):
        await _mk_message(db, session.id, "user", f"page-{index}")
    await db.commit()
    cursor = None
    collected = []
    for _ in range(4):
        payload = await agent_api.get_session_messages(
            session.id, limit=2, before_id=cursor, current_user=user_a, db=db,
        )
        ids = [item["id"] for item in payload["messages"]]
        assert ids == sorted(ids)
        assert not set(ids).intersection(collected)
        collected.extend(ids)
        if not payload["pagination"]["hasMore"]:
            break
        next_cursor = payload["pagination"]["oldestId"]
        assert cursor is None or next_cursor < cursor
        cursor = next_cursor
    assert len(collected) == 7
    assert payload["pagination"]["hasMore"] is False


async def test_older_page_keeps_tools_between_last_body_and_next_page(db, user_a):
    session = await _mk_session(db, user_a)
    await _mk_message(db, session.id, "user", "旧页正文")
    await _mk_message(db, session.id, "assistant", "", content_json=[{
        "type": "tool_use", "id": "page-tool", "name": "http_get", "input": {"url": "https://example.com"},
    }])
    await _mk_message(db, session.id, "user", "", content_json=[{
        "type": "tool_result", "tool_call_id": "page-tool", "content": "ok",
    }])
    newer = await _mk_message(db, session.id, "assistant", "新页正文")
    await db.commit()
    await _upgrade_timeline(db, session.id)
    payload = await agent_api.get_session_messages(
        session.id, limit=3, before_id=newer.id, current_user=user_a, db=db,
    )
    assert [item['content'] for item in payload['messages']] == ['旧页正文']
    assert [event['toolName'] for event in payload['timelineEvents']] == ['http_get']
    assert payload['timelineEvents'][0]['toolStatus'] == 'success'


async def test_tool_event_details_require_owned_session(db, user_a, user_b):
    session = await _mk_session(db, user_b)
    with pytest.raises(HTTPException) as denied:
        await agent_api.get_session_tool_event_details(
            session.id, source="timeline", message_id=1, timeline_index=0,
            current_user=user_a, db=db,
        )
    assert denied.value.status_code == 404


async def _mk_group_session(db, user, bot_id: str | None = None) -> ConversationSession:
    session = ConversationSession(
        user_id=user.id, source="qq", chat_type="group", chat_id="group-openid-1", bot_id=bot_id,
    )
    db.add(session)
    await db.flush()
    return session


async def test_group_mention_shows_mentioned_bot_own_nickname(db, user_a):
    """@ 到别的 bot 显示它自己的昵称，不再一律显示"咕咕"。

    群里同时有多个 bot 时，"咕咕"会指错对象；机器人发言记录里带平台昵称，
    展示层据此还原被 @ 的那个 bot 的名字。
    """
    from app.models import UserBot

    own_bot = UserBot(user_id=user_a.id, platform="qq", app_id="synthetic-own-app",
                      name="我的 QQ 机器人", bot_platform_user_id="OWNBOTID00000000000000000001")
    db.add(own_bot)
    await db.flush()
    session = await _mk_group_session(db, user_a, str(own_bot.id))
    await _mk_message(db, session.id, "user", "<@OTHERBOTID00000000000000000002> 看看天气",
                      platform_bot_user_id="OTHERBOTID00000000000000000002")
    await _mk_message(db, session.id, "user", "今天晴，15 度", platform_user_id="OTHERBOTID00000000000000000002",
                      platform_user_name="小北的机器人")
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)
    contents = [item["content"] for item in payload["messages"]]
    assert "@小北的机器人 看看天气" in contents
    assert not any("咕咕" in content for content in contents)


async def test_group_mention_of_own_bot_shows_gugu(db, user_a):
    """@ 自己这个会话的 bot 仍显示"咕咕"——那是群里看到的它的昵称。"""
    from app.models import UserBot

    own_bot = UserBot(user_id=user_a.id, platform="qq", app_id="synthetic-own-app",
                      name="我的 QQ 机器人", bot_platform_user_id="OWNBOTID00000000000000000001")
    db.add(own_bot)
    await db.flush()
    session = await _mk_group_session(db, user_a, str(own_bot.id))
    await _mk_message(db, session.id, "user", "<@OWNBOTID00000000000000000001> 看看天气")
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)
    contents = [item["content"] for item in payload["messages"]]
    assert "@咕咕 看看天气" in contents


async def test_group_mention_of_other_own_bot_uses_its_configured_name(db, user_a):
    """@ 用户自己的另一个 bot 显示它在 IM 配置里的名字，不占用"咕咕"。"""
    from app.models import UserBot

    own_bot = UserBot(user_id=user_a.id, platform="qq", app_id="synthetic-own-app",
                      name="我的 QQ 机器人", bot_platform_user_id="OWNBOTID00000000000000000001")
    sibling_bot = UserBot(user_id=user_a.id, platform="qq", app_id="synthetic-sibling-app",
                          name="二号小咕", bot_platform_user_id="OWNBOTID00000000000000000003")
    db.add_all([own_bot, sibling_bot])
    await db.flush()
    session = await _mk_group_session(db, user_a, str(own_bot.id))
    await _mk_message(db, session.id, "user", "<@OWNBOTID00000000000000000003> 在吗")
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)
    contents = [item["content"] for item in payload["messages"]]
    assert "@二号小咕 在吗" in contents


async def test_group_mention_of_unknown_id_keeps_raw_platform_id(db, user_a):
    """解析不到名字的 mention 保持原始平台 ID，不猜名字也不写死"咕咕"。"""
    from app.models import UserBot

    own_bot = UserBot(user_id=user_a.id, platform="qq", app_id="synthetic-own-app",
                      name="我的 QQ 机器人", bot_platform_user_id="OWNBOTID00000000000000000001")
    db.add(own_bot)
    await db.flush()
    session = await _mk_group_session(db, user_a, str(own_bot.id))
    await _mk_message(db, session.id, "user", "<@SILENTBOTID0000000000000000004> 在吗")
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)
    contents = [item["content"] for item in payload["messages"]]
    assert "<@SILENTBOTID0000000000000000004> 在吗" in contents
    assert "@咕咕 在吗" not in contents


async def test_group_mention_uses_latest_nickname_after_rename(db, user_a):
    """改名后 @ 显示新昵称，不冻结旧名字。"""
    from datetime import datetime, timedelta, timezone

    from app.models import UserBot

    own_bot = UserBot(user_id=user_a.id, platform="qq", app_id="synthetic-own-app",
                      name="我的 QQ 机器人", bot_platform_user_id="OWNBOTID00000000000000000001")
    db.add(own_bot)
    await db.flush()
    session = await _mk_group_session(db, user_a, str(own_bot.id))
    base = datetime(2026, 10, 1, tzinfo=timezone.utc)
    await _mk_message(db, session.id, "user", "<@HUMANID0000000000000000000005> 一起来",
                      created_at=base)
    await _mk_message(db, session.id, "user", "旧名字", platform_user_id="HUMANID0000000000000000000005",
                      platform_user_name="小北", created_at=base + timedelta(minutes=1))
    await _mk_message(db, session.id, "user", "新名字", platform_user_id="HUMANID0000000000000000000005",
                      platform_user_name="小北改名后", created_at=base + timedelta(minutes=2))
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)
    contents = [item["content"] for item in payload["messages"]]
    assert "@小北改名后 一起来" in contents


async def test_group_mention_in_quoted_text_uses_same_display_name(db, user_a):
    """引用原文里的 @ 也走同一套展示名，不露原始平台 ID。"""
    from app.models import UserBot

    own_bot = UserBot(user_id=user_a.id, platform="qq", app_id="synthetic-own-app",
                      name="我的 QQ 机器人", bot_platform_user_id="OWNBOTID00000000000000000001")
    db.add(own_bot)
    await db.flush()
    session = await _mk_group_session(db, user_a, str(own_bot.id))
    await _mk_message(db, session.id, "user", "看看这条",
                      quoted_text="<@OTHERBOTID00000000000000000002> 早上好")
    await _mk_message(db, session.id, "user", "今天晴，15 度",
                      platform_user_id="OTHERBOTID00000000000000000002", platform_user_name="小北的机器人")
    await db.commit()

    payload = await agent_api.get_session_messages(session.id, current_user=user_a, db=db)
    quoted = [item["quotedText"] for item in payload["messages"] if item["quotedText"]]
    assert quoted == ["@小北的机器人 早上好"]
