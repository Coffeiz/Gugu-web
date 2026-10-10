from __future__ import annotations

import pytest

from updater.standalone import DockerEngine, StandaloneConfigError, snapshot_standalone_container, write_sensitive_json


def valid_inspect():
    return {
        "Id": "container-id",
        "Name": "/gugu-app",
        "Config": {
            "Image": "coffeiz/gugu-web:v1.3.2",
            "Env": ["GUGU_UNIFIED_APP=1", "GUGU_EMBEDDED_DEPS=1", "SECRET_KEY=synthetic-secret"],
            "Cmd": ["nginx", "-g", "daemon off;"],
            "Labels": {},
            "ExposedPorts": {"9595/tcp": {}},
            "WorkingDir": "/app",
        },
        "HostConfig": {
            "Binds": ["/srv/gugu-data:/data"],
            "PortBindings": {"9595/tcp": [{"HostIp": "0.0.0.0", "HostPort": "9595"}]},
            "RestartPolicy": {"Name": "unless-stopped"},
        },
        "Mounts": [{
            "Type": "bind", "Source": "/srv/gugu-data", "Destination": "/data", "RW": True,
        }],
        "NetworkSettings": {"Networks": {}},
    }


def test_snapshot_preserves_exact_config_without_exposing_secret_in_errors():
    snapshot = snapshot_standalone_container(valid_inspect())

    assert snapshot["container_name"] == "gugu-app"
    assert snapshot["config"]["Env"]["SECRET_KEY"] == "synthetic-secret"
    assert snapshot["host_config"]["PortBindings"]["9595/tcp"][0]["HostPort"] == "9595"


@pytest.mark.parametrize("mutate, expected", [
    (lambda item: item["Config"].update(Image="attacker/example:latest"), "官方咕咕一体化镜像"),
    (lambda item: item["Config"]["Env"].remove("GUGU_EMBEDDED_DEPS=1"), "内嵌依赖模式"),
    (lambda item: item["Mounts"].clear(), "可写的 /data"),
    (lambda item: item["Mounts"][0].update(RW=False), "可写的 /data"),
    (lambda item: item["Mounts"][0].update(Type="volume", Name="a" * 64), "匿名卷"),
    (lambda item: item["HostConfig"].update(Privileged=True), "特权容器"),
])
def test_snapshot_fails_closed_before_container_replacement(mutate, expected):
    inspect = valid_inspect()
    mutate(inspect)

    with pytest.raises(StandaloneConfigError, match=expected):
        snapshot_standalone_container(inspect)


def test_snapshot_rejects_repeated_or_malformed_environment_keys():
    inspect = valid_inspect()
    inspect["Config"]["Env"].append("SECRET_KEY=duplicate")

    with pytest.raises(StandaloneConfigError, match="重复"):
        snapshot_standalone_container(inspect)


class FakeDockerEngine(DockerEngine):
    def __init__(self, *, healthy=True, fail_rename=False):
        super().__init__("/unused")
        self.health_poll_interval = 0
        self.healthy = healthy
        self.fail_rename = fail_rename
        self.calls = []
        self.new_created = False

    def pull_image(self, image):
        self.calls.append(("pull", image))

    def expect(self, method, path, payload=None, *, statuses=(200, 201, 204)):
        self.calls.append((method, path, payload))
        if self.fail_rename and "/rename?name=" in path and "previous" in path:
            raise RuntimeError("mock rename failed")
        if path.startswith("/containers/create?"):
            self.new_created = True
            assert payload["Image"].endswith("a" * 64)
            assert "/data" in str(payload["HostConfig"])
            return b'{"Id":"new-container"}'
        return b"{}"

    def request(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        return 204, b""

    def inspect_container(self, container):
        return {"State": {"Running": True, "Status": "running"}}

    def maybe_inspect_container(self, container):
        if container == "container-id":
            return {"Id": "container-id", "Config": {"Image": "coffeiz/gugu-web:v1.3.2"}, "State": {"Running": True}}
        return None

    def _exec_healthcheck(self, container_id):
        return self.healthy


def test_replace_container_keeps_snapshot_mounts_and_removes_previous_only_after_health():
    snapshot = snapshot_standalone_container(valid_inspect())
    engine = FakeDockerEngine()
    image = "docker.io/coffeiz/gugu-web@sha256:" + "a" * 64

    result = engine.replace_container(snapshot, image, "12345678-task")

    assert result == "new-container"
    paths = [call[1] for call in engine.calls if len(call) > 1 and isinstance(call[1], str)]
    assert paths.index("/containers/container-id/stop?t=30") < paths.index("/containers/create?name=gugu-app")
    assert any("DELETE" == call[0] and "previous" in call[1] for call in engine.calls if len(call) > 1)


def test_replace_container_health_failure_restores_old_container_and_keeps_volume():
    snapshot = snapshot_standalone_container(valid_inspect())
    engine = FakeDockerEngine(healthy=False)
    image = "docker.io/coffeiz/gugu-web@sha256:" + "a" * 64

    with pytest.raises(RuntimeError, match="健康检查"):
        engine.replace_container(snapshot, image, "12345678-task")

    paths = [call[1] for call in engine.calls if len(call) > 1 and isinstance(call[1], str)]
    assert any("?name=gugu-app" in path and "/rename?name=" in path for path in paths)
    assert ("POST", "/containers/container-id/start", None) in engine.calls
    assert not any("?force=true&v=true" in path for path in paths)


def test_sensitive_snapshot_is_written_atomically_with_private_permissions(tmp_path):
    path = tmp_path / "handoff" / "snapshot.json"
    write_sensitive_json(path, {"secret": "do-not-log"})

    assert path.stat().st_mode & 0o777 == 0o600
    assert not path.with_suffix(".json.tmp").exists()
