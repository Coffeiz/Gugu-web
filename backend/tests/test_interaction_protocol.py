"""PRD-LLM-2 Phase 1-3 的轻量协议回归。"""

import asyncio
import json
from datetime import datetime, timedelta

import pytest

from agent.interactions.events import INTERACTION_REQUIRED, ROUND_START
from agent.interactions.stream_events import decode_event, encode_event
from app.models import ConversationMessage, ConversationSession, InteractionPrompt
from app.core.tz import now_utc
from app.services.interactions import (
    _hash_token,
    consume_action,
    consume_choice_text,
    consume_text,
    create_agent_prompt,
    create_goal_mode_prompt,
    create_tool_budget_prompt,
    create_prompt,
    CUSTOM_REPLY_OPTION_ID,
    wait_for_resolution,
)


def test_schema_dict_accepts_legacy_json_string_and_rejects_invalid_values():
    from app.services.interactions import _schema_dict

    assert _schema_dict('{"options":[{"id":"a"}]}')["options"][0]["id"] == "a"
    assert _schema_dict("not-json") == {}
    assert _schema_dict(["not", "an", "object"]) == {}


def test_shell_confirmation_error_envelope_reaches_interaction_bridge():
    """Shell 的嵌套确认结果必须仍然生成网页/IM 确认交互。"""
    from agent.interactions.confirmations import confirmation_payload

    payload = confirmation_payload({
        "error": json.dumps({
            "status": "waiting_confirmation",
            "needs_confirm": True,
            "summary": "允许当前会话临时访问公网",
            "confirm_code": "opaque-confirm-code",
        }, ensure_ascii=False),
    })

    assert payload is not None
    assert payload["needs_confirm"] is True
    assert payload["confirm_code"] == "opaque-confirm-code"


def test_confirmation_protocol_accepts_direct_and_nested_results():
    from agent.interactions.confirmations import confirmation_payload, is_block

    direct = json.dumps({"status": "waiting_confirmation", "needs_confirm": True})
    nested = {"error": direct, "_audit_event": "confirmation_required"}

    assert confirmation_payload(direct)["needs_confirm"] is True
    assert confirmation_payload(nested)["status"] == "waiting_confirmation"
    assert is_block(direct)
    assert is_block(nested)


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
    assert "allow_text_input" not in tool.input_schema["properties"]
    assert "title" in tool.input_schema["required"]


def test_qq_ask_user_text_fallback_lists_options_without_exposing_tokens():
    from agent.interactions.qq import format_text_fallback

    text = format_text_fallback({
        "title": "选一个",
        "body": "请选择处理方式",
        "options": [
            {"id": "keep", "label": "保留"},
            {"id": "remove", "label": "删除", "token": "secret-token"},
        ],
        "allow_text_input": False,
    })
    assert "1. 保留" in text
    assert "2. 删除" in text
    assert "请在网页点击选项" in text
    assert "secret-token" not in text


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


async def test_ask_user_tool_result_creates_waiting_prompt(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="交互回归", source="qq")
    db.add(session)
    await db.commit()

    prompt, actions = await create_agent_prompt(
        user_id=user_a.id,
        session_id=session.id,
        tool_call_id="call-ask-user",
        tool_name="ask_user",
        payload={
            "_interaction": "ask_user",
            "kind": "choice",
            "title": "请选择",
            "body": "请选择下一步",
            "options": [
                {"id": "talk", "label": "继续聊"},
                {"id": "sleep", "label": "去睡觉"},
            ],
        },
    )

    assert prompt.session_id == session.id
    assert prompt.kind == "choice"
    assert [item["id"] for item in actions] == ["talk", "sleep", CUSTOM_REPLY_OPTION_ID]
    assert prompt.schema_json["source"] == "agent"
    assert prompt.schema_json["allow_text_input"] is True


async def test_agent_custom_reply_keeps_prompt_waiting_until_text_is_submitted(db, user_a):
    session, _pending_message = await _make_interaction_session(db, user_a)
    prompt, actions = await create_agent_prompt(
        user_id=user_a.id,
        session_id=session.id,
        tool_call_id="call-custom",
        tool_name="ask_user",
        payload={
            "_interaction": "ask_user",
            "kind": "choice",
            "title": "请选择",
            "body": "请选择下一步",
            "options": [
                {"id": "keep", "label": "保留"},
                {"id": "remove", "label": "删除"},
            ],
        },
    )
    custom = next(item for item in actions if item["id"] == CUSTOM_REPLY_OPTION_ID)
    awaiting = await consume_action(
        db,
        user_id=user_a.id,
        prompt_id=prompt.id,
        token=custom["token"],
        event_id="evt-custom-choice",
    )
    assert awaiting["result"]["status"] == "awaiting_text"
    stored_prompt = await db.get(InteractionPrompt, prompt.id)
    assert stored_prompt.status == "active"
    assert stored_prompt.schema_json["custom_input_active"] is True

    answered = await consume_text(
        db,
        user_id=user_a.id,
        prompt_id=prompt.id,
        text="改成归档",
        event_id="evt-custom-text",
    )
    assert answered["result"]["status"] == "answered"
    assert answered["result"]["text"] == "改成归档"
    stored_prompt = await db.get(InteractionPrompt, prompt.id)
    assert stored_prompt.status == "resolved"


async def test_im_custom_reply_option_then_text_resolves_agent_prompt(db, user_a):
    session, _pending_message = await _make_interaction_session(db, user_a)
    prompt, _actions = await create_agent_prompt(
        user_id=user_a.id,
        session_id=session.id,
        tool_call_id="call-im-custom",
        tool_name="ask_user",
        payload={
            "_interaction": "ask_user",
            "kind": "choice",
            "title": "请选择",
            "body": "请选择下一步",
            "options": [{"id": "one", "label": "选项一"}, {"id": "two", "label": "选项二"}],
        },
    )
    awaiting = await consume_choice_text(
        db,
        user_id=user_a.id,
        session_id=session.id,
        text="自定义回复",
        event_id="evt-im-custom-choice",
    )
    assert awaiting["result"]["status"] == "awaiting_text"
    answered = await consume_text(
        db,
        user_id=user_a.id,
        prompt_id=prompt.id,
        text="使用我的方案",
        event_id="evt-im-custom-text",
    )
    assert answered["result"]["text"] == "使用我的方案"


async def test_system_prompt_cannot_enable_custom_reply(db, user_a):
    session, _pending_message = await _make_interaction_session(db, user_a)
    prompt, actions = await create_prompt(
        db,
        user_id=user_a.id,
        session_id=session.id,
        kind="confirm",
        title="确认操作",
        body="是否继续",
        options=[{"id": "confirm", "label": "确认"}, {"id": "cancel", "label": "取消"}],
        allow_text_input=True,
    )
    assert [item["id"] for item in actions] == ["confirm", "cancel"]
    assert prompt.schema_json["source"] == "system"
    assert prompt.schema_json["allow_text_input"] is False
    with pytest.raises(ValueError, match="不接受文本回答"):
        await consume_text(db, user_id=user_a.id, prompt_id=prompt.id, text="绕过确认")


async def test_round_limit_prompt_only_resumes_current_run_without_persisting_unlimited(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="轮次上限交互", source="web")
    db.add(session)
    await db.commit()

    prompt, actions = await create_goal_mode_prompt(user_id=user_a.id, session_id=session.id)
    assert prompt.kind == "choice"
    assert [item["id"] for item in actions] == ["continue", "cancel"]
    assert all("tool_call_id" not in item for item in actions)

    result = await consume_action(
        db, user_id=user_a.id, prompt_id=prompt.id, token=actions[0]["token"], event_id="evt-goal"
    )
    await db.refresh(session)
    assert result["context"] == {"run_unlimited": True}
    assert session.session_context is None


async def test_tool_budget_prompt_enables_unlimited_without_goal_loop(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="步骤上限交互", source="web")
    db.add(session)
    await db.commit()

    prompt, actions = await create_tool_budget_prompt(user_id=user_a.id, session_id=session.id)
    assert [item["id"] for item in actions] == ["continue", "cancel"]
    await consume_action(
        db, user_id=user_a.id, prompt_id=prompt.id, token=actions[0]["token"], event_id="evt-budget"
    )
    await db.refresh(session)
    assert "unlimited_mode" not in (session.session_context or {})
    expires_at = session.session_context["tool_budget_unlimited_until"]
    assert now_utc() + timedelta(minutes=29) < datetime.fromisoformat(expires_at)


async def test_confirmation_button_grants_server_side_authorization(db, user_a):
    """确认按钮：确认码兑换服务端授权；结果里不再携带任何模型可复述的凭证。"""
    from agent.interactions import confirmations

    session, pending_message = await _make_interaction_session(db, user_a)
    code = confirmations.needs_confirmation({}, "将删除 2 个文件", user_a.id)
    code = json.loads(code)["confirm_code"]
    prompt, actions = await create_prompt(
        db,
        user_id=user_a.id,
        session_id=session.id,
        kind="confirm",
        title="确认：批量删除",
        body="将删除 2 个文件",
        options=[{"id": "confirm", "label": "确认"}, {"id": "cancel", "label": "取消"}],
        context={"tool_call_id": "call-1", "confirm_code": code},
    )
    await db.commit()
    result = await consume_action(
        db, user_id=user_a.id, prompt_id=prompt.id, token=actions[0]["token"], event_id="evt-confirm"
    )
    assert result["result"]["status"] == "confirmed"
    assert result["result"]["confirm"] is True
    assert "confirm_token" not in result["result"]
    await db.refresh(pending_message)
    content = pending_message.content_json[0]["content"]
    assert '"confirm": true' in content
    # 授权记录只在服务端；写入对话的结果不应出现任何凭证。
    assert "token" not in content
    # 兑换后确认码一次性作废。
    assert confirmations.redeem_confirmation(user_a.id, code) is None


async def test_confirm_text_fallback_resolves_confirm_prompt(db, user_a):
    """确认按钮发送失败后的序号/文字回退，必须消费 confirm Prompt。"""
    from app.services.interactions import consume_choice_text

    session, _pending_message = await _make_interaction_session(db, user_a)
    prompt, actions = await create_prompt(
        db,
        user_id=user_a.id,
        session_id=session.id,
        kind="confirm",
        title="确认操作",
        body="是否继续",
        options=[{"id": "confirm", "label": "确认"}, {"id": "cancel", "label": "取消"}],
        context={"tool_call_id": "call-1"},
    )
    await db.commit()

    result = await consume_choice_text(
        db, user_id=user_a.id, session_id=session.id, text="1", event_id="evt-confirm-text"
    )

    assert result is not None
    assert result["kind"] == "confirm"
    assert result["option_id"] == "confirm"
    assert result["result"]["status"] == "selected"
    assert actions[0]["id"] == "confirm"


async def test_agent_text_answer_resolves_agent_prompt(db, user_a):
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
        source="agent",
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


async def test_wait_for_resolution_stops_and_closes_prompt_on_cancel(db, user_a):
    session, _pending_message = await _make_interaction_session(db, user_a)
    prompt, _actions = await create_prompt(
        db,
        user_id=user_a.id,
        session_id=session.id,
        kind="choice",
        title="选择",
        body="选一个",
        options=[{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
    )
    await db.commit()
    cancelled = False

    async def cancel_check():
        return cancelled

    waiting = asyncio.create_task(wait_for_resolution(
        user_id=user_a.id,
        prompt_id=prompt.id,
        timeout_seconds=1,
        cancel_check=cancel_check,
    ))
    await asyncio.sleep(0.02)
    cancelled = True
    result = await waiting
    assert result == {"status": "cancelled", "prompt_id": prompt.id}
    await db.refresh(prompt)
    assert prompt.status == "cancelled"
