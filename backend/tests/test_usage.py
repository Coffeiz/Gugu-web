from types import SimpleNamespace

import pytest

from agent import usage
from agent.llm import modelctx


@pytest.mark.asyncio
async def test_record_current_usage_uses_user_context(monkeypatch):
    captured = {}

    async def fake_record(user_id, settings, model_cfg, **kwargs):
        captured.update(user_id=user_id, settings=settings, model_cfg=model_cfg, kwargs=kwargs)

    monkeypatch.setattr(usage, "record_usage", fake_record)
    modelctx.set_usage_context("user-test", 17)
    settings = SimpleNamespace()
    model = SimpleNamespace(model="test-model", provider="test", is_byok=True)

    await usage.record_current_usage(
        settings,
        model,
        {"input": 10, "output": 4, "cache_read": 2, "cache_write": 1},
    )

    assert captured == {
        "user_id": "user-test",
        "settings": settings,
        "model_cfg": model,
        "kwargs": {
            "tokens_in": 10,
            "tokens_out": 4,
            "cache_read": 2,
            "cache_write": 1,
            "session_id": 17,
        },
    }


@pytest.mark.asyncio
async def test_record_current_usage_without_context_is_ignored(monkeypatch):
    called = False

    async def fake_record(*_args, **_kwargs):
        nonlocal called
        called = True

    monkeypatch.setattr(usage, "record_usage", fake_record)
    await usage.record_current_usage(SimpleNamespace(), SimpleNamespace(), {"input": 10})

    assert called is False
