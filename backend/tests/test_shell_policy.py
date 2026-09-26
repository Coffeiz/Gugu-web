"""Shell 策略层回归：默认拒绝、整条命令风险分类和工作区授权。"""

import pytest
from pathlib import Path
from types import SimpleNamespace

from agent.security import shell_policy
from agent.security.shell_policy import ShellRisk, ShellScope, blocked_runtime, classify_command
from agent.sandbox.client import SandboxdUnavailable
from agent.tools.shell import ShellSkill, _can_use_shell_lease


def test_shell_risk_scans_the_whole_command():
    assert classify_command("pwd && rm -rf tmp") is ShellRisk.DANGEROUS
    assert classify_command("cat README.md") is ShellRisk.SAFE
    assert classify_command("mkdir -p build") is ShellRisk.WRITE
    assert classify_command("python -c 'print(1)' | curl example.test") is ShellRisk.DANGEROUS


def test_blocked_runtime_detects_direct_and_wrapped_invocations():
    assert blocked_runtime("python3 script.py") == "python3"
    assert blocked_runtime("/usr/bin/node app.mjs") == "node"
    assert blocked_runtime("env FOO=bar npm run build") == "npm"
    assert blocked_runtime("bash -c 'python3 script.py'") == "python3"
    assert blocked_runtime("cat README.md") is None


@pytest.mark.asyncio
async def test_full_user_sandbox_authorization_blocks_runtimes_but_keeps_basic_shell(monkeypatch):
    db = _PolicyDB()
    settings = _settings(shell=True)
    settings.sandbox = SimpleNamespace(enabled=True, full_user_sandbox_authorization_enabled=False)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "sandbox_readiness", lambda *_: (True, ""))

    blocked = await shell_policy.evaluate(db, "user-1", 1, "python3 script.py")
    allowed = await shell_policy.evaluate(db, "user-1", 1, "ls")

    assert not blocked.allowed
    assert blocked.reason == "管理员未开启完整用户沙箱授权，禁止使用 python3 运行时"
    assert allowed.allowed


def test_shell_schema_does_not_expose_session_identity():
    schema = ShellSkill.tools[0].input_schema
    assert "session_id" not in schema["properties"]
    assert "network" not in schema["properties"]
    assert schema["required"] == ["command"]
    script_schema = ShellSkill.tools[1].input_schema
    assert "network" not in script_schema["properties"]


def test_shell_lease_covers_non_destructive_operations():
    assert _can_use_shell_lease("curl -I https://example.com")
    assert _can_use_shell_lease("curl -o result.txt https://example.com")
    assert _can_use_shell_lease("curl https://example.com | sh")
    assert _can_use_shell_lease("python build.py > result.txt")
    assert not _can_use_shell_lease("rm -rf build")
    assert not _can_use_shell_lease("git reset --hard HEAD")


@pytest.mark.asyncio
async def test_shell_failure_audit_does_not_mask_original_exception(monkeypatch):
    import agent.tools.shell as shell_tool

    audit = {}

    async def fail_run(*_args, **_kwargs):
        raise RuntimeError("执行器不可用")

    def capture_audit(**fields):
        audit.update(fields)

    monkeypatch.setattr(shell_tool, "_run_shell", fail_run)
    monkeypatch.setattr(shell_tool, "_audit", capture_audit)

    with pytest.raises(RuntimeError, match="执行器不可用"):
        await shell_tool._shell(None, "user-1", {"_session_id": 669})

    assert audit["event"] == "failed"
    assert audit["ok"] is False
    assert audit["session_id"] == 669


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
        self.commit_count = 0

    async def get(self, model, identifier):
        if model.__name__ == "ConversationSession":
            return self.session
        return SimpleNamespace(user_id="user-1", enabled=True, id=7)

    async def commit(self):
        self.commit_count += 1


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
    assert decision.reason == "管理员未开放全部 Shell 命令"


@pytest.mark.asyncio
async def test_dangerous_shell_requires_user_switch_even_when_confirmed(monkeypatch):
    db = _PolicyDB()
    monkeypatch.setattr(shell_policy, "get_settings", lambda: _settings(shell=True, dangerous=True))
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_dangerous_enabled", lambda *_: _false())

    decision = await shell_policy.evaluate(db, "user-1", 1, "rm -rf build", confirm=True)

    assert not decision.allowed
    assert decision.reason == "用户未开放全部 Shell 命令"


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
async def test_dynamic_shell_prompt_reports_disabled_dangerous_state(monkeypatch):
    db = _PolicyDB()
    monkeypatch.setattr(shell_policy, "get_settings", lambda: _settings(shell=True, dangerous=False))
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_dangerous_enabled", lambda *_: _false())

    prompt = await shell_policy.build_dynamic_prompt(db, "user-1", 1, session=db.session)

    assert prompt is not None
    assert "全部 Shell 命令：未开放" in prompt
    assert "不要向用户索要确认后继续" in prompt
    assert "自动模式：未开启" in prompt


@pytest.mark.asyncio
async def test_dynamic_shell_prompt_reports_confirmation_and_automatic_mode(monkeypatch):
    db = _PolicyDB()
    settings = _settings(shell=True, dangerous=True)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_dangerous_enabled", lambda *_: _true())
    monkeypatch.setattr("agent.interactions.automatic_mode.is_automatic_mode_enabled", lambda: True)

    decision = await shell_policy.evaluate(db, "user-1", 1, "curl -I https://example.com")
    prompt = await shell_policy.build_dynamic_prompt(db, "user-1", 1, session=db.session)

    assert decision.allowed
    assert decision.needs_confirmation
    assert prompt is not None
    assert "全部 Shell 命令：已开放，但不是预授权" in prompt
    assert "自动模式：已开启" in prompt
    assert "仍受沙盒、范围、配额和审计限制" in prompt


@pytest.mark.asyncio
async def test_dynamic_shell_prompt_reports_personal_project_write_state(monkeypatch):
    """完整用户沙箱授权必须体现在本轮提示词里：授权前声明只读，授权后声明可写。

    否则模型没有依据判断自己能否写 /personal、/project，只能靠用户的话猜。
    """
    from app.services.filesystem_authorization import FilesystemPolicy

    db = _PolicyDB()
    monkeypatch.setattr(shell_policy, "get_settings", lambda: _settings(shell=True, dangerous=True))
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_dangerous_enabled", lambda *_: _true())
    # evaluate 用 hasattr(db, "execute") 判断是否去解析 policy；给出该属性即可走到授权分支。
    db.execute = lambda *_args, **_kwargs: None

    async def readonly_policy(_db, _user_id, *, subject_type="session", subject_id=None):
        return FilesystemPolicy(subject_type=subject_type, subject_id=str(subject_id))

    monkeypatch.setattr(shell_policy, "resolve_filesystem_policy", readonly_policy)
    readonly = await shell_policy.build_dynamic_prompt(db, "user-1", 1, session=db.session)

    assert readonly is not None
    assert "/personal、/project：本轮以只读方式挂载" in readonly
    assert "需先获得本轮完整用户沙箱授权" in readonly

    async def granted_policy(_db, _user_id, *, subject_type="session", subject_id=None):
        return FilesystemPolicy(
            subject_type=subject_type, subject_id=str(subject_id),
            personal_read_only=False, project_read_only=False,
        )

    monkeypatch.setattr(shell_policy, "resolve_filesystem_policy", granted_policy)
    writable = await shell_policy.build_dynamic_prompt(db, "user-1", 1, session=db.session)

    assert writable is not None
    assert "已按可读写挂载（完整用户沙箱授权生效）" in writable
    assert "只读方式挂载" not in writable


@pytest.mark.asyncio
async def test_dynamic_shell_prompt_is_absent_when_shell_is_not_authorized(monkeypatch):
    db = _PolicyDB()
    monkeypatch.setattr(shell_policy, "get_settings", lambda: _settings(shell=False))

    prompt = await shell_policy.build_dynamic_prompt(db, "user-1", 1, session=db.session)

    assert prompt is None


@pytest.mark.asyncio
async def test_dynamic_shell_prompt_is_absent_when_sandbox_is_disabled(monkeypatch):
    db = _PolicyDB()
    settings = _settings(shell=True)
    settings.sandbox = SimpleNamespace(enabled=False)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)

    prompt = await shell_policy.build_dynamic_prompt(db, "user-1", 1, session=db.session)

    assert prompt is None


@pytest.mark.asyncio
async def test_shell_automatic_mode_routes_egress_through_shared_confirmation_gate(monkeypatch, tmp_path):
    """自动模式下的 egress 操作仍经过共享确认门，不走 Shell 专属放行分支。"""
    from agent.tools import shell as shell_tool
    from agent.security.shell_policy import ShellDecision, ShellRisk, ShellScope

    settings = SimpleNamespace(
        sandbox=SimpleNamespace(
            network_profile="egress",
            egress_ttl_seconds=600,
            egress_proxy_url="http://proxy.example:7890",
            egress_isolation_enabled=True,
            egress_network_name="gugu-sandbox-egress",
            sandboxd_socket="/tmp/sandboxd.sock",
        )
    )
    decision = ShellDecision(
        True, "允许在 sandbox 范围执行", ShellRisk.DANGEROUS, needs_confirmation=True,
        scope=ShellScope.SANDBOX, workspace_id=7,
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
    from agent.interactions.automatic_mode import ACTION, reset_automatic_mode_enabled, set_automatic_mode_enabled

    gate_calls = []
    def _confirm(args, *_args, **kwargs):
        gate_calls.append(kwargs.get("purpose"))
        return original_confirm(args, *_args, **kwargs)
    original_confirm = shell_tool.confirm.needs_confirmation
    monkeypatch.setattr(shell_tool.confirm, "needs_confirmation", _confirm)

    mode_token = set_automatic_mode_enabled(True)
    try:
        result = await shell_tool._run_shell(
            None, "user-1", {"command": "curl https://example.com"}
        )
    finally:
        reset_automatic_mode_enabled(mode_token)

    assert result["ok"] is True
    assert result["exit_code"] == 0
    assert result["network_profile"] == "egress"
    assert result["network_access"] == "egress"
    assert gate_calls == [ACTION]
    assert result["_confirm_gate_authorized"] == "confirmation_gate"


@pytest.mark.asyncio
async def test_run_script_routes_confirmation_through_shared_gate(monkeypatch, tmp_path):
    """脚本操作始终经过共享确认门；自动模式只在确认策略中跳过门。"""
    import agent.tools.shell as shell_tool

    script = tmp_path / "check.py"
    script.write_text("print('ok')", encoding="utf-8")
    monkeypatch.setattr(
        shell_tool,
        "current_filesystem_policy",
        lambda *_: _async_value(SimpleNamespace(workspace_id=7, cwd=".")),
    )
    monkeypatch.setattr(shell_tool, "current_dispatch_filesystem_subject", lambda: {})
    monkeypatch.setattr(shell_tool, "current_dispatch_session", lambda: None)
    monkeypatch.setattr(shell_tool, "current_dispatch_session_id", lambda: 1)
    monkeypatch.setattr(shell_tool, "resolve_shell_root", lambda *_: _async_value(tmp_path))
    monkeypatch.setattr(
        shell_tool,
        "evaluate",
        lambda *_args, **_kwargs: _async_value(SimpleNamespace(
            allowed=True, reason="",
        )),
    )
    captured = {}

    async def _run_shell(*call_args, **kwargs):
        captured.update(call_args[-1] if call_args else {})
        captured.update(kwargs)
        return {"ok": True}

    monkeypatch.setattr(shell_tool, "_run_shell", _run_shell)
    gate_calls = []
    def _confirm(args, *_args, **kwargs):
        gate_calls.append(kwargs.get("purpose"))
        args["confirm"] = True
        return None
    monkeypatch.setattr(shell_tool.confirm, "needs_confirmation", _confirm)

    result = await shell_tool._run_script(None, "user-1", {
        "script_path": "/workspace/check.py", "interpreter": "python3",
    })

    from agent.interactions.automatic_mode import ACTION
    assert gate_calls == [ACTION]
    assert result == {"ok": True, "_confirm_gate_authorized": "confirmation_gate"}
    assert captured["command"] == "python3 /workspace/check.py"
    assert "network" not in captured
    assert captured["_environment"] == {
        "GUGU_SCRIPT_ROOT": "/workspace",
        "GUGU_SCRIPT_PATH": "check.py",
        "GUGU_WORKSPACE": "/workspace",
    }


def _async_value(value):
    async def resolve():
        return value
    return resolve()


@pytest.mark.asyncio
async def test_run_shell_returns_structured_failure_when_sandboxd_is_unavailable(monkeypatch, tmp_path):
    """sandboxd 未配置时应返回失败结果，不能因兜底变量未初始化而抛出内部异常。"""
    from agent.tools import shell as shell_tool
    from agent.security.shell_policy import ShellDecision, ShellRisk, ShellScope

    settings = SimpleNamespace(
        sandbox=SimpleNamespace(sandboxd_socket=""),
    )
    decision = ShellDecision(
        True, "允许在 sandbox 范围执行", ShellRisk.SAFE,
        scope=ShellScope.SANDBOX, workspace_id=7,
    )

    async def _evaluate(*args, **kwargs):
        return decision

    async def _resolve_shell_root(*args, **kwargs):
        return tmp_path

    monkeypatch.setattr(shell_tool, "evaluate", _evaluate)
    monkeypatch.setattr(shell_tool, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_tool, "sandbox_readiness", lambda *_: (True, ""))
    monkeypatch.setattr(shell_tool, "resolve_shell_root", _resolve_shell_root)

    result = await shell_tool._run_shell(None, "user-1", {"command": "ls"})

    assert result["ok"] is False
    assert result["error"] == "sandboxd 未配置，未执行命令"
    assert result["exit_code"] is None


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
async def test_system_scope_ignores_workspace_binding(monkeypatch):
    db = _PolicyDB()
    settings = _settings(shell=True)
    settings.agent.shell_system_enabled = True
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_system_enabled", lambda *_: _true())

    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd", requested_scope="system")

    assert decision.allowed
    assert decision.scope.value == "system"


@pytest.mark.asyncio
async def test_system_scope_does_not_require_sandbox(monkeypatch):
    db = _PolicyDB()
    settings = _settings(shell=True)
    settings.agent.shell_system_enabled = True
    settings.sandbox = SimpleNamespace(enabled=False)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_system_enabled", lambda *_: _true())

    decision = await shell_policy.evaluate(db, "user-1", 1, "pwd", requested_scope="system")

    assert decision.allowed
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
    from agent.tools import shell as shell_tool

    db = _PolicyDB()
    settings = _settings(shell=True, dangerous=True)
    settings.sandbox = SimpleNamespace(
        enabled=True, network_profile="none", full_user_sandbox_authorization_enabled=True,
        persistent_quota_bytes=1024, ephemeral_quota_bytes=1024,
    )
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_tool, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_tool, "sandbox_readiness", lambda *_args: (True, ""))
    monkeypatch.setattr(shell_policy, "sandbox_readiness", lambda *_args: (True, ""))
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_dangerous_enabled", lambda *_: _true())

    result = await _run_shell(db, "user-1", {
        "command": "rm -rf build", "confirm": True, "_session_id": 1,
    })

    assert isinstance(result, dict) and result.get("_audit_event") == "confirmation_required"
    assert result.get("needs_confirm") or "确认" in str(result.get("error", ""))


# ── 完整用户沙箱授权 ───────────────────────────────────────────────────────


def _direct_runtime_settings(*, authorization=True):
    return SimpleNamespace(
        agent=SimpleNamespace(
            shell_enabled=True, shell_system_enabled=False,
            shell_dangerous_enabled=False, automatic_mode_enabled=True,
        ),
        sandbox=SimpleNamespace(
            enabled=True, full_user_sandbox_authorization_enabled=authorization,
            network_profile="none", sandboxd_socket="/tmp/gugu-sandboxd.sock",
            persistent_quota_bytes=1024, egress_proxy_url="",
        ),
        ai=SimpleNamespace(deployment_mode="local"),
    )


def _allowed_decision(needs_confirmation=False):
    return SimpleNamespace(
        allowed=True, reason="允许在 sandbox 范围执行",
        risk=ShellRisk.SAFE, needs_confirmation=needs_confirmation,
        workspace_id=7, scope=ShellScope.SANDBOX,
        full_user_sandbox_write=False,
    )


def _patch_run_shell_harness(monkeypatch, settings, captured, *, db=None):
    """给 _run_shell 打通到 sandboxd 客户端为止的最小桩件；
    captured 记录发往执行器的 allow_script_execution 值。"""
    from agent.tools import shell as shell_tool

    async def _value(value):
        return value

    class _FakeClient:
        def __init__(self, *_a, **_k):
            pass

        async def execute_stream(self, request, on_output=None):
            if db is not None:
                assert db.commit_count == 1
            captured.append(request.allow_script_execution)
            raise SandboxdUnavailable("测试桩到此为止")

    monkeypatch.setattr(shell_tool, "get_settings", lambda: settings)
    async def _fake_evaluate(*_a, **_k):
        return _allowed_decision()

    monkeypatch.setattr(shell_tool, "evaluate", _fake_evaluate)
    monkeypatch.setattr(shell_tool, "current_dispatch_filesystem_subject", lambda: {})
    monkeypatch.setattr(shell_tool, "current_dispatch_session", lambda: None)
    monkeypatch.setattr(shell_tool, "current_dispatch_run_id", lambda: None)
    monkeypatch.setattr(shell_tool, "current_dispatch_session_id", lambda: None)
    monkeypatch.setattr(shell_tool, "resolve_shell_root", lambda *_a, **_k: _value(Path("/tmp")))
    monkeypatch.setattr(shell_tool, "resolve_user_personal_root", lambda *_a, **_k: _value(Path("/tmp")))
    monkeypatch.setattr(shell_tool, "resolve_project_root", lambda *_a, **_k: _value(Path("/tmp")))
    monkeypatch.setattr(shell_tool, "sandbox_readiness", lambda *_a, **_k: (True, ""))
    monkeypatch.setattr(shell_tool, "SandboxdClient", _FakeClient)


def test_shell_meta_guard_waived_for_direct_runtime():
    """直跑模式（allow_script_execution=True）跳过元字符预检：执行器按 argv
    直跑不经过 /bin/sh，`-c` 代码里的 ; | 等只是普通字符，再拦只剩误伤；
    普通模式维持原拒，防模型误写 bash 管道。"""
    from agent.sandbox.local_executor import LocalWorkspaceExecutor

    inline = 'python3 -c "import shutil; shutil.copy(\'/workspace/a.py\', \'/workspace/b.py\'); print(\'ok\')"'
    argv = LocalWorkspaceExecutor._parse_command(inline, allow_script_execution=True)
    assert argv[0] == "python3" and argv[1] == "-c" and ";" in argv[2]

    with pytest.raises(ValueError, match="管道、重定向或命令替换"):
        LocalWorkspaceExecutor._parse_command(inline)

    # 管道类元字符同样只在直跑模式放行
    piped = "python3 -c \"print(1)\" | cat"
    assert LocalWorkspaceExecutor._parse_command(piped, allow_script_execution=True)[0] == "python3"
    with pytest.raises(ValueError, match="管道、重定向或命令替换"):
        LocalWorkspaceExecutor._parse_command(piped)


@pytest.mark.asyncio
async def test_full_user_sandbox_authorization_reaches_executor(monkeypatch):
    """完整授权开启时普通 Shell 可直跑运行时；关闭时交由策略拒绝。"""
    from agent.tools import shell as shell_tool

    for authorization, expected in ((True, True), (False, False)):
        captured = []
        _patch_run_shell_harness(monkeypatch, _direct_runtime_settings(authorization=authorization), captured)
        result = await shell_tool._run_shell(_PolicyDB(), "user-1", {"command": "npm install"})
        assert captured == [expected]
        # 桩件在执行器入口抛 SandboxdUnavailable：调用确实到达执行器并以
        # 失败收场，而不是在更早的策略层被拦截或静默返回 None。
        assert result["ok"] is False
        assert "测试桩到此为止" in result["error"]


@pytest.mark.asyncio
async def test_run_shell_commits_preflight_before_waiting_for_process(monkeypatch):
    """Shell 等待外部进程前应释放本次工具事务，避免 idle-in-transaction 超时。"""
    from agent.tools import shell as shell_tool

    db = _PolicyDB()
    _patch_run_shell_harness(
        monkeypatch, _direct_runtime_settings(authorization=False), [], db=db,
    )

    result = await shell_tool._run_shell(db, "user-1", {"command": "npm install"})

    assert result["ok"] is False
    assert "测试桩到此为止" in result["error"]
    assert db.commit_count == 1


@pytest.mark.asyncio
async def test_full_user_sandbox_authorization_does_not_authorize_run_script(monkeypatch):
    """完整授权只放宽执行器解释器限制，不等价于 run_script 授权：
    定时任务遇到需确认命令的拦截仍按 script_authorized 判定，不能被绕过。"""
    from agent.tools import shell as shell_tool

    captured = []
    _patch_run_shell_harness(monkeypatch, _direct_runtime_settings(authorization=True), captured)

    async def _needs_confirm(*_a, **_k):
        return SimpleNamespace(
            allowed=True, reason="危险命令需要用户确认",
            risk=ShellRisk.DANGEROUS, needs_confirmation=True,
            workspace_id=7, scope=ShellScope.SANDBOX,
            full_user_sandbox_write=False,
        )

    monkeypatch.setattr(shell_tool, "evaluate", _needs_confirm)
    monkeypatch.setattr(
        shell_tool, "current_dispatch_filesystem_subject",
        lambda: {"subject_type": "scheduled_task", "subject_id": "task-1"},
    )

    result = await shell_tool._run_shell(_PolicyDB(), "user-1", {"command": "rm -rf build"})

    assert result.get("error") == "定时任务只能执行无需交互确认的 sandbox 命令"
    assert captured == [], "被拦截的调用不应到达执行器"


@pytest.mark.asyncio
async def test_full_user_sandbox_authorization_is_the_runtime_gate(monkeypatch):
    db = _PolicyDB()
    settings = _direct_runtime_settings(authorization=False)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "sandbox_readiness", lambda *_a: (True, ""))

    decision = await shell_policy.evaluate(db, "user-1", 1, "python3 script.py")

    assert not decision.allowed
    assert decision.reason == "管理员未开启完整用户沙箱授权，禁止使用 python3 运行时"


@pytest.mark.asyncio
async def test_dynamic_prompt_announces_direct_runtime_when_enabled(monkeypatch):
    """开关开启时动态提示告知模型可直跑；关闭时不得出现，避免误导。"""
    db = _PolicyDB()
    settings = _direct_runtime_settings(authorization=True)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(
        shell_policy, "effective_shell_dangerous_enabled", lambda *_: _false())
    monkeypatch.setattr(shell_policy, "sandbox_readiness", lambda *_a: (True, ""))

    enabled_prompt = await shell_policy.build_dynamic_prompt(db, "user-1", 1, session=db.session)
    assert enabled_prompt is not None
    assert "代码运行时：沙盒内可直接执行" in enabled_prompt

    settings.sandbox.full_user_sandbox_authorization_enabled = False
    disabled_prompt = await shell_policy.build_dynamic_prompt(db, "user-1", 1, session=db.session)
    assert disabled_prompt is not None
    assert "代码运行时：沙盒内可直接执行" not in disabled_prompt
