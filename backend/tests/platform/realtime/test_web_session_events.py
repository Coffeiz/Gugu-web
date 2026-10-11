"""Web SSE 持久化消息必须通知其他浏览器刷新会话历史。"""
from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
async def test_web_session_append_publishes_session_invalidation_with_origin(monkeypatch):
    from agent.gateway import web

    published = []

    async def fake_publish(user_id, *resources, **kwargs):
        published.append((user_id, resources, kwargs))
        return True

    monkeypatch.setattr("app.core.events.publish", fake_publish)
    req = SimpleNamespace(user_id="user-test", origin="tab-test")
    appended = [{"role": "assistant", "text": "测试回复"}]

    await web._publish_session_append(req, 888, appended)

    assert published == [(
        "user-test",
        ("sessions",),
        {"session_id": 888, "origin": "tab-test", "appended": appended},
    )]


@pytest.mark.asyncio
async def test_web_session_append_does_not_break_chat_when_live_publish_fails(monkeypatch):
    from agent.gateway import web

    async def failing_publish(*_args, **_kwargs):
        raise RuntimeError("live bus unavailable")

    monkeypatch.setattr("app.core.events.publish", failing_publish)

    await web._publish_session_append(
        SimpleNamespace(user_id="user-test", origin=None),
        888,
        [{"role": "user", "text": "测试输入"}],
    )
