"""PRD-LLM-2 Phase 1-3 的轻量协议回归。"""

import asyncio

from agent.interactions.events import INTERACTION_REQUIRED, ROUND_START
from agent.interactions.stream_events import decode_event, encode_event
from app.models import ConversationMessage, ConversationSession
from app.services.interactions import (
    _hash_token,
    consume_action,
    consume_text,
    create_prompt,
    wait_for_resolution,
)


def test_event_identity_survives_round_trip():
    line = encode_event(
        INTERACTION_REQUIRED,
        run_id="run-test",
        round_id="round-2",
        tool_call_id="call-7",
        seq=9,
        prompt_id=12,
    )
    event = decode_event(line)
    assert event is not None
    assert event["run_id"] == "run-test"
    assert event["round_id"] == "round-2"
    assert event["tool_call_id"] == "call-7"
    assert event["seq"] == 9


def test_action_tokens_are_stored_as_one_way_hashes():
    token = "short-lived-action-token"
    assert _hash_token(token) != token
    assert _hash_token(token) == _hash_token(token)


def test_round_event_name_remains_stable():
    assert decode_event(encode_event(ROUND_START, run_id="r", round_id="1", seq=1))["type"] == ROUND_START


def test_ask_user_tool_is_registered_with_bounded_schema():
    from agent.tools import registry

    tool = registry.get("ask_user")
    assert tool is not None
    assert tool.input_schema["additionalProperties"] is False
    assert tool.input_schema["properties"]["options"]["maxItems"] == 8
    assert "title" in tool.input_schema["required"]


async def _make_interaction_session(db, user):
    session = ConversationSession(user_id=user.id, title="交互测试", source="web")
    db.add(session)
    await db.flush()
    db.add(ConversationMessage(
        session_id=session.id,
        role="user",
        content="触发交互",
    ))
    db.add(ConversationMessage(
        session_id=session.id,
        role="assistant",
        content="",
        content_json=[{"type": "tool_call", "id": "call-1", "name": "ask_user", "arguments": {}}],
    ))
    pending_message = ConversationMessage(
        session_id=session.id,
        role="user",
        content="",
        content_json=[{"type": "tool_result", "tool_call_id": "call-1", "content": '{"status":"waiting_input"}'}],
    )
    db.add(pending_message)
    await db.commit()
    return session, pending_message


async def test_ask_user_button_resolves_pending_tool_result(db, user_a):
    session, pending_message = await _make_interaction_session(db, user_a)
    prompt, actions = await create_prompt(
        db,
        user_id=user_a.id,
        session_id=session.id,
        kind="choice",
        title="选择",
        body="选一个",
        options=[{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
        context={"tool_call_id": "call-1"},
    )
    await db.commit()
    result = await consume_action(
        db, user_id=user_a.id, prompt_id=prompt.id, token=actions[0]["token"], event_id="evt-1"
    )
    assert result["result"]["option_id"] == "a"
    await db.refresh(pending_message)
    assert '"status": "selected"' in pending_message.content_json[0]["content"]


async def test_confirmation_button_returns_token_for_resumed_destructive_tool(db, user_a):
    session, pending_message = await _make_interaction_session(db, user_a)
    prompt, actions = await create_prompt(
        db,
        user_id=user_a.id,
        session_id=session.id,
        kind="confirm",
        title="确认：批量删除",
        body="将删除 2 个文件",
        options=[{"id": "confirm", "label": "确认"}, {"id": "cancel", "label": "取消"}],
        context={"tool_call_id": "call-1", "confirm_token": "signed-tool-token"},
    )
    await db.commit()
    result = await consume_action(
        db, user_id=user_a.id, prompt_id=prompt.id, token=actions[0]["token"], event_id="evt-confirm"
    )
    assert result["result"] == {
        "kind": "confirm",
        "status": "confirmed",
        "prompt_id": prompt.id,
        "option_id": "confirm",
        "value": "confirm",
        "text": None,
        "confirm": True,
        "confirm_token": "signed-tool-token",
    }
    await db.refresh(pending_message)
    assert '"confirm": true' in pending_message.content_json[0]["content"]
    assert "signed-tool-token" in pending_message.content_json[0]["content"]


async def test_ask_user_text_requires_explicit_permission_and_resolves(db, user_a):
    session, _pending_message = await _make_interaction_session(db, user_a)
    prompt, actions = await create_prompt(
        db,
        user_id=user_a.id,
        session_id=session.id,
        kind="question",
        title="补充信息",
        body="请填写项目名",
        options=[],
        context={"tool_call_id": "call-1"},
        allow_text_input=True,
    )
    await db.commit()
    assert actions == []
    result = await consume_text(
        db, user_id=user_a.id, prompt_id=prompt.id, text="旅行项目", event_id="evt-2"
    )
    assert result["result"]["status"] == "answered"
    assert result["result"]["text"] == "旅行项目"


async def test_wait_for_resolution_returns_same_interaction_result(db, user_a):
    session, _pending_message = await _make_interaction_session(db, user_a)
    prompt, actions = await create_prompt(
        db,
        user_id=user_a.id,
        session_id=session.id,
        kind="choice",
        title="选择",
        body="选一个",
        options=[{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
        context={"tool_call_id": "call-1"},
    )
    await db.commit()
    waiting = asyncio.create_task(wait_for_resolution(
        user_id=user_a.id, prompt_id=prompt.id, timeout_seconds=1,
    ))
    await asyncio.sleep(0.02)
    await consume_action(
        db, user_id=user_a.id, prompt_id=prompt.id, token=actions[1]["token"], event_id="evt-wait"
    )
    result = await waiting
    assert result is not None
    assert result["option_id"] == "b"
