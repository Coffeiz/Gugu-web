"""锁定 Web 主请求从持久化到后台 SSE 转发的可观察协议。"""
from __future__ import annotations

import json
import importlib
from types import SimpleNamespace

import pytest

from agent.gateway import web
from agent.models import AgentRequest


class _FakeDb:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def add(self, value):
        if getattr(value, "id", None) is None:
            value.id = 321 if value.__class__.__name__ == "ConversationSession" else 654

    async def flush(self):
        return None

    async def commit(self):
        return None


@pytest.mark.asyncio
async def test_stream_persists_user_message_then_forwards_background_sse(monkeypatch):
    """新 run 先发 session_id，再按顺序转发后台 token/done 帧。"""
    import app.db.session as db_session
    from agent import commands
    from agent.context import (
        loaders,
        provider_history,
        references,
        session_history,
        session_snapshot,
    )
    from agent.core import LLMRunner
    from agent.llm import genstream, modelctx
    from agent.runtime import trace
    from app.byok import service as byok_service
    from app.core import tz
    from app.services import conversation_pending_queue
    from agent.context import compress_conv
    from app.core import events

    web_stream = web.stream
    stream_module = importlib.import_module("agent.gateway.web.stream")

    req = AgentRequest(
        message="你好，帮我总结一下。",
        user_id="00000000-0000-0000-0000-000000000001",
        user_name="小北",
    )
    monkeypatch.setattr(stream_module, "get_settings", lambda: object())
    monkeypatch.setattr(stream_module, "resolve_run_config", lambda *_args: SimpleNamespace(model="test-model"))
    async def resolve_for_user(*_args):
        return SimpleNamespace(model="test-model")
    monkeypatch.setattr(stream_module, "resolve_run_config_for_user", resolve_for_user)
    monkeypatch.setattr(modelctx, "mark_user_scope", lambda: None)
    monkeypatch.setattr(modelctx, "set_model_cfg", lambda *_args: None)
    monkeypatch.setattr(modelctx, "set_usage_context", lambda *_args: None)
    monkeypatch.setattr(trace, "new_trace", lambda: None)
    monkeypatch.setattr(byok_service, "resolve_and_bind_user_embedding", resolve_for_user)
    monkeypatch.setattr(stream_module.quota, "is_exhausted", lambda *_args: _false())
    monkeypatch.setattr(db_session, "_engine", object())
    monkeypatch.setattr(db_session, "_SessionLocal", _FakeDb)

    async def style_prefs(*_args): return {"locale": "zh-CN"}
    async def snapshot(*_args, **_kwargs): return {"user_tz": "UTC"}
    async def history(*_args, **_kwargs): return []
    async def no_value(*_args, **_kwargs): return None
    monkeypatch.setattr(loaders, "load_style_prefs", style_prefs)
    monkeypatch.setattr(session_snapshot, "ensure_snapshot", snapshot)
    monkeypatch.setattr(session_snapshot, "history_baseline", lambda *_args: 0)
    monkeypatch.setattr(session_history, "load_session_history", history)
    monkeypatch.setattr(session_history, "consume_history_stats", lambda: None)
    monkeypatch.setattr(provider_history, "prepare_session", lambda *_args: (None, False))
    monkeypatch.setattr(provider_history, "clean_persisted_history", lambda *_args: None)
    monkeypatch.setattr(stream_module.builder, "build_static_prompt", lambda *_args, **_kwargs: "system")
    monkeypatch.setattr(tz, "set_ctx_tz", lambda *_args: None)

    async def resolve_attachments(*_args, **_kwargs): return "", [], [], []
    async def reference_context(*_args, **_kwargs): return ""
    async def claim_attachments(*_args, **_kwargs): return None
    async def bind_pending(*_args, **_kwargs): return None
    async def publish_append(*_args, **_kwargs): return None
    monkeypatch.setattr(stream_module, "resolve_for_message", resolve_attachments)
    monkeypatch.setattr(stream_module.chat_attach, "claim_attachments", claim_attachments)
    monkeypatch.setattr(references, "build_reference_context", reference_context)
    monkeypatch.setattr(conversation_pending_queue, "bind_pending_queue", bind_pending)
    monkeypatch.setattr(stream_module, "_publish_session_append", publish_append)

    monkeypatch.setattr(commands, "parse", lambda *_args: (None, None))
    monkeypatch.setattr(commands, "is_goal_start", lambda *_args: (False, ""))
    monkeypatch.setattr(commands, "handle", no_value)
    monkeypatch.setattr(compress_conv, "recover_orphaned_session", no_value)

    async def no_op(*_args, **_kwargs): return None
    monkeypatch.setattr(genstream, "open_subscription", no_value)
    monkeypatch.setattr(genstream, "is_active", lambda *_args: _false())
    monkeypatch.setattr(genstream, "new_run_id", lambda: "run-contract")
    monkeypatch.setattr(genstream, "begin", no_value)
    async def subscribe(*_args, **_kwargs):
        yield 'data: {"type":"token","run_id":"run-contract","content":"完成"}\n\n'
        yield 'data: {"type":"done","run_id":"run-contract"}\n\n'
    monkeypatch.setattr(genstream, "subscribe", subscribe)
    monkeypatch.setattr(events, "publish_agent_run_changed", no_value)

    async def background_generation(*_args, **_kwargs): return None
    monkeypatch.setattr(stream_module, "_generate", background_generation)

    frames = [line async for line in web_stream(req)]

    assert json.loads(frames[0][6:-2]) == {
        "type": "session_id", "session_id": 321, "user_message_id": 654,
    }
    assert [json.loads(frame[6:-2]) for frame in frames[1:]] == [
        {"type": "token", "run_id": "run-contract", "content": "完成"},
        {"type": "done", "run_id": "run-contract"},
    ]
    assert req.session_id == 321


async def _false():
    return False
