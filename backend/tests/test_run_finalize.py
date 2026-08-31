"""统一 run 收尾契约的回归测试。"""
from types import SimpleNamespace

import pytest

from agent.context import run_finalize


class _Db:
    def __init__(self):
        self.items = []

    def add(self, item):
        self.items.append(item)

    async def commit(self):
        return None


class _DbContext:
    def __init__(self, db):
        self.db = db

    async def __aenter__(self):
        return self.db

    async def __aexit__(self, *exc):
        return False


@pytest.mark.asyncio
async def test_finalize_run_uses_one_canonical_persistence_contract(monkeypatch):
    db = _Db()
    baseline_calls = []
    trim_calls = []

    async def cap_usage(*args):
        return 12, 3

    async def trim(session_id):
        trim_calls.append(session_id)

    def schedule(*args, **kwargs):
        baseline_calls.append((args, kwargs))

    monkeypatch.setattr("agent.quota.cap_usage", cap_usage)
    monkeypatch.setattr("app.services.conversation_retention.trim_session_messages", trim)
    monkeypatch.setattr("agent.context.compress_conv.schedule_baseline_update", schedule)
    monkeypatch.setattr(
        "agent.context.assembly.newly_appended",
        lambda messages, initial_len: messages[initial_len:],
    )
    monkeypatch.setattr(
        "agent.context.history.canonicalize_tool_messages",
        lambda messages: [{"role": "assistant", "content": [{"type": "text", "text": "tool"}]}],
    )

    settings = SimpleNamespace(ai=SimpleNamespace(context_tokens=80000))
    model = SimpleNamespace(model="test-model", provider="test", context_tokens=80000)
    result = await run_finalize.finalize_run(
        session_factory=lambda: _DbContext(db),
        session_id=7,
        user_id="user-test",
        settings=settings,
        model_cfg=model,
        rag_context={"blocks": [{"type": "text", "text": "rag"}]},
        messages=[{"role": "assistant", "content": "new"}],
        initial_len=0,
        text="reply",
        files=[],
        tokens_in=100,
        tokens_out=20,
        cache_read=4,
        cache_write=5,
        tools_used=["test_tool"],
        actual_usage_tokens=1234,
        compaction_applied=True,
    )

    assert result.tokens_in == 12
    assert result.tokens_out == 3
    assert len(db.items) == 4  # RAG、tool turn、assistant、usage
    assert trim_calls == [7]
    assert baseline_calls[0][0][0:2] == (7, "user-test")
    assert baseline_calls[0][1]["actual_usage_tokens"] == 1234
    assert baseline_calls[0][1]["compaction_applied"] is True


@pytest.mark.asyncio
async def test_finalize_run_does_not_record_byok_usage(monkeypatch):
    db = _Db()

    async def cap_usage(*args):
        raise AssertionError("BYOK 不应进入咕咕精力封顶")

    monkeypatch.setattr("agent.quota.cap_usage", cap_usage)
    async def trim(_):
        return None

    monkeypatch.setattr("app.services.conversation_retention.trim_session_messages", trim)
    monkeypatch.setattr("agent.context.compress_conv.schedule_baseline_update", lambda *args, **kwargs: None)

    settings = SimpleNamespace(ai=SimpleNamespace(context_tokens=80000))
    model = SimpleNamespace(model="user-model", provider="user-provider", is_byok=True, context_tokens=80000)
    result = await run_finalize.finalize_run(
        session_factory=lambda: _DbContext(db),
        session_id=7,
        user_id="user-test",
        settings=settings,
        model_cfg=model,
        rag_context=None,
        messages=[],
        initial_len=0,
        text="reply",
        files=[],
        tokens_in=100,
        tokens_out=20,
    )

    assert result.tokens_in == 0
    assert result.tokens_out == 0
    assert not any(item.__class__.__name__ == "AgentUsage" for item in db.items)
