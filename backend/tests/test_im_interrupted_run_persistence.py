"""IM 取消出口的持久化复现测试。

复现用户在 IM 中中断一轮后紧接着发送新消息：中断前已经生成的部分正文
应留在同一会话历史中，而不能随共享 Runner 的取消响应一起丢失。
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from agent.context.session_history import load_session_history
from agent.im.actor import ActorContext
from agent.im.loop import PreparedImRequest, dispatch_im_message
from agent.im.session import SessionRoute
from agent.models import AgentRequest
from app.models import ConversationMessage, ConversationSession


def _sse(event: dict) -> str:
    return "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"


@pytest.mark.asyncio
async def test_im_cancel_persists_partial_assistant_message_for_followup(db, user_a, monkeypatch):
    """IM dispatcher 收到取消后，下一轮历史仍须包含已生成的部分正文。"""
    from agent import runner

    session = ConversationSession(
        user_id=user_a.id,
        source="wechat",
        bot_id="test-bot",
        chat_id=None,
        chat_type="private",
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    user_message = ConversationMessage(
        session_id=session.id,
        role="user",
        content="帮我检查一下",
        platform_user_id="test-member",
        chat_type="private",
    )
    db.add(user_message)
    await db.commit()
    await db.refresh(user_message)

    request = AgentRequest(
        message="帮我检查一下",
        user_id=user_a.id,
        user_name="测试用户",
        session_id=session.id,
        source="wechat",
        platform_bot_id="test-bot",
        platform_user_id="test-member",
        chat_id=None,
        im_role="owner",
    )
    actor = ActorContext(
        owner_user_id=user_a.id,
        platform="wechat",
        platform_user_id="test-member",
        role="owner",
        chat_type="private",
        chat_id=None,
    )
    prepared = PreparedImRequest(
        request=request,
        actor=actor,
        role="owner",
        allowed_tool_names=None,
        session_route=SessionRoute("test-bot", "test-member", "private"),
        session_id=session.id,
    )

    class _Runner:
        tool_names = []

        def run(self, *args, **kwargs):
            async def events():
                yield _sse({"type": "token", "content": "已经检查到一半"})
                yield _sse({
                    "type": "tool_call",
                    "name": "read_file",
                    "tool_call_id": "call-running",
                    "status": "running",
                })
                yield _sse({"type": "_cancelled"})

            return events()

    class _PreparedMessages:
        anthr_messages = []
        anthr_initial_len = 0
        oa_messages = []
        oa_initial_len = 0
        rag_context = {}
        stance_to_persist = None

    execution = SimpleNamespace(
        session_id=session.id,
        is_new_session=False,
        session=object(),
        snapshot={},
        system_prompt="test",
        user_message=user_message,
        model_cfg=None,
        run_config=SimpleNamespace(reasoning_persistence="persist"),
        use_anthropic=True,
        context_policy=SimpleNamespace(allow_memory_reflection=False),
        runner=_Runner(),
        prepared=_PreparedMessages(),
        session_factory=lambda: None,
        settings=object(),
    )

    async def fake_prepare_agent_run(_request, *, non_streaming):
        assert non_streaming is True
        return execution

    async def fake_record_usage(*_args, **_kwargs):
        return SimpleNamespace(tokens_in=0, tokens_out=0)

    monkeypatch.setattr(runner, "prepare_agent_run", fake_prepare_agent_run)
    monkeypatch.setattr("agent.llm.llm_select.release", lambda _model: None)
    monkeypatch.setattr("agent.usage.record_usage", fake_record_usage)
    monkeypatch.setattr("app.services.conversation_retention.trim_session_messages", lambda *_args: _async_value(None))
    import app.db.session as db_session
    execution.session_factory = db_session._SessionLocal
    monkeypatch.setattr("agent.im.loop.prepare_message", lambda *_args: _async_value(prepared))
    monkeypatch.setattr(
        "agent.im.loop.decide_im_shortcut",
        lambda *_args, **_kwargs: _async_value({"action": "run"}),
    )
    monkeypatch.setattr("agent.im.loop.handle_im_command", lambda *_args, **_kwargs: _async_value(None))
    monkeypatch.setattr(
        "agent.im.loop._im_display_preferences",
        lambda *_args: _async_value((False, False)),
    )
    monkeypatch.setattr("agent.im.loop.bind_im_context", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("agent.im.loop.remember_im_reach", lambda *_args: _async_value(None))
    monkeypatch.setattr("agent.im.loop.start_im_activity", lambda *_args: _async_value(SimpleNamespace()))
    monkeypatch.setattr("agent.im.loop.finish_im_activity", lambda *_args: _async_value(None))
    monkeypatch.setattr(
        "agent.im.loop.persist_im_session",
        lambda *_args, **_kwargs: _async_value(None),
    )
    monkeypatch.setattr(
        "agent.im.loop.finalize_im_response",
        lambda *_args: _async_value(None),
    )

    from agent.llm import genstream

    monkeypatch.setattr(genstream, "begin", lambda *_args, **_kwargs: _async_value(None))
    monkeypatch.setattr(genstream, "publish", lambda *_args, **_kwargs: _async_value(None))
    monkeypatch.setattr(genstream, "end", lambda *_args, **_kwargs: _async_value(None))

    response = await dispatch_im_message({
        "platform": "wechat",
        "chat_type": "private",
        "channel_id": "test-bot",
        "chat_id": "test-member",
        "platform_user_id": "test-member",
        "owner_user_id": str(user_a.id),
        "text": "帮我检查一下",
        "group_mentioned": True,
        "message_id": "test-message-1",
    })

    assert response.cancelled is True
    assert response.text == ""
    # 模拟紧接着到来的下一条 IM 消息所使用的历史读取路径。
    history = await load_session_history(db, session.id, session.baseline_message_id)
    # 中断前已生成的正文必须进入下一轮上下文，并明确标记为未完成。
    assert any(
        row.role == "assistant" and "已经检查到一半" in row.content
        for row in history
    )
    interrupted_assistant = next(row for row in history if row.role == "assistant")
    assert "[本轮已中止，以上内容未完成]" in interrupted_assistant.content
    tool_items = [
        item for item in interrupted_assistant.display_timeline or []
        if item.get("kind") == "tool"
    ]
    assert tool_items and tool_items[0]["toolStatus"] == "stopped"


async def _async_value(value):
    return value
