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
    (project / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
    state_dir = tmp_path / "updater-state"
    state_dir.mkdir()
    monkeypatch.setenv("GUGU_UPDATER_COMPOSE_DIR", str(project))
    monkeypatch.setenv("GUGU_UPDATER_STATE_DIR", str(state_dir))
    monkeypatch.setenv("GUGU_UPDATER_CODE_DIR", str(tmp_path / "updater-code"))
    monkeypatch.setenv("GUGU_SELF_UPDATE", self_update)
    if state is not None:
        (state_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    return UpdateDaemon(), state_dir


@pytest.mark.asyncio
async def test_initial_state_status_handles_null_task(tmp_path, monkeypatch):
    daemon, _ = make_daemon(tmp_path, monkeypatch)

    status = await daemon.dispatch({"method": "status", "params": {}})

    assert status["enabled"] is True
    assert status["task"] is None
    assert status["candidate"] is None
    assert status["has_update"] is False


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
            "app": {}, "postgres": {}, "redis": {}, "data-migrate": {},
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
