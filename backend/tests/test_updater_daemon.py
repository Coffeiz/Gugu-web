from __future__ import annotations

import asyncio
import hashlib
import re
import json
import secrets
from types import SimpleNamespace

import pytest

from updater.daemon import UpdateDaemon
from updater.database_check import validate_revision_state


def make_daemon(tmp_path, monkeypatch, state=None, *, self_update="on"):
    project = tmp_path / "deployment"
    project.mkdir()
    (project / "docker-compose.yml").write_text("services: {app: {}, postgres: {}, redis: {}}\n", encoding="utf-8")
    socket_path = project / "docker.sock"
    socket_path.touch()
    state_dir = tmp_path / "updater-state"
    state_dir.mkdir()
    monkeypatch.setenv("GUGU_UPDATER_COMPOSE_DIR", str(project))
    monkeypatch.setenv("GUGU_UPDATER_STATE_DIR", str(state_dir))
    monkeypatch.setenv("GUGU_UPDATER_CODE_DIR", str(tmp_path / "updater-code"))
    monkeypatch.setenv("GUGU_SELF_UPDATE", self_update)
    monkeypatch.setenv("GUGU_DOCKER_SOCKET", str(socket_path))
    monkeypatch.setenv("GUGU_UNIFIED_APP", "1")
    monkeypatch.setenv("GUGU_EMBEDDED_DEPS", "0")
    if state is not None:
        (state_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    return UpdateDaemon(), state_dir


@pytest.mark.asyncio
async def test_initial_state_status_handles_null_task(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)
    async def compose(_args):
        return {"services": {"app": {}, "postgres": {}, "redis": {}}}
    monkeypatch.setattr(daemon, "_compose", compose)

    status = await daemon.dispatch({"method": "status", "params": {}})

    assert status["enabled"] is True
    assert status["task"] is None
    assert status["candidate"] is None
    assert status["has_update"] is False


@pytest.mark.asyncio
async def test_status_disables_updates_when_compose_interpolation_is_invalid(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)

    async def invalid_compose(_args):
        raise RuntimeError("compose config failed")

    monkeypatch.setattr(daemon, "_compose", invalid_compose)
    status = await daemon.dispatch({"method": "status", "params": {}})

    assert status["mode"] == "integrated_compose"
    assert status["enabled"] is False
    assert status["reason_code"] == "compose_invalid"


def test_restart_converts_interrupted_task_to_recoverable_state(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch, {
        "schema": 1,
        "candidate": None,
        "task": {"id": "test-task", "status": "pulling", "previous_image": "docker.io/coffeiz/gugu-web@sha256:" + "a" * 64},
        "history": [],
        "challenges": [],
    })

    assert daemon.state["task"]["status"] == "rollback_required"
    assert daemon.state["task"]["failure_code"] == "updater_restarted"
    persisted = json.loads((daemon.state_dir / "state.json").read_text(encoding="utf-8"))
    assert persisted["task"]["status"] == "rollback_required"
    assert persisted["history"][0]["failure_code"] == "updater_restarted"


def test_recreating_pending_restart_is_resumed_not_marked_failed(tmp_path, monkeypatch):
    """helper 已接管重建时，旧 app 退出不应把预期重启误判为 updater 崩溃。"""
    daemon, _ = make_daemon(tmp_path, monkeypatch, {
        "schema": 1,
        "candidate": None,
        "task": {
            "id": "handoff-task", "status": "recreating_pending_restart",
            "stage": "recreating_pending_restart", "previous_image": "docker.io/coffeiz/gugu-web@sha256:" + "a" * 64,
        },
        "history": [],
        "challenges": [],
    })

    assert daemon._resume_after_restart is True
    assert daemon.state["task"]["status"] == "health_checking"
    assert daemon.state["task"].get("failure_code") is None


@pytest.mark.asyncio
async def test_manifest_v2_is_rejected_without_compatibility_fallback(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)
    manifest = {
        "schema_version": 2,
        "version": "v1.2.3",
        "channel": "stable",
    }

    with pytest.raises(ValueError, match="仅接受 v3"):
        await daemon._verify_assets(json.dumps(manifest).encode())


@pytest.mark.asyncio
async def test_preflight_rejects_unknown_current_version(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)
    (daemon.project_dir / "backend").mkdir()
    (daemon.project_dir / "backend" / ".env").write_text("ADMIN_PASSWORD=test-only-value\n", encoding="utf-8")
    daemon.state["current"] = {"version": "unknown"}
    monkeypatch.setattr("updater.daemon.shutil.disk_usage", lambda _path: SimpleNamespace(free=5 * 1024**3))

    async def command(_args, *, timeout, env=None):
        return b"x86_64"

    async def compose(_args):
        return {"services": {
            "app": {}, "postgres": {}, "redis": {},
            "updater": {"image": "docker.io/coffeiz/gugu-web:latest"},
        }}

    async def compose_text(args, *, env=None, timeout=30):
        if args[:2] == ["ps", "-q"] and args[-1] == "app":
            return "app-container\n"
        if args[:4] == ["ps", "--status", "running", "--services"]:
            return "app\nupdater\n"
        return "ok"

    async def docker_json(args, *, timeout=30):
        if args[:1] == ["inspect"]:
            return [{"Mounts": [
                {"Destination": "/data", "RW": True},
                {"Destination": "/config", "RW": True},
            ]}]
        return []

    monkeypatch.setattr(daemon, "_command", command)
    monkeypatch.setattr(daemon, "_compose", compose)
    monkeypatch.setattr(daemon, "_compose_text", compose_text)
    monkeypatch.setattr(daemon, "_docker_json", docker_json)

    async def signature_ok(_image):
        return {"ok": True, "skipped": False, "detail": "发布签名校验通过"}

    monkeypatch.setattr(daemon, "_verify_signature", signature_ok)

    socket_path = daemon.project_dir / "docker.sock"
    socket_path.write_bytes(b"")
    monkeypatch.setenv("GUGU_DOCKER_SOCKET", str(socket_path))
    checks = await daemon._preflight_checks({
        "version": "v1.2.2",
        "minimum_version": "v1.2.1",
        "architectures": ["linux/amd64"],
    })

    by_key = {item["key"]: item for item in checks}
    assert by_key["current_version"]["ok"] is False
    assert by_key["minimum_version"]["ok"] is False
    assert by_key["updater"]["ok"] is True
    assert by_key["storage"]["ok"] is True
    assert by_key["database_migrations"]["ok"] is True

    # socket 未挂载（路径不存在）→ 自更新不可用
    socket_path.unlink()
    checks = await daemon._preflight_checks({
        "version": "v1.2.2",
        "minimum_version": "v1.2.1",
        "architectures": ["linux/amd64"],
    })
    assert next(item for item in checks if item["key"] == "updater")["ok"] is False


@pytest.mark.asyncio
async def test_shared_release_preflight_checks_common_limits_and_all_images(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)
    daemon.state["current"] = {"version": "v1.2.3"}
    monkeypatch.setattr(
        "updater.daemon.shutil.disk_usage",
        lambda _path: SimpleNamespace(free=4 * 1024**3 + 17),
    )
    verified_images = []

    async def verify_signature(image):
        verified_images.append(image)
        return {"ok": image != "bad-image"}

    monkeypatch.setattr(daemon, "_verify_signature", verify_signature)

    result = await daemon._shared_release_preflight(
        {"architectures": ["linux/amd64"], "minimum_version": "v1.2.2"},
        "linux/amd64",
        tmp_path,
        ["backend-image", "frontend-image"],
    )

    assert result == {
        "disk_ok": True,
        "disk_free_gib": 4,
        "architecture_ok": True,
        "signatures_ok": True,
        "current_version_known": True,
        "minimum_version_ok": True,
    }
    assert verified_images == ["backend-image", "frontend-image"]

    daemon.state["current"] = {"version": "unknown"}
    monkeypatch.setattr(
        "updater.daemon.shutil.disk_usage",
        lambda _path: SimpleNamespace(free=1024**3),
    )
    result = await daemon._shared_release_preflight(
        {"architectures": [], "minimum_version": "not-a-version"},
        "linux/arm64",
        tmp_path,
        ["bad-image"],
    )
    assert result == {
        "disk_ok": False,
        "disk_free_gib": 1,
        "architecture_ok": False,
        "signatures_ok": False,
        "current_version_known": False,
        "minimum_version_ok": False,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("architecture", "expected"),
    [(b"x86_64", "linux/amd64"), (b"aarch64", "linux/arm64"), (b"mips", "")],
)
async def test_docker_host_platform_normalizes_supported_architectures(
    tmp_path, monkeypatch, architecture, expected,
):
    daemon, _ = make_daemon(tmp_path, monkeypatch)

    async def command(args, *, timeout, env=None):
        assert args == ["docker", "info", "--format", "{{.Architecture}}"]
        assert timeout == 12
        return architecture

    monkeypatch.setattr(daemon, "_command", command)

    assert await daemon._docker_host_platform() == expected


def test_database_revision_requires_exactly_one_current_head():
    validate_revision_state(["head-a"], ["head-a"])
    with pytest.raises(RuntimeError, match="唯一 head"):
        validate_revision_state(["old-revision"], ["head-a"])
    with pytest.raises(RuntimeError, match="唯一 head"):
        validate_revision_state(["head-a", "head-b"], ["head-a", "head-b"])


def test_update_challenge_is_bound_and_consumed_once(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)
    token = secrets.token_urlsafe(48)
    digest = "b" * 64
    daemon.state["challenges"] = [{
        "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
        "operator": "admin-test",
        "action": "update",
        "version": "v1.2.2",
        "manifest_sha256": digest,
        "expires_at": 4_000_000_000,
    }]
    daemon._save()

    daemon._consume_challenge(token, "admin-test", "update", "v1.2.2", digest)

    assert daemon.state["challenges"] == []
    with pytest.raises(ValueError, match="确认已过期"):
        daemon._consume_challenge(token, "admin-test", "update", "v1.2.2", digest)


def test_challenge_cannot_be_replayed_by_another_operator(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)
    token = secrets.token_urlsafe(48)
    digest = "c" * 64
    daemon.state["challenges"] = [{
        "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
        "operator": "admin-test",
        "action": "update",
        "version": "v1.2.2",
        "manifest_sha256": digest,
        "expires_at": 4_000_000_000,
    }]

    with pytest.raises(ValueError, match="不匹配"):
        daemon._consume_challenge(token, "different-admin", "update", "v1.2.2", digest)

    assert daemon.state["challenges"] == []


def _seed_failed_update_task(previous_image: str, new_image: str) -> dict:
    """模拟健康检查失败后的更新任务：回滚目标=previous_image，失败态=rollback_required。"""
    return {
        "schema": 1, "candidate": None, "history": [], "challenges": [],
        "task": {
            "id": "update-1", "operation": "update", "version": "v1.2.2",
            "manifest_sha256": "d" * 64, "app_image": new_image,
            "status": "rollback_required", "stage": "health_checking", "progress": 90,
            "message": "新版本未通过健康检查", "failure_code": "health_check_failed",
            "requested_by": "admin-test",
            "created_at": "2026-09-14T00:00:00+00:00", "updated_at": "2026-09-14T00:00:00+00:00",
            "previous_image": previous_image, "previous_version": "v1.2.1",
            "previous_sandboxd_image": previous_image,
            "sandboxd_was_running": True, "sandboxd_updated": True,
            "rollback_supported": True, "events": [],
        },
    }


def _install_rollback_fakes(daemon, monkeypatch, compose_text, current_release, healthy, *, compose_config=None):
    async def docker_json(_args, *, timeout=30):
        return [{}]

    async def command(_args, *, timeout, env=None):
        return b""

    async def compose(_args):
        return compose_config if compose_config is not None else {"services": {"app": {}, "sandboxd": {}}}

    monkeypatch.setattr(daemon, "_compose_text", compose_text)
    monkeypatch.setattr(daemon, "_compose", compose)
    monkeypatch.setattr(daemon, "_current_release", current_release)
    monkeypatch.setattr(daemon, "_docker_json", docker_json)
    monkeypatch.setattr(daemon, "_command", command)
    monkeypatch.setattr(daemon, "_wait_app_healthy", healthy)
    # 跳过回滚任务开头的 3s 防抖与轮询间隔，测试内即时完成。
    real_sleep = asyncio.sleep
    monkeypatch.setattr("updater.daemon.asyncio.sleep", lambda _d: real_sleep(0))


def _trace_rollback(monkeypatch, daemon):
    """包一层 _run_rollback 以便在测试中等待后台任务真正结束。"""
    done = asyncio.Event()
    original_run = daemon._run_rollback

    async def traced(task_id, target_image):
        await original_run(task_id, target_image)
        done.set()

    monkeypatch.setattr(daemon, "_run_rollback", traced)
    return done


@pytest.mark.asyncio
async def test_rollback_success_restores_app_and_sandboxd(tmp_path, monkeypatch):
    """回滚成功路径：app+sandboxd 一起恢复，记录的是被恢复版本而非 previous_version。"""
    old_image = "docker.io/coffeiz/gugu-web@sha256:" + "a" * 64
    new_image = "docker.io/coffeiz/gugu-web@sha256:" + "b" * 64
    daemon, _ = make_daemon(tmp_path, monkeypatch, state=_seed_failed_update_task(old_image, new_image))

    rolled_back = {"done": False}

    async def current_release():
        if rolled_back["done"]:
            return {"version": "v1.2.1", "image": old_image}
        return {"version": "v1.2.2", "image": new_image}

    async def healthy():
        rolled_back["done"] = True
        return True

    compose_calls: list[tuple[list, dict | None]] = []

    async def compose_text(args, *, env=None, timeout=30):
        compose_calls.append((list(args), dict(env) if env else None))
        return "ok"

    _install_rollback_fakes(daemon, monkeypatch, compose_text, current_release, healthy)
    done = _trace_rollback(monkeypatch, daemon)

    preflight = await daemon._rollback_preflight({"operator": "admin-test"})
    assert preflight["ready"] is True
    result = await daemon._rollback({"challenge": preflight["challenge"], "operator": "admin-test"})
    assert result["accepted"] is True
    await asyncio.wait_for(done.wait(), timeout=5)

    task = daemon.state["task"]
    assert task["status"] == "succeeded"
    assert task["operation"] == "rollback"
    assert task["version"] == "v1.2.1"
    stopped = [args[-1] for args, _env in compose_calls if args[:1] == ["stop"]]
    assert stopped == ["app", "sandboxd"]
    up_args, up_env = next((args, env) for args, env in compose_calls if args[:1] == ["up"])
    assert up_args == ["up", "-d", "--no-deps", "--force-recreate", "app", "sandboxd"]
    assert up_env["GUGU_WEB_IMAGE"] == old_image
    # 成功后记录的是被恢复的版本（回滚任务的 version 字段），不是 previous_version。
    assert daemon.state["current"] == {"version": "v1.2.1", "image": old_image}


@pytest.mark.asyncio
async def test_rollback_allows_missing_app_container(tmp_path, monkeypatch):
    """app 容器被整体删除（比停止更极端的中断态）也能回滚：Compose app 服务定义 + 本机旧镜像即可从零重建。"""
    old_image = "docker.io/coffeiz/gugu-web@sha256:" + "a" * 64
    new_image = "docker.io/coffeiz/gugu-web@sha256:" + "b" * 64
    daemon, _ = make_daemon(tmp_path, monkeypatch, state=_seed_failed_update_task(old_image, new_image))

    async def current_release():
        raise RuntimeError("当前一体化 app 容器未运行")

    async def healthy():
        return True

    compose_calls: list[tuple[list, dict | None]] = []

    async def compose_text(args, *, env=None, timeout=30):
        compose_calls.append((list(args), dict(env) if env else None))
        return "ok"

    _install_rollback_fakes(daemon, monkeypatch, compose_text, current_release, healthy, compose_config={
        "services": {"app": {"image": old_image}, "sandboxd": {"image": old_image}},
    })
    done = _trace_rollback(monkeypatch, daemon)

    preflight = await daemon._rollback_preflight({"operator": "admin-test"})
    assert preflight["ready"] is True
    assert preflight["target_version"] == "v1.2.1"
    result = await daemon._rollback({"challenge": preflight["challenge"], "operator": "admin-test"})
    assert result["accepted"] is True
    # 回滚任务的 previous_* 记录失败任务中的当前（新）版本信息。
    assert result["task"]["version"] == "v1.2.1"
    assert result["task"]["previous_version"] == "v1.2.2"
    await asyncio.wait_for(done.wait(), timeout=5)

    assert daemon.state["task"]["status"] == "succeeded"
    up_args, up_env = next((args, env) for args, env in compose_calls if args[:1] == ["up"])
    assert up_args == ["up", "-d", "--no-deps", "--force-recreate", "app", "sandboxd"]
    assert up_env["GUGU_WEB_IMAGE"] == old_image
    assert daemon.state["current"] == {"version": "v1.2.1", "image": old_image}


@pytest.mark.asyncio
async def test_rollback_preflight_rejects_without_app_service_definition(tmp_path, monkeypatch):
    """反向契约：Compose 项目里 app 服务定义不在（或解析失败）时，即使旧镜像在本机也判 not ready。"""
    old_image = "docker.io/coffeiz/gugu-web@sha256:" + "a" * 64
    new_image = "docker.io/coffeiz/gugu-web@sha256:" + "b" * 64
    daemon, _ = make_daemon(tmp_path, monkeypatch, state=_seed_failed_update_task(old_image, new_image))

    async def current_release():
        return {"version": "v1.2.2", "image": new_image}

    async def healthy():
        return True

    async def compose_text(args, *, env=None, timeout=30):
        return "ok"

    _install_rollback_fakes(daemon, monkeypatch, compose_text, current_release, healthy, compose_config={
        "services": {"postgres": {}, "redis": {}},  # app 服务定义丢失
    })

    preflight = await daemon._rollback_preflight({"operator": "admin-test"})
    assert preflight["ready"] is False
    assert "challenge" not in preflight


def test_self_update_disabled_blocks_methods(tmp_path, monkeypatch):
    """GUGU_SELF_UPDATE=off：非 status 调用一律降级为未启用；status 返回 enabled=False。"""
    import asyncio
    import updater.client as client_module
    from updater.client import UpdaterClientError, call_updater

    make_daemon(tmp_path, monkeypatch, self_update="off")
    monkeypatch.setattr(client_module, "_executor", None)
    monkeypatch.setattr(client_module, "_executor_failed", False)

    async def scenario():
        with pytest.raises(UpdaterClientError) as exc_info:
            await call_updater("check")
        assert exc_info.value.code == "self_update_disabled"
        status = await call_updater("status")
        assert status["enabled"] is False

    asyncio.run(scenario())


def test_agent_tool_registry_has_no_update_capability():
    """安全让步的边界断言：更新能力只存在于 Admin 路由，Agent 工具注册表不可达。"""
    from agent.tools.base import registry

    tool_names = set(registry._tools)
    assert tool_names, "Agent 工具注册表为空，测试前提不成立"
    # 域内 CRUD 的 update_*（改项目/事件等）不算部署自更新；命中即说明更新面泄漏进模型能力。
    pattern = re.compile(r"(self_)?update_(docker|system|deployment|version|image)|^(docker|updater|deploy)($|_)", re.IGNORECASE)
    offenders = sorted(name for name in tool_names if pattern.search(name))
    assert offenders == [], f"Agent 工具注册表不得出现部署自更新能力：{offenders}"


# ── 发布签名校验（供应链真实性）───────────────────────────────────────────────

from updater.daemon import (
    COSIGN_IDENTITY_REGEXP,
    COSIGN_OIDC_ISSUER,
    COSIGN_VERIFIER_IMAGE,
    signature_verification_enabled,
)


def test_cosign_verifier_image_is_digest_pinned():
    """verifier 必须按 digest 引用，防止 latest 漂移绕过固定校验器。"""
    assert re.fullmatch(r"ghcr\.io/sigstore/cosign/cosign@sha256:[0-9a-f]{64}", COSIGN_VERIFIER_IMAGE)


def test_cosign_command_pins_identity_issuer_and_referrers_mode(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)
    image = "docker.io/coffeiz/gugu-web@sha256:" + "a" * 64
    argv = daemon._cosign_command(image, tmp_path / "cache")

    assert argv[:3] == ["docker", "run", "--rm"]
    # v3.1.3 的 verify 无 referrers 模式开关（自动探测），不得传入会被拒绝的 flag
    assert "--registry-referrers-mode" not in argv
    assert COSIGN_VERIFIER_IMAGE in argv
    assert argv[argv.index("verify") - 1] == COSIGN_VERIFIER_IMAGE
    assert argv[argv.index("--certificate-identity-regexp") + 1] == COSIGN_IDENTITY_REGEXP
    assert argv[argv.index("--certificate-oidc-issuer") + 1] == COSIGN_OIDC_ISSUER
    assert argv[-1] == image
    # identity 只认 tag 触发的官方发布工作流
    assert "docker-release" in COSIGN_IDENTITY_REGEXP and "refs/tags" in COSIGN_IDENTITY_REGEXP
    # sigstore trusted root 缓存落在 updater state 目录（持久卷）内
    assert any("/root/.sigstore" in part for part in argv)


@pytest.mark.asyncio
async def test_verify_signature_fail_closed_paths(tmp_path, monkeypatch):
    """无签名/身份不符/超时/启动失败一律 ok=False，只有 rc=0 放行。"""
    daemon, _ = make_daemon(tmp_path, monkeypatch)

    async def run(rc, stderr):
        return rc, stderr

    cases = [
        (0, "", True),
        (1, "error: no signatures found", False),
        (1, "none of the expected identities were matched", False),
        (None, "timeout", False),
    ]
    for rc, stderr, expected_ok in cases:
        async def fake_run(_command, _rc=rc, _stderr=stderr):
            return _rc, _stderr

        monkeypatch.setattr(daemon, "_cosign_run", fake_run)
        result = await daemon._verify_signature("docker.io/coffeiz/gugu-web@sha256:" + "b" * 64)
        assert result["ok"] is expected_ok, (rc, stderr, result)
        assert result["skipped"] is False

    async def broken_run(_command):
        raise FileNotFoundError("docker missing")

    monkeypatch.setattr(daemon, "_cosign_run", broken_run)
    result = await daemon._verify_signature("docker.io/coffeiz/gugu-web@sha256:" + "b" * 64)
    assert result["ok"] is False


@pytest.mark.asyncio
async def test_signature_skip_is_break_glass_only(tmp_path, monkeypatch):
    """skip 开关打开时验签放行但标记 skipped，且不启动 verifier。"""
    monkeypatch.setenv("GUGU_UPDATER_SKIP_COSIGN", "on")
    daemon, _ = make_daemon(tmp_path, monkeypatch)

    async def must_not_run(_command):
        raise AssertionError("skip 模式下不得启动 verifier")

    monkeypatch.setattr(daemon, "_cosign_run", must_not_run)
    result = await daemon._verify_signature("docker.io/coffeiz/gugu-web@sha256:" + "c" * 64)
    assert result == {"ok": True, "skipped": True, "detail": result["detail"]}
    assert "禁用" in result["detail"]
    assert signature_verification_enabled() is False

    monkeypatch.delenv("GUGU_UPDATER_SKIP_COSIGN")
    assert signature_verification_enabled() is True


@pytest.mark.asyncio
async def test_failing_signature_blocks_update_start(tmp_path, monkeypatch):
    """fail-closed 端到端：验签失败 → preflight 不 ready → 不产生 challenge/token。"""
    daemon, _ = make_daemon(tmp_path, monkeypatch)
    (daemon.project_dir / "backend").mkdir()
    (daemon.project_dir / "backend" / ".env").write_text("ADMIN_PASSWORD=test-only-value\n", encoding="utf-8")
    daemon.state["current"] = {"version": "v1.2.2", "image": "docker.io/coffeiz/gugu-web@sha256:" + "a" * 64}
    daemon.state["candidate"] = {
        "version": "v1.2.3", "channel": "stable", "minimum_version": "v1.2.2",
        "app_image": "docker.io/coffeiz/gugu-web@sha256:" + "d" * 64,
        "manifest_sha256": "e" * 64, "architectures": ["linux/amd64"],
    }

    async def command(_args, *, timeout, env=None):
        return b"x86_64"

    async def compose(_args):
        return {"services": {"app": {}, "postgres": {}, "redis": {}}}

    async def compose_text(args, *, env=None, timeout=30):
        if args[:2] == ["ps", "-q"] and args[-1] == "app":
            return "app-container\n"
        return "ok"

    async def docker_json(args, *, timeout=30):
        if args[:1] == ["inspect"]:
            return [{"Mounts": [{"Destination": "/data", "RW": True}, {"Destination": "/config", "RW": True}]}]
        return []

    monkeypatch.setattr(daemon, "_command", command)
    monkeypatch.setattr(daemon, "_compose", compose)
    monkeypatch.setattr(daemon, "_compose_text", compose_text)
    monkeypatch.setattr(daemon, "_docker_json", docker_json)
    monkeypatch.setattr("updater.daemon.shutil.disk_usage", lambda _path: SimpleNamespace(free=5 * 1024**3))

    async def signature_fail(_image):
        return {"ok": False, "skipped": False, "detail": "目标镜像没有发布签名，已阻断更新"}

    monkeypatch.setattr(daemon, "_verify_signature", signature_fail)
    socket_path = daemon.project_dir / "docker.sock"
    socket_path.write_bytes(b"")
    monkeypatch.setenv("GUGU_DOCKER_SOCKET", str(socket_path))

    result = await daemon._preflight({"operator": "admin-test"})
    assert result["ready"] is False
    by_key = {item["key"]: item for item in result["checks"]}
    assert by_key["signature"]["ok"] is False
    assert by_key["integrity"]["ok"] is True
    assert "challenge" not in result
