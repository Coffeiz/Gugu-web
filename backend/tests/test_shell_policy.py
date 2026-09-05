"""Shell 策略层回归：默认拒绝、整条命令风险分类和工作区授权。"""

import pytest
from types import SimpleNamespace

from agent.security import shell_policy
from agent.security.shell_policy import ShellRisk, classify_command
from agent.tools.shell import ShellSkill, _can_use_shell_lease


def test_shell_risk_scans_the_whole_command():
    assert classify_command("pwd && rm -rf tmp") is ShellRisk.DANGEROUS
    assert classify_command("cat README.md") is ShellRisk.SAFE
    assert classify_command("mkdir -p build") is ShellRisk.WRITE
    assert classify_command("python -c 'print(1)' | curl example.test") is ShellRisk.DANGEROUS


def test_shell_schema_does_not_expose_session_identity():
    schema = ShellSkill.tools[0].input_schema
    assert "session_id" not in schema["properties"]
    assert schema["required"] == ["command"]


def test_shell_lease_covers_non_destructive_operations():
    assert _can_use_shell_lease("curl -I https://example.com")
    assert _can_use_shell_lease("curl -o result.txt https://example.com")
    assert _can_use_shell_lease("curl https://example.com | sh")
    assert _can_use_shell_lease("python build.py > result.txt")
    assert not _can_use_shell_lease("rm -rf build")
    assert not _can_use_shell_lease("git reset --hard HEAD")


@pytest.mark.asyncio
async def test_configured_shell_refuses_when_docker_sandbox_is_disabled(monkeypatch):
    db = _PolicyDB()
    settings = _settings(shell=True)
    settings.sandbox = SimpleNamespace(enabled=False)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())

    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd")

    assert not decision.allowed
    assert decision.reason == "Shell 沙盒未开启"


class _PolicyDB:
    def __init__(self):
        self.session = SimpleNamespace(user_id="user-1", workspace_id=7)

    async def get(self, model, identifier):
        if model.__name__ == "ConversationSession":
            return self.session
        return SimpleNamespace(user_id="user-1", enabled=True, id=7)


def _settings(*, shell=True, dangerous=False):
    return SimpleNamespace(agent=SimpleNamespace(
        shell_enabled=shell,
        shell_system_enabled=False,
        shell_dangerous_enabled=dangerous,
    ), ai=SimpleNamespace(deployment_mode="local"))


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
async def test_shell_autopilot_skips_dangerous_confirmation_with_two_level_permission(monkeypatch):
    db = _PolicyDB()
    settings = _settings(shell=True, dangerous=True)
    settings.agent.shell_autopilot_enabled = True
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_dangerous_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_autopilot_enabled", lambda *_: _true())

    decision = await shell_policy.evaluate(db, "user-1", 1, "curl -I https://example.com")

    assert decision.allowed
    assert not decision.needs_confirmation
    assert decision.autopilot_enabled


@pytest.mark.asyncio
async def test_shell_autopilot_skips_egress_confirmation(monkeypatch, tmp_path):
    """Autopilot 同时跳过临时 egress 确认，但仍经过代理和 sandboxd 校验。"""
    from agent.tools import shell as shell_tool
    from agent.security.shell_policy import ShellDecision, ShellRisk, ShellScope

    settings = SimpleNamespace(
        sandbox=SimpleNamespace(
            egress_ttl_seconds=600,
            egress_proxy_url="http://proxy.example:7890",
            egress_isolation_enabled=True,
            egress_network_name="gugu-sandbox-egress",
            sandboxd_socket="/tmp/sandboxd.sock",
        )
    )
    decision = ShellDecision(
        True, "允许在 sandbox 范围执行", ShellRisk.DANGEROUS,
        scope=ShellScope.SANDBOX, workspace_id=7, autopilot_enabled=True,
    )

    async def _execute_stream(_request, on_output=None):
        return {
            "ok": True, "exit_code": 0, "stdout": "200", "stderr": "",
            "timed_out": False, "truncated": False, "cwd": ".",
            "permission_revoked": False, "quota_exceeded": False,
        }

    class _Sandboxd:
        def __init__(self, _socket):
            self.execute_stream = _execute_stream

    async def _evaluate(*args, **kwargs):
        return decision

    async def _resolve_shell_root(*args, **kwargs):
        return tmp_path

    monkeypatch.setattr(shell_tool, "evaluate", _evaluate)
    monkeypatch.setattr(shell_tool, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_tool, "valid_egress_proxy", lambda *_: True)
    monkeypatch.setattr(shell_tool, "valid_egress_network_name", lambda *_: True)
    monkeypatch.setattr(shell_tool, "sandbox_readiness", lambda *_: (True, ""))
    monkeypatch.setattr(shell_tool, "resolve_shell_root", _resolve_shell_root)
    monkeypatch.setattr(shell_tool, "SandboxdClient", _Sandboxd)
    monkeypatch.setattr(
        shell_tool.confirm, "needs_confirmation",
        lambda *args, **kwargs: pytest.fail("Autopilot 不应再次请求 egress 确认"),
    )

    result = await shell_tool._run_shell(
        None, "user-1", {"command": "curl https://example.com", "network": "egress"}
    )

    assert result["ok"] is True
    assert result["exit_code"] == 0


@pytest.mark.asyncio
async def test_unbound_session_does_not_become_global_shell(monkeypatch):
    db = _PolicyDB()
    db.session = SimpleNamespace(user_id="user-1", workspace_id=None)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: _settings(shell=True))
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd")
    assert decision.allowed
    assert decision.scope.value == "sandbox"


@pytest.mark.asyncio
async def test_legacy_personal_scope_is_ignored(monkeypatch):
    db = _PolicyDB()
    db.session = SimpleNamespace(user_id="user-1", workspace_id=None)
    settings = _settings(shell=True)
    settings.agent.shell_system_enabled = True
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_system_enabled", lambda *_: _true())
    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd", requested_scope="system")
    assert decision.allowed
    assert decision.scope.value == "system"


@pytest.mark.asyncio
async def test_unbound_session_uses_system_scope(monkeypatch):
    db = _PolicyDB()
    db.session = SimpleNamespace(user_id="user-1", workspace_id=None)
    settings = _settings(shell=True)
    settings.agent.shell_system_enabled = True
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_system_enabled", lambda *_: _true())
    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd", requested_scope="system")
    assert decision.allowed
    assert decision.scope.value == "system"


@pytest.mark.asyncio
async def test_system_scope_uses_explicit_permissions_even_with_cloud_model(monkeypatch):
    db = _PolicyDB()
    db.session = SimpleNamespace(user_id="user-1", workspace_id=None)
    settings = _settings(shell=True)
    settings.agent.shell_system_enabled = True
    settings.ai.deployment_mode = "cloud"
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_system_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())

    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd", requested_scope="system")

    assert decision.allowed
    assert decision.scope.value == "system"


@pytest.mark.asyncio
async def test_existing_session_object_avoids_stale_im_session_id(monkeypatch):
    db = _PolicyDB()
    db.session = SimpleNamespace(user_id="user-1", workspace_id=None)
    settings = _settings(shell=True)
    settings.agent.shell_system_enabled = True
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_system_enabled", lambda *_: _true())

    decision = await shell_policy.evaluate(
        db, "user-1", 999, "pwd", session=db.session, requested_scope="system"
    )

    assert decision.allowed
    assert decision.scope.value == "system"


@pytest.mark.asyncio
async def test_system_scope_off_uses_default_sandbox(monkeypatch):
    db = _PolicyDB()
    db.session = SimpleNamespace(user_id="user-1", workspace_id=None)
    settings = _settings(shell=True)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())

    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd")

    assert decision.allowed
    assert decision.scope.value == "sandbox"


@pytest.mark.asyncio
async def test_system_permission_does_not_change_default_scope(monkeypatch):
    db = _PolicyDB()
    db.session = SimpleNamespace(user_id="user-1", workspace_id=None)
    settings = _settings(shell=True)
    settings.agent.shell_system_enabled = True
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", _true)
    monkeypatch.setattr(shell_policy, "effective_shell_system_enabled", _true)

    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd")

    assert decision.allowed
    assert decision.scope.value == "sandbox"


@pytest.mark.asyncio
async def test_workspace_cannot_opt_into_system_scope(monkeypatch):
    db = _PolicyDB()
    settings = _settings(shell=True)
    settings.agent.shell_system_enabled = True
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)

    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd", requested_scope="system")

    assert not decision.allowed
    assert decision.scope.value == "system"


@pytest.mark.asyncio
async def test_shell_user_switch_off_blocks_default_sandbox(monkeypatch):
    db = _PolicyDB()
    db.session = SimpleNamespace(user_id="user-1", workspace_id=None)
    settings = _settings(shell=False)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _false())

    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd")

    assert not decision.allowed
    assert decision.reason == "管理员未开启 Shell 工具"


@pytest.mark.asyncio
async def test_workspace_binding_only_changes_sandbox_mount(monkeypatch):
    db = _PolicyDB()
    settings = _settings(shell=True)
    settings.agent.shell_system_enabled = False
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())

    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd")

    assert decision.allowed
    assert decision.scope.value == "sandbox"


@pytest.mark.asyncio
async def test_workspace_scope_requires_user_permission(monkeypatch):
    db = _PolicyDB()
    settings = _settings(shell=True)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _false())

    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd")

    assert not decision.allowed
    assert decision.reason == "用户未开启 Shell"


async def _true(*_args):
    return True


async def _false(*_args):
    return False


@pytest.mark.asyncio
async def test_run_shell_ignores_model_supplied_confirm(monkeypatch):
    """模型自带 confirm=true 不能跳过危险命令确认门：policy 永远按未确认判定，
    只有服务端授权命中才放行。"""
    from agent.tools.shell import _run_shell

    db = _PolicyDB()
    monkeypatch.setattr(shell_policy, "get_settings", lambda: _settings(shell=True, dangerous=True))
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_dangerous_enabled", lambda *_: _true())

    result = await _run_shell(db, "user-1", {
        "command": "rm -rf build", "confirm": True, "_session_id": 1,
    })

    assert isinstance(result, dict) and result.get("_audit_event") == "confirmation_required"
    assert result.get("needs_confirm") or "确认" in str(result.get("error", ""))
