"""Shell 策略层回归：默认拒绝、整条命令风险分类和工作区授权。"""

import pytest
from types import SimpleNamespace

from agent.security import shell_policy
from agent.security.shell_policy import ShellRisk, classify_command
from agent.tools.shell import ShellSkill


def test_shell_risk_scans_the_whole_command():
    assert classify_command("pwd && rm -rf tmp") is ShellRisk.DANGEROUS
    assert classify_command("cat README.md") is ShellRisk.SAFE
    assert classify_command("mkdir -p build") is ShellRisk.WRITE
    assert classify_command("python -c 'print(1)' | curl example.test") is ShellRisk.DANGEROUS


def test_shell_schema_does_not_expose_session_identity():
    schema = ShellSkill.tools[0].input_schema
    assert "session_id" not in schema["properties"]
    assert schema["required"] == ["command"]


class _PolicyDB:
    def __init__(self):
        self.session = SimpleNamespace(user_id="user-1", workspace_id=7, shell_scope="workspace")

    async def get(self, model, identifier):
        if model.__name__ == "ConversationSession":
            return self.session
        return SimpleNamespace(user_id="user-1", enabled=True, id=7)


def _settings(*, shell=True, dangerous=False):
    return SimpleNamespace(agent=SimpleNamespace(
        shell_enabled=shell,
        shell_workspace_enabled=True,
        shell_personal_enabled=False,
        shell_system_enabled=False,
        shell_dangerous_enabled=dangerous,
    ))


@pytest.mark.asyncio
async def test_dangerous_shell_requires_admin_and_user_switches(monkeypatch):
    db = _PolicyDB()
    monkeypatch.setattr(shell_policy, "get_settings", lambda: _settings(shell=True, dangerous=False))
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_dangerous_enabled", lambda *_: _true())

    decision = await shell_policy.evaluate(db, "user-1", 1, "rm -rf build", confirm=True)

    assert not decision.allowed
    assert decision.reason == "管理员未开启危险 Shell 命令"


@pytest.mark.asyncio
async def test_dangerous_shell_requires_user_switch_even_when_confirmed(monkeypatch):
    db = _PolicyDB()
    monkeypatch.setattr(shell_policy, "get_settings", lambda: _settings(shell=True, dangerous=True))
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_dangerous_enabled", lambda *_: _false())

    decision = await shell_policy.evaluate(db, "user-1", 1, "rm -rf build", confirm=True)

    assert not decision.allowed
    assert decision.reason == "用户未开启危险 Shell 命令"


@pytest.mark.asyncio
async def test_dangerous_shell_keeps_confirmation_gate(monkeypatch):
    db = _PolicyDB()
    monkeypatch.setattr(shell_policy, "get_settings", lambda: _settings(shell=True, dangerous=True))
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_dangerous_enabled", lambda *_: _true())

    pending = await shell_policy.evaluate(db, "user-1", 1, "rm -rf build")
    confirmed = await shell_policy.evaluate(db, "user-1", 1, "rm -rf build", confirm=True)

    assert pending.allowed and pending.needs_confirmation
    assert confirmed.allowed and not confirmed.needs_confirmation


@pytest.mark.asyncio
async def test_unbound_session_does_not_become_global_shell(monkeypatch):
    db = _PolicyDB()
    db.session = SimpleNamespace(user_id="user-1", workspace_id=None, shell_scope="off")
    monkeypatch.setattr(shell_policy, "get_settings", lambda: _settings(shell=True))
    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd")
    assert not decision.allowed
    assert decision.reason == "管理员未开启系统 Shell"


@pytest.mark.asyncio
async def test_legacy_personal_scope_is_ignored(monkeypatch):
    db = _PolicyDB()
    db.session = SimpleNamespace(user_id="user-1", workspace_id=None, shell_scope="personal")
    settings = _settings(shell=True)
    settings.agent.shell_system_enabled = True
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_system_enabled", lambda *_: _true())
    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd")
    assert decision.allowed
    assert decision.scope.value == "system"


@pytest.mark.asyncio
async def test_unbound_session_uses_system_scope(monkeypatch):
    db = _PolicyDB()
    db.session = SimpleNamespace(user_id="user-1", workspace_id=None, shell_scope="off")
    settings = _settings(shell=True)
    settings.agent.shell_system_enabled = True
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_system_enabled", lambda *_: _true())
    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd")
    assert decision.allowed
    assert decision.scope.value == "system"


async def _true():
    return True


async def _false():
    return False
