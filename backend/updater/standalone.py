"""纯 Docker 单容器更新的配置快照校验原语。

快照含容器环境变量（可能含凭据），调用方必须写入权限为 0600 的状态目录，
且不得把快照内容写入日志、API 响应或审计描述。
"""

from __future__ import annotations

import http.client
import json
import os
import re
import socket
import time
import urllib.parse
from typing import Any
from pathlib import Path


OFFICIAL_IMAGE = re.compile(
    r"^(?:(?:docker\.io|index\.docker\.io)/)?coffeiz/gugu-web(?::[A-Za-z0-9_.-]{1,128}|@sha256:[0-9a-f]{64})$"
    r"|^ghcr\.io/coffeiz/gugu-web(?::[A-Za-z0-9_.-]{1,128}|@sha256:[0-9a-f]{64})$"
)
ANONYMOUS_VOLUME = re.compile(r"^[0-9a-f]{64}$")
SUPPORTED_CONFIG_FIELDS = {
    "Hostname", "Domainname", "User", "AttachStdin", "AttachStdout", "AttachStderr",
    "ExposedPorts", "Tty", "OpenStdin", "StdinOnce", "Env", "Cmd", "Image",
    "Volumes", "WorkingDir", "Entrypoint", "NetworkDisabled", "MacAddress",
    "OnBuild", "Labels", "StopSignal", "StopTimeout", "Healthcheck",
}
SUPPORTED_HOST_CONFIG_FIELDS = {
    "Binds", "ContainerIDFile", "LogConfig", "NetworkMode", "PortBindings", "RestartPolicy",
    "AutoRemove", "VolumeDriver", "VolumesFrom", "ConsoleSize", "CapAdd", "CapDrop",
    "CgroupnsMode", "Dns", "DnsOptions", "DnsSearch", "ExtraHosts", "GroupAdd", "IpcMode",
    "Cgroup", "Links", "OomScoreAdj", "PidMode", "Privileged", "PublishAllPorts", "ReadonlyRootfs",
    "SecurityOpt", "StorageOpt", "Tmpfs", "UTSMode", "UsernsMode", "ShmSize", "Runtime",
    "Isolation", "CpuShares", "Memory", "NanoCpus", "CgroupParent", "BlkioWeight",
    "BlkioWeightDevice", "BlkioDeviceReadBps", "BlkioDeviceWriteBps", "BlkioDeviceReadIOps",
    "BlkioDeviceWriteIOps", "CpuPeriod", "CpuQuota", "CpuRealtimePeriod", "CpuRealtimeRuntime",
    "CpusetCpus", "CpusetMems", "Devices", "DeviceCgroupRules", "DeviceRequests", "KernelMemory",
    "KernelMemoryTCP", "MemoryReservation", "MemorySwap", "MemorySwappiness", "OomKillDisable",
    "PidsLimit", "Ulimits", "CpuCount", "CpuPercent", "IOMaximumIOps", "IOMaximumBandwidth",
    "Mounts", "MaskedPaths", "ReadonlyPaths", "Init",
}


class StandaloneConfigError(ValueError):
    """容器配置超出当前安全重建支持范围。"""


class DockerApiError(RuntimeError):
    """Docker Engine API 失败，不携带请求体或环境变量。"""


class DockerReplaceRecovered(DockerApiError):
    """目标容器失败，但旧容器已成功恢复。"""


def _env_map(entries: Any) -> dict[str, str]:
    if not isinstance(entries, list):
        raise StandaloneConfigError("容器环境变量格式无效")
    result: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, str) or "=" not in entry:
            raise StandaloneConfigError("容器环境变量格式无效")
        key, value = entry.split("=", 1)
        if not key or key in result:
            raise StandaloneConfigError("容器环境变量存在重复或空键")
        result[key] = value
    return result


def snapshot_standalone_container(inspect: dict[str, Any]) -> dict[str, Any]:
    """校验官方 standalone app，并返回精确重建所需的敏感快照数据。"""
    if not isinstance(inspect, dict):
        raise StandaloneConfigError("容器信息格式无效")
    config = inspect.get("Config")
    host_config = inspect.get("HostConfig")
    if not isinstance(config, dict) or not isinstance(host_config, dict):
        raise StandaloneConfigError("容器启动配置缺失")
    image = str(config.get("Image") or "")
    if not OFFICIAL_IMAGE.fullmatch(image):
        raise StandaloneConfigError("当前容器不是受支持的官方咕咕一体化镜像")
    unknown_config = set(config) - SUPPORTED_CONFIG_FIELDS
    unknown_host = set(host_config) - SUPPORTED_HOST_CONFIG_FIELDS
    if unknown_config or unknown_host:
        raise StandaloneConfigError("容器使用了当前更新器不支持的 Docker 配置")
    if host_config.get("Privileged") is True or host_config.get("AutoRemove") is True:
        raise StandaloneConfigError("特权容器或自动删除容器不支持安全 handoff")
    if str(host_config.get("NetworkMode") or "") == "host":
        raise StandaloneConfigError("host 网络模式不支持自动重建")

    env = _env_map(config.get("Env"))
    if env.get("GUGU_UNIFIED_APP") != "1" or env.get("GUGU_EMBEDDED_DEPS") != "1":
        raise StandaloneConfigError("当前容器未启用受支持的 standalone 内嵌依赖模式")

    mounts = inspect.get("Mounts")
    if not isinstance(mounts, list):
        raise StandaloneConfigError("无法确认容器数据挂载")
    data_mounts: list[dict[str, Any]] = []
    for mount in mounts:
        if not isinstance(mount, dict):
            raise StandaloneConfigError("容器挂载配置无效")
        destination = str(mount.get("Destination") or "")
        mount_type = mount.get("Type")
        name = str(mount.get("Name") or "")
        if mount_type == "volume" and ANONYMOUS_VOLUME.fullmatch(name):
            raise StandaloneConfigError("检测到匿名卷；请先迁移为具名卷或绑定目录")
        if destination == "/data":
            data_mounts.append(mount)
    if len(data_mounts) != 1 or data_mounts[0].get("RW") is not True:
        raise StandaloneConfigError("必须且只能挂载一个可写的 /data 持久目录")
    if data_mounts[0].get("Type") not in {"bind", "volume"}:
        raise StandaloneConfigError("/data 挂载类型不受支持")

    name = str(inspect.get("Name") or "").lstrip("/")
    if not name or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name):
        raise StandaloneConfigError("容器名称无效，拒绝自动更新")
    container_id = str(inspect.get("Id") or "")
    hostname = str(config.get("Hostname") or "")
    if hostname and (not container_id or not container_id.startswith(hostname)):
        raise StandaloneConfigError("自定义容器主机名暂不支持安全 handoff")
    networking = inspect.get("NetworkSettings")
    networks = networking.get("Networks") if isinstance(networking, dict) else None
    if networks is not None and not isinstance(networks, dict):
        raise StandaloneConfigError("容器网络配置无效")

    return {
        "schema": 1,
        "container_id": container_id,
        "container_name": name,
        "config": {**config, "Env": env},
        "host_config": host_config,
        "mounts": mounts,
        "networks": networks or {},
        "image": image,
    }


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, *, timeout: float = 30):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


class DockerEngine:
    """仅通过 Unix socket 调用 Docker Engine 的最小单容器 adapter。"""

    def __init__(self, socket_path: str = "/var/run/docker.sock"):
        self.socket_path = socket_path
        self.health_poll_interval = 2

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, bytes]:
        # Docker stop waits for its configured grace period before returning (up to 30s here).
        connection = _UnixHTTPConnection(self.socket_path, timeout=90)
        body = json.dumps(payload, separators=(",", ":")).encode() if payload is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise DockerApiError("Docker Engine 响应过大")
            return response.status, data
        except (OSError, http.client.HTTPException) as exc:
            raise DockerApiError("无法连接 Docker Engine") from exc
        finally:
            connection.close()

    def expect(self, method: str, path: str, payload: dict[str, Any] | None = None, *, statuses=(200, 201, 204)) -> bytes:
        status, body = self.request(method, path, payload)
        if status not in statuses:
            raise DockerApiError(f"Docker Engine 操作失败（HTTP {status}）")
        return body

    def inspect_container(self, container: str) -> dict[str, Any]:
        raw = self.expect("GET", f"/containers/{urllib.parse.quote(container, safe='')}/json")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise DockerApiError("Docker 容器状态格式无效")
        return value

    def maybe_inspect_container(self, container: str) -> dict[str, Any] | None:
        status, raw = self.request("GET", f"/containers/{urllib.parse.quote(container, safe='')}/json")
        if status == 404:
            return None
        if status != 200:
            raise DockerApiError(f"Docker 容器查询失败（HTTP {status}）")
        value = json.loads(raw)
        return value if isinstance(value, dict) else None

    def pull_image(self, image: str) -> None:
        if not re.fullmatch(r"(?:docker\.io|ghcr\.io)/coffeiz/gugu-web@sha256:[0-9a-f]{64}", image):
            raise StandaloneConfigError("目标单容器镜像不在 digest 白名单内")
        connection = _UnixHTTPConnection(self.socket_path, timeout=600)
        path = "/images/create?fromImage=" + urllib.parse.quote(image, safe="/:@")
        try:
            connection.request("POST", path)
            response = connection.getresponse()
            if response.status not in (200, 201):
                raise DockerApiError(f"目标镜像拉取失败（HTTP {response.status}）")
            while line := response.readline(1024 * 1024):
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict) and item.get("error"):
                    raise DockerApiError("目标镜像拉取失败")
        except (OSError, http.client.HTTPException) as exc:
            raise DockerApiError("目标镜像拉取中断") from exc
        finally:
            connection.close()

    @staticmethod
    def _create_payload(snapshot: dict[str, Any], image: str) -> dict[str, Any]:
        config = dict(snapshot["config"])
        config["Image"] = image
        config["Env"] = [f"{key}={value}" for key, value in config["Env"].items()]
        host_config = dict(snapshot["host_config"])
        host_config.pop("ContainerIDFile", None)
        endpoints = {}
        for name, endpoint in (snapshot.get("networks") or {}).items():
            if not isinstance(endpoint, dict):
                raise StandaloneConfigError("Docker 网络端点配置无效")
            endpoints[name] = {
                key: endpoint[key]
                for key in ("IPAMConfig", "Links", "Aliases", "DriverOpts")
                if endpoint.get(key) is not None
            }
        return {
            **config,
            "HostConfig": host_config,
            "NetworkingConfig": {"EndpointsConfig": endpoints},
        }

    def _exec_healthcheck(self, container_id: str) -> bool:
        status, raw = self.request("POST", f"/containers/{container_id}/exec", {
            "Cmd": ["curl", "-fsS", "http://127.0.0.1:9595/health"],
            "AttachStdin": False, "AttachStdout": False, "AttachStderr": False,
        })
        if status != 201:
            return False
        try:
            exec_id = str(json.loads(raw)["Id"])
        except (json.JSONDecodeError, KeyError, TypeError):
            return False
        status, _ = self.request("POST", f"/exec/{exec_id}/start", {"Detach": True, "Tty": False})
        if status not in (200, 204):
            return False
        for _ in range(30):
            status, result = self.request("GET", f"/exec/{exec_id}/json")
            if status == 200:
                try:
                    value = json.loads(result)
                    if value.get("Running") is False:
                        return value.get("ExitCode") == 0
                except (json.JSONDecodeError, AttributeError):
                    return False
            time.sleep(1)
        return False

    def replace_container(
        self, snapshot: dict[str, Any], image: str, task_id: str,
        before_replacement: Any = None, *, pull_image: bool = True,
    ) -> str:
        """先拉取镜像，再停旧容器；失败恢复旧容器名与运行状态。"""
        if pull_image:
            self.pull_image(image)
        if before_replacement is not None:
            before_replacement()
        old_id = str(snapshot["container_id"])
        original_name = str(snapshot["container_name"])
        backup_name = f"{original_name}-gugu-previous-{task_id[:8]}"
        stopped = False
        renamed = False
        new_id = ""
        try:
            current = self.maybe_inspect_container(original_name)
            backup = self.maybe_inspect_container(backup_name)
            if current and current.get("Config", {}).get("Image") == image:
                if current.get("State", {}).get("Running") and self._exec_healthcheck(str(current.get("Id") or "")):
                    if backup:
                        self.expect("DELETE", f"/containers/{urllib.parse.quote(backup_name, safe='')}?force=false", statuses=(204,))
                    return str(current.get("Id") or "")
                new_id = str(current.get("Id") or "")
                self.request("POST", f"/containers/{new_id}/stop?t=10")
                self.request("DELETE", f"/containers/{new_id}?force=true&v=false")
                current = None
            if current:
                old_id = str(current.get("Id") or old_id)
                self.expect("POST", f"/containers/{old_id}/stop?t=30", statuses=(204, 304))
                stopped = True
                self.expect("POST", f"/containers/{old_id}/rename?name={urllib.parse.quote(backup_name, safe='')}", statuses=(204,))
                renamed = True
            elif backup:
                old_id = str(backup.get("Id") or old_id)
                renamed = True
                stopped = not bool((backup.get("State") or {}).get("Running"))
            else:
                old = self.maybe_inspect_container(old_id)
                if not old:
                    raise DockerApiError("原容器与恢复快照均不存在")
                self.expect("POST", f"/containers/{old_id}/stop?t=30", statuses=(204, 304))
                stopped = True
                self.expect("POST", f"/containers/{old_id}/rename?name={urllib.parse.quote(backup_name, safe='')}", statuses=(204,))
                renamed = True
            payload = self._create_payload(snapshot, image)
            query = urllib.parse.urlencode({"name": original_name})
            raw = self.expect("POST", f"/containers/create?{query}", payload)
            new_id = str(json.loads(raw)["Id"])
            self.expect("POST", f"/containers/{new_id}/start", statuses=(204,))
            for _ in range(45):
                current = self.inspect_container(new_id)
                state = current.get("State") or {}
                if state.get("Running") and self._exec_healthcheck(new_id):
                    self.expect("DELETE", f"/containers/{urllib.parse.quote(backup_name, safe='')}?force=false", statuses=(204,))
                    return new_id
                if not state.get("Running") or state.get("Status") in {"exited", "dead"}:
                    break
                time.sleep(self.health_poll_interval)
            raise DockerApiError("新容器健康检查未通过")
        except Exception:
            if new_id:
                self.request("POST", f"/containers/{new_id}/stop?t=10")
                self.request("DELETE", f"/containers/{new_id}?force=true&v=false")
            if renamed:
                try:
                    self.expect(
                        "POST",
                        f"/containers/{urllib.parse.quote(backup_name, safe='')}/rename?name={urllib.parse.quote(original_name, safe='')}",
                        statuses=(204,),
                    )
                    if stopped:
                        self.expect("POST", f"/containers/{old_id}/start", statuses=(204,))
                except Exception as recovery_exc:
                    raise DockerApiError("新容器启动失败且旧容器恢复失败") from recovery_exc
            elif stopped:
                raise DockerApiError("原容器已停止但无法确认其可恢复名称")
            if renamed and stopped:
                raise DockerReplaceRecovered("新容器健康检查未通过，旧容器已恢复")
            raise


def write_sensitive_json(path: Path, value: dict[str, Any]) -> None:
    """原子写入敏感 handoff 状态，文件权限严格为 0600。"""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
