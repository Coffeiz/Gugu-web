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
async def test_sandbox_code_execution_switch_blocks_runtimes_but_keeps_basic_shell(monkeypatch):
    db = _PolicyDB()
    settings = _settings(shell=True)
    settings.sandbox = SimpleNamespace(enabled=True, code_execution_enabled=False)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "sandbox_readiness", lambda *_: (True, ""))

    blocked = await shell_policy.evaluate(db, "user-1", 1, "python3 script.py")
    allowed = await shell_policy.evaluate(db, "user-1", 1, "ls")

    assert not blocked.allowed
    assert blocked.reason == "管理员未开启代码运行环境，禁止使用 python3 运行时"
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
    assert "Autopilot：未开启" in prompt


@pytest.mark.asyncio
async def test_dynamic_shell_prompt_reports_confirmation_and_autopilot(monkeypatch):
    db = _PolicyDB()
    settings = _settings(shell=True, dangerous=True)
    settings.agent.shell_autopilot_enabled = True
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_dangerous_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_autopilot_enabled", lambda *_: _true())

    prompt = await shell_policy.build_dynamic_prompt(db, "user-1", 1, session=db.session)

    assert prompt is not None
    assert "全部 Shell 命令：已开放，但不是预授权" in prompt
    assert "Autopilot：已开启" in prompt
    assert "仍受沙盒、范围、配额和审计限制" in prompt


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
async def test_shell_uses_admin_egress_policy_without_tool_network_argument(monkeypatch, tmp_path):
    """后台 egress 策略自动生效，不要求 Agent 传 network 参数。"""
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
        None, "user-1", {"command": "curl https://example.com"}
    )

    assert result["ok"] is True
    assert result["exit_code"] == 0
    assert result["network_profile"] == "egress"
    assert result["network_access"] == "egress"
    assert result["_confirm_gate_authorized"] == "shell_autopilot"


@pytest.mark.asyncio
async def test_run_script_autopilot_skips_script_confirmation(monkeypatch, tmp_path):
    """脚本确认也必须接入 Autopilot，但仍通过后续 Shell 执行边界。"""
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
            allowed=True, reason="", autopilot_enabled=True,
        )),
    )
    captured = {}

    async def _run_shell(*call_args, **kwargs):
        captured.update(call_args[-1] if call_args else {})
        captured.update(kwargs)
        return {"ok": True}

    monkeypatch.setattr(shell_tool, "_run_shell", _run_shell)
    monkeypatch.setattr(
        shell_tool.confirm,
        "needs_confirmation",
        lambda *_args, **_kwargs: pytest.fail("Autopilot 不应再次要求脚本确认"),
    )

    result = await shell_tool._run_script(None, "user-1", {
        "script_path": "/workspace/check.py", "interpreter": "python3",
    })

    assert result == {"ok": True, "_confirm_gate_authorized": "shell_autopilot"}
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

    db = _PolicyDB()
    monkeypatch.setattr(shell_policy, "get_settings", lambda: _settings(shell=True, dangerous=True))
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "effective_shell_dangerous_enabled", lambda *_: _true())

    result = await _run_shell(db, "user-1", {
        "command": "rm -rf build", "confirm": True, "_session_id": 1,
    })

    assert isinstance(result, dict) and result.get("_audit_event") == "confirmation_required"
    assert result.get("needs_confirm") or "确认" in str(result.get("error", ""))


# ── Shell 直跑运行时开关（sandbox.shell_direct_runtime_enabled）────────────────


def _direct_runtime_settings(*, direct=False, code_execution=True):
    return SimpleNamespace(
        agent=SimpleNamespace(
            shell_enabled=True, shell_system_enabled=False,
            shell_dangerous_enabled=False, shell_autopilot_enabled=False,
        ),
        sandbox=SimpleNamespace(
            enabled=True, code_execution_enabled=code_execution,
            shell_direct_runtime_enabled=direct,
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
        autopilot_enabled=False, full_user_sandbox_write=False,
    )


def _patch_run_shell_harness(monkeypatch, settings, captured):
    """给 _run_shell 打通到 sandboxd 客户端为止的最小桩件；
    captured 记录发往执行器的 allow_script_execution 值。"""
    from agent.tools import shell as shell_tool

    async def _value(value):
        return value

    class _FakeClient:
        def __init__(self, *_a, **_k):
            pass

        async def execute_stream(self, request, on_output=None):
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


@pytest.mark.asyncio
async def test_shell_direct_runtime_switch_reaches_executor(monkeypatch):
    """开关开启时，普通 Shell 的运行时命令直接带 allow_script_execution=True
    进执行器；关闭（默认）时维持 False，由执行器拒绝。"""
    from agent.tools import shell as shell_tool

    for direct, expected in ((True, True), (False, False)):
        captured = []
        _patch_run_shell_harness(monkeypatch, _direct_runtime_settings(direct=direct), captured)
        result = await shell_tool._run_shell(_PolicyDB(), "user-1", {"command": "npm install"})
        assert captured == [expected]
        # 桩件在执行器入口抛 SandboxdUnavailable：调用确实到达执行器并以
        # 失败收场，而不是在更早的策略层被拦截或静默返回 None。
        assert result["ok"] is False
        assert "测试桩到此为止" in result["error"]


@pytest.mark.asyncio
async def test_shell_direct_runtime_switch_does_not_authorize_run_script(monkeypatch):
    """开关只放宽执行器解释器限制，不等价于 run_script 授权：
    定时任务遇到需确认命令的拦截仍按 script_authorized 判定，不能被绕过。"""
    from agent.tools import shell as shell_tool

    captured = []
    _patch_run_shell_harness(monkeypatch, _direct_runtime_settings(direct=True), captured)

    async def _needs_confirm(*_a, **_k):
        return SimpleNamespace(
            allowed=True, reason="危险命令需要用户确认",
            risk=ShellRisk.DANGEROUS, needs_confirmation=True,
            workspace_id=7, scope=ShellScope.SANDBOX,
            autopilot_enabled=False, full_user_sandbox_write=False,
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
async def test_direct_runtime_switch_still_requires_code_execution_enabled(monkeypatch):
    """优先级：code_execution_enabled=False 时总开关语义不变，
    直跑便捷开关不能把运行时命令救回来。"""
    db = _PolicyDB()
    settings = _direct_runtime_settings(direct=True, code_execution=False)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(shell_policy, "sandbox_readiness", lambda *_a: (True, ""))

    decision = await shell_policy.evaluate(db, "user-1", 1, "python3 script.py")

    assert not decision.allowed
    assert decision.reason == "管理员未开启代码运行环境，禁止使用 python3 运行时"


@pytest.mark.asyncio
async def test_dynamic_prompt_announces_direct_runtime_when_enabled(monkeypatch):
    """开关开启时动态提示告知模型可直跑；关闭时不得出现，避免误导。"""
    db = _PolicyDB()
    settings = _direct_runtime_settings(direct=True)
    monkeypatch.setattr(shell_policy, "get_settings", lambda: settings)
    monkeypatch.setattr(shell_policy, "effective_shell_enabled", lambda *_: _true())
    monkeypatch.setattr(
        shell_policy, "effective_shell_dangerous_enabled", lambda *_: _false())
    monkeypatch.setattr(shell_policy, "sandbox_readiness", lambda *_a: (True, ""))

    enabled_prompt = await shell_policy.build_dynamic_prompt(db, "user-1", 1, session=db.session)
    assert enabled_prompt is not None
    assert "代码运行时：沙盒内可直接执行" in enabled_prompt

    settings.sandbox.shell_direct_runtime_enabled = False
    disabled_prompt = await shell_policy.build_dynamic_prompt(db, "user-1", 1, session=db.session)
    assert disabled_prompt is not None
    assert "代码运行时：沙盒内可直接执行" not in disabled_prompt
