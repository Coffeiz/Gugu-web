"""Web 后台生成复用共享 AgentEvent 消费器时维持 SSE 和持久化契约。"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest


class _FakeDb:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


def _sse(event):
    return "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal_state", ["completed", "failed", "cancelled"])
async def test_web_generation_uses_persistent_event_identity_and_commits_before_terminal(monkeypatch, terminal_state):
    from agent.gateway.web import generation
    import app.db.session as db_session
    from agent import providers
    from agent.context import run_context
    from agent.run import preparation as run_preparation
    from agent.llm import genstream, llm_select, modelctx
    from app.core import events
    from app.services import conversation_pending_queue
    from agent.models import AgentRequest
    from agent.conversation import session_metadata

    order = []
    published = []
    finalized = []
    monkeypatch.setattr(generation, "get_settings", lambda: object())
    monkeypatch.setattr(generation, "set_ctx_tz", lambda *_: None)
    monkeypatch.setattr(generation, "SYSTEM_MEMORY_ENABLED", False)
    monkeypatch.setattr(generation.loaders, "load_dynamic_memory", lambda *_: _async_value({}))
    monkeypatch.setattr(generation.builder, "stance_block", lambda *_: "")
    monkeypatch.setattr(modelctx, "mark_user_scope", lambda: None)
    monkeypatch.setattr(modelctx, "set_usage_context", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(db_session, "_SessionLocal", _FakeDb)
    monkeypatch.setattr(providers, "adapter_for", lambda *_: None)
    monkeypatch.setattr(run_preparation, "_session_user_skill_metadata", lambda *_: None)
    monkeypatch.setattr(run_preparation, "_pin_session_user_skill_metadata", lambda *_: False)

    async def load_tools(*_args, **_kwargs):
        return [], {}

    async def prepare_capabilities(*_args, **_kwargs):
        return [], "system", {}, None

    async def prepare_run(*_args, **_kwargs):
        area = SimpleNamespace(persistence_delta=lambda **_kwargs: SimpleNamespace(entries=[]))
        return SimpleNamespace(rag_context={}, stance_to_persist=None, message_area=area)

    monkeypatch.setattr(run_preparation, "load_mcp_tools_and_rag_context", load_tools)
    monkeypatch.setattr(run_preparation, "prepare_run_capabilities", prepare_capabilities)
    monkeypatch.setattr(run_context, "prepare_run", prepare_run)

    frames = [
        {"type": "round_start", "run_id": "core-run", "round_id": "r1"},
        {"type": "token", "content": "Hello"},
        {"type": "_usage", "input": 20, "context_input": 15, "output": 4},
        {"type": "tool_call", "tool_call_id": "c1", "name": "shell", "label": "Shell", "input": {"cmd": "pwd"}, "status": "running"},
        {"type": "tool_done", "tool_call_id": "c1", "name": "shell", "status": "success", "result": "ok"},
        {"type": "_new_round", "next_round": 2},
        {"type": "round_start", "run_id": "core-run", "round_id": "r2"},
        {"type": "token", "content": "Hello again"},
        {"type": "link_buttons", "link_buttons": [{"label": "Open", "url": "/files"}]},
    ]
    if terminal_state == "failed":
        frames.append({"type": "error", "detail": "上游繁忙"})
    elif terminal_state == "cancelled":
        frames = frames[:4] + [{"type": "_cancelled"}]

    class _Runner:
        def __init__(self, *_args, **_kwargs):
            pass

        def run(self, *_args, **_kwargs):
            async def stream():
                for frame in frames:
                    yield _sse(frame)
            return stream()

    monkeypatch.setattr(generation, "LLMRunner", _Runner)

    async def fake_finalize(**kwargs):
        order.append("persist")
        finalized.append(kwargs)

    async def fake_publish(session_id, event):
        published.append(event)
        if event["type"] == "done":
            order.append("done")

    async def no_op(*_args, **_kwargs):
        return None

    async def checkpoint(*_args, **_kwargs):
        order.append("checkpoint")

    async def seal(*_args, **_kwargs):
        order.append("seal")

    monkeypatch.setattr("agent.context.display_checkpoint.save_checkpoint", checkpoint)
    monkeypatch.setattr("agent.context.display_checkpoint.seal_checkpoint", seal)

    monkeypatch.setattr("agent.context.run_finalize.finalize_run", fake_finalize)
    monkeypatch.setattr(generation, "_publish_session_append", no_op)
    monkeypatch.setattr(genstream, "publish", fake_publish)
    monkeypatch.setattr(genstream, "end", no_op)
    monkeypatch.setattr(genstream, "new_run_id", lambda: "owner-run")
    monkeypatch.setattr(llm_select, "release", lambda *_: None)
    monkeypatch.setattr(session_metadata, "schedule_summary", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(events, "publish_agent_run_changed", no_op)
    monkeypatch.setattr(conversation_pending_queue, "publish_session_pending_queue_changed", no_op)

    req = AgentRequest(message="check", user_id="user-1", user_name="小北")
    await generation._generate_unlocked(
        req, 8, {"system_prompt": "system", "snapshot_context": ""}, [], False,
        user_content="check", user_message=SimpleNamespace(id=55), session=object(),
        model_cfg="model", run_config=SimpleNamespace(use_anthropic=False, reasoning_persistence="off"),
        owner_run_id="owner-run",
    )

    assert all(event["run_id"] == "owner-run" and event["user_message_id"] == 55 for event in published)
    if terminal_state == "completed":
        display = [event['item'] for event in published if event['type'] == 'display_event']
        texts = {item['eventId']: item['text'] for item in display if item.get('text')}
        assert list(texts.values()) == ['Hello', 'Hello again']
        assert all(item.get('createdAt') and item.get('sequence') and item.get('eventId') for item in display)
        assert [event["type"] for event in published if event["type"] in {"round_start", "_new_round", "tool_call", "tool_done", "link_buttons"}] == [
            "round_start", "tool_call", "tool_done", "_new_round", "round_start", "link_buttons",
        ]
        assert finalized[0]["text"] == "Hello again"
        assert finalized[0]["tokens_in"] == 20 and finalized[0]["tokens_out"] == 4
        assert [item["kind"] for item in finalized[0]["display_timeline"]] == ["assistant", "tool", "assistant", "assistant"]
        assert finalized[0]["display_timeline"][1]["toolStatus"] == "success"
        assert finalized[0]["display_timeline"][-1]["linkButtons"][0]["label"] == "Open"
        assert [entry for entry in order if entry != 'checkpoint'] == ["persist", "done"]
    elif terminal_state == "failed":
        assert any(event["type"] == "error" for event in published)
        assert not any(event["type"] == "done" for event in published)
        assert finalized == []
        assert [entry for entry in order if entry != 'checkpoint'] == ["seal"]
    else:
        assert [event["type"] for event in published if event["type"] in {"_cancelled", "tool_done", "done"}] == [
            "_cancelled", "tool_done", "done",
        ]
        assert published[-1]["cancelled"] is True
        assert finalized[0]["interrupted"] is True
        assert finalized[0]["display_timeline"][1]["toolStatus"] == "cancelled"
        assert [entry for entry in order if entry != 'checkpoint'] == ["persist", "done"]


async def _async_value(value):
    return value
