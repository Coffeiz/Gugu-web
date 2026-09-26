"""自动模式只在交互式工具 dispatch 中生效，且不继承旧 Shell 偏好。"""

import json
from types import SimpleNamespace

import pytest

from agent.interactions.automatic_mode import is_automatic_mode_enabled


@pytest.mark.asyncio
async def test_user_shell_automatic_preference_is_not_migrated_to_general_mode():
    from app.services.user_preferences import effective_automatic_mode_enabled

    class _DB:
        def __init__(self, data):
            self.data = data

        async def scalar(self, *_args, **_kwargs):
            return json.dumps(self.data)

    assert not await effective_automatic_mode_enabled(
        _DB({"shell_autopilot_enabled": True}), "user-id",
    )
    assert not await effective_automatic_mode_enabled(_DB({}), "user-id")
    assert await effective_automatic_mode_enabled(
        _DB({"automatic_mode_enabled": True}), "user-id",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(("session_id", "expected"), [(42, True), (None, False)])
async def test_dispatch_only_enables_mode_for_interactive_session(
    monkeypatch, user_a, session_id, expected,
):
    from agent.tools import base as base_mod
    import app.db.session as session_mod
    import app.core.config as config_mod
    import app.services.user_preferences as preferences_mod

    class _DB:
        async def commit(self):
            return None

    class _FakeSession:
        async def __aenter__(self):
            return _DB()

        async def __aexit__(self, *_args):
            return False

    monkeypatch.setattr(session_mod, "_engine", object())
    monkeypatch.setattr(session_mod, "_SessionLocal", lambda: _FakeSession())
    monkeypatch.setattr(
        config_mod, "get_settings",
        lambda: SimpleNamespace(agent=SimpleNamespace(automatic_mode_enabled=True)),
    )

    async def _enabled(*_args, **_kwargs):
        return True

    monkeypatch.setattr(preferences_mod, "effective_automatic_mode_enabled", _enabled)

    async def _handler(_db, _user_id, _args):
        return {"automatic_mode_enabled": is_automatic_mode_enabled()}

    tool = base_mod.Tool(
        name="_test_automatic_mode_dispatch",
        label="测试自动模式 dispatch",
        description="test",
        input_schema={"type": "object", "properties": {}},
        handler=_handler,
    )
    base_mod.registry._tools[tool.name] = tool
    dispatch_token = base_mod.set_dispatch_session_id(session_id)
    try:
        result, _ = await base_mod.registry.dispatch(user_a.id, tool.name, {})
        assert json.loads(result)["automatic_mode_enabled"] is expected
        assert not is_automatic_mode_enabled()
    finally:
        base_mod.reset_dispatch_session_id(dispatch_token)
        base_mod.registry._tools.pop(tool.name, None)
