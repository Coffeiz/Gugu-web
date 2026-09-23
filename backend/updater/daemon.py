"""受限更新执行器：并入 app 进程内运行（PRD-ADMIN-2 §1.1）。

Admin 更新端点经 updater.client 进程内直调，无 Unix Socket IPC。所有 Docker
操作均由固定 Compose 文件和固定服务名执行，不接受任意命令、路径或镜像仓库；
更新能力不进入 Agent 工具注册表，模型与提示注入不可达。启用条件：app 容器
挂载 Docker socket 且未设置 GUGU_SELF_UPDATE=off。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import signal
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import quote, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from updater.deployment import detect_deployment
from updater.sandbox_signature import (
    COSIGN_IDENTITY_REGEXP,
    COSIGN_OIDC_ISSUER,
    COSIGN_VERIFY_TIMEOUT_SECONDS,
    COSIGN_VERIFIER_IMAGE,
    cosign_verify_command,
)
from updater.standalone import DockerEngine, DockerReplaceRecovered, StandaloneConfigError, snapshot_standalone_container, write_sensitive_json


VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$")
IMAGE_RE = re.compile(r"^(?:docker\.io|ghcr\.io)/coffeiz/gugu-web@sha256:[0-9a-f]{64}$")
SPLIT_IMAGE_PATTERNS = {
    "backend_image": re.compile(r"^(?:docker\.io|ghcr\.io)/coffeiz/gugu-web-backend@sha256:[0-9a-f]{64}$"),
    "frontend_image": re.compile(r"^(?:docker\.io|ghcr\.io)/coffeiz/gugu-web-frontend@sha256:[0-9a-f]{64}$"),
}
SPLIT_TAG_PATTERNS = {
    "backend_image": re.compile(r"^(?:(?:docker\.io|index\.docker\.io)/)?coffeiz/gugu-web-backend:[A-Za-z0-9_.-]{1,128}$|^ghcr\.io/coffeiz/gugu-web-backend:[A-Za-z0-9_.-]{1,128}$"),
    "frontend_image": re.compile(r"^(?:(?:docker\.io|index\.docker\.io)/)?coffeiz/gugu-web-frontend:[A-Za-z0-9_.-]{1,128}$|^ghcr\.io/coffeiz/gugu-web-frontend:[A-Za-z0-9_.-]{1,128}$"),
}
TAG_IMAGE_RE = re.compile(r"^(?:docker\.io/)?coffeiz/gugu-web:[A-Za-z0-9_.-]{1,128}$|^ghcr\.io/coffeiz/gugu-web:[A-Za-z0-9_.-]{1,128}$")
# 执行器并入 app 容器后，官方发布位即应用镜像白名单（tag/digest 二选一）。
ALLOWED_REDIRECT_HOSTS = {
    "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
}
MANIFEST_NAME = "update-manifest.json"
TERMINAL = {"succeeded", "failed", "rollback_required"}
ACTIVE = {"pending", "prechecking", "backing_up", "pulling", "migrating", "recreating", "health_checking", "rolling_back"}
RECREATING_PENDING_RESTART = "recreating_pending_restart"
STAGE_BY_LINE = (
    ("验证 manifest", "prechecking"),
    ("备份", "backing_up"),
    ("拉取", "pulling"),
    ("迁移", "migrating"),
    ("重新创建", "recreating"),
    ("健康检查", "health_checking"),
)
MIN_FREE_BYTES = 3 * 1024**3
CHALLENGE_TTL_SECONDS = 600
UPDATE_PROCESS_TIMEOUT_SECONDS = 90 * 60
COSIGN_CACHE_DIRNAME = "sigstore-cache"
logger = logging.getLogger("gugu.updater")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _version_key(value: str) -> tuple[int, int, int, str]:
    match = VERSION_RE.fullmatch(value)
    if not match:
        raise ValueError("版本号无效")
    major, minor, patch, suffix = match.groups()
    return int(major), int(minor), int(patch), suffix or "~"


def _safe_image(value: str) -> bool:
    return bool(IMAGE_RE.fullmatch(value) or TAG_IMAGE_RE.fullmatch(value))


def self_update_enabled() -> bool:
    """一体化部署的自更新开关：GUGU_SELF_UPDATE=off 显式关闭（PRD-ADMIN-2 §1.1）。"""
    return os.getenv("GUGU_SELF_UPDATE", "on").strip().lower() not in {"off", "0", "false", "no"}


def signature_verification_enabled() -> bool:
    """发布签名验证的 break-glass 开关。

    只认容器启动 env（GUGU_UPDATER_SKIP_COSIGN=on），Admin API、manifest 和
    Agent 都改不到它；关闭后 preflight 显示「已禁用」且 history 记录 skipped，
    灾难恢复用，不是常规配置。
    """
    return os.getenv("GUGU_UPDATER_SKIP_COSIGN", "off").strip().lower() not in {"on", "1", "true", "yes"}


class SafeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urlparse(newurl)
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_REDIRECT_HOSTS:
            raise URLError("release asset redirect is outside the allowlist")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class UpdateDaemon:
    def __init__(self) -> None:
        standalone_mode = os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "standalone_docker"
        project = os.getenv("GUGU_UPDATER_COMPOSE_DIR", "")
        self.project_dir = Path(project).resolve() if project else Path.cwd().resolve()
        compose_name = os.getenv("GUGU_UPDATER_COMPOSE_FILE", "docker-compose.yml")
        if Path(compose_name).name != compose_name or not compose_name.endswith((".yml", ".yaml")):
            raise RuntimeError("Compose 文件名无效")
        if not self.project_dir.is_absolute() or (not standalone_mode and not (self.project_dir / compose_name).is_file()):
            raise RuntimeError("Compose 项目目录无效")
        self.compose_file = self.project_dir / compose_name
        state_default = "/data/updater" if Path("/data").is_dir() else "/var/lib/gugu-updater"
        self.state_dir = Path(os.getenv("GUGU_UPDATER_STATE_DIR", state_default)).resolve()
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.code_dir = Path(os.getenv("GUGU_UPDATER_CODE_DIR", "/opt/gugu-updater")).resolve()
        self.validator = self.code_dir / "scripts/release/validate-update-manifest.mjs"
        self.manifest_schema = self.code_dir / "deploy/update-manifest.schema.json"
        self.compose_update_script = self.code_dir / "scripts/release/compose-update.sh"
        self.split_compose_update_script = self.code_dir / "scripts/release/split-compose-update.sh"
        self.manifest_latest_url = "https://github.com/Coffeiz/Gugu-web/releases/latest/download/"
        self.state_file = self.state_dir / "state.json"
        self._lock = asyncio.Lock()
        self._resume_after_restart = False
        self.state = self._read_state()
        task = self.state.get("task")
        if self._resume_after_restart or (isinstance(task, dict) and task.get("failure_code") == "updater_restarted"):
            self._save()

    def _read_state(self) -> dict[str, Any]:
        if not self.state_file.exists():
            return {"schema": 1, "candidate": None, "task": None, "history": [], "challenges": []}
        try:
            value = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError("更新器状态文件损坏，拒绝覆盖") from exc
        if not isinstance(value, dict) or value.get("schema") != 1:
            raise RuntimeError("更新器状态文件格式无效，拒绝覆盖")
        task = value.get("task")
        interrupted = False
        resumed = False
        standalone_handoff = os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "standalone_docker"
        if isinstance(task, dict) and task.get("status") == RECREATING_PENDING_RESTART and not standalone_handoff:
            task.update({
                "status": "health_checking",
                "stage": "health_checking",
                "progress": 90,
                "message": "应用已重启，正在确认更新结果。",
                "updated_at": _utc_now(),
            })
            self._resume_after_restart = True
            resumed = True
        elif (
            isinstance(task, dict) and task.get("status") in ACTIVE
            and not (standalone_handoff and task.get("status") == RECREATING_PENDING_RESTART)
        ):
            old = task
            old.update({
                "status": "rollback_required" if old.get("previous_image") else "failed",
                "stage": "interrupted",
                "failure_code": "updater_restarted",
                "message": "更新器重启中断了任务；请检查服务状态后决定是否回滚。",
                "updated_at": _utc_now(),
                "completed_at": _utc_now(),
            })
            interrupted = True
        value.setdefault("candidate", None)
        value.setdefault("task", None)
        value.setdefault("history", [])
        value.setdefault("challenges", [])
        if interrupted or resumed:
            history = value["history"]
            matched = False
            for row in history:
                if isinstance(row, dict) and row.get("id") == task.get("id"):
                    row.update(task)
                    matched = True
            if not matched:
                history.append(dict(task))
            value["history"] = history[-20:]
        return value

    def _task_status(self) -> str | None:
        task = self.state.get("task")
        return str(task.get("status")) if isinstance(task, dict) else None

    def start_pending_restart_resume(self) -> None:
        """在新 app 启动后接管 helper 已完成的重建任务。"""
        if os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "standalone_docker":
            asyncio.create_task(self._cleanup_standalone_helper())
            return
        if not self._resume_after_restart:
            return
        self._resume_after_restart = False
        asyncio.create_task(self._resume_after_restart_task())

    async def _cleanup_standalone_helper(self) -> None:
        """新 app 启动后清理由前一版本交接的已退出 helper 容器。"""
        for _ in range(180):
            try:
                value = json.loads(self.state_file.read_text(encoding="utf-8"))
                task = value.get("task") if isinstance(value, dict) else None
                if not isinstance(task, dict) or not task.get("helper_name"):
                    return
                if isinstance(task, dict) and task.get("status") in TERMINAL:
                    await self._remove_standalone_helper(str(task.get("helper_name") or ""))
                    return
                if task.get("status") not in ACTIVE:
                    return
            except Exception:
                # 清理只影响退出的短期 helper，不影响 app 启动或更新结果。
                pass
            await asyncio.sleep(5)

    async def _remove_standalone_helper(self, name: str) -> None:
        if not re.fullmatch(r"gugu-updater-[0-9a-f-]{12}", name):
            return
        for _ in range(30):
            try:
                running = await self._command(
                    ["docker", "inspect", "--format", "{{.State.Running}}", name], timeout=10,
                )
                if running.strip().lower() == b"false":
                    await self._command(["docker", "rm", name], timeout=15)
                    return
            except Exception:
                return
            await asyncio.sleep(2)

    async def _resume_after_restart_task(self) -> None:
        task = self.state.get("task")
        if not isinstance(task, dict):
            return
        task_id = str(task.get("id") or "")
        if not task_id:
            return
        healthy = await self._wait_app_healthy()
        if not healthy:
            await self._finish_task(task_id, "rollback_required", "health_check_failed", "新版本未通过健康检查；上一版本已保留，可执行回滚。")
            return
        await self._record_current_release(str(task.get("version") or "unknown"), str(task.get("app_image") or ""))
        await self._finish_task(task_id, "succeeded", None, "更新完成，应用健康检查通过。")

    def _save(self) -> None:
        tmp = self.state_file.with_suffix(".tmp")
        encoded = json.dumps(self.state, ensure_ascii=False, separators=(",", ":"))
        with tmp.open("w", encoding="utf-8") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.state_file)

    def _public_task(self) -> dict[str, Any] | None:
        task = self.state.get("task")
        if not isinstance(task, dict):
            return None
        return {
            key: value for key, value in task.items()
            if key not in {"previous_image", "previous_sandboxd_image", "helper_name", "handoff_file"}
        }

    def _public_candidate(self) -> dict[str, Any] | None:
        candidate = self.state.get("candidate")
        if not isinstance(candidate, dict):
            return None
        fields = (
            "version", "channel", "minimum_version", "app_image", "architectures",
            "database_migration", "release_notes_url", "rollback_supported", "git_sha",
            "published_at", "manifest_sha256", "checked_at", "split_images",
        )
        return {key: candidate[key] for key in fields if key in candidate}

    async def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        method = request.get("method")
        params = request.get("params")
        if not isinstance(method, str) or not isinstance(params, dict):
            raise ValueError("请求格式无效")
        handlers = {
            "health": self._health,
            "status": self._status,
            "check": self._check,
            "preflight": self._preflight,
            "start": self._start,
            "rollback_preflight": self._rollback_preflight,
            "rollback": self._rollback,
        }
        handler = handlers.get(method)
        if handler is None:
            raise ValueError("不支持的更新动作")
        return await handler(params)

    async def _health(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {"healthy": True}

    async def _status(self, _params: dict[str, Any]) -> dict[str, Any]:
        deployment = detect_deployment()
        if deployment["mode"] == "integrated_compose" and deployment["enabled"]:
            try:
                await self._compose(["config", "--format", "json"])
            except Exception:
                deployment.update({
                    "enabled": False,
                    "capability": "manual",
                    "reason_code": "compose_invalid",
                    "reason": "一体化 Compose 配置校验失败；自动更新已关闭。",
                })
        async with self._lock:
            current = self.state.get("current")
            candidate = self.state.get("candidate")
            current_version = str(current.get("version") or "unknown") if isinstance(current, dict) else "unknown"
            candidate_version = str(candidate.get("version") or "") if isinstance(candidate, dict) else ""
            has_update = bool(candidate_version) and (
                current_version == "unknown"
                or _version_key(candidate_version) > _version_key(current_version)
            )
            return {
                **deployment,
                "current": {"version": current_version} if isinstance(current, dict) else None,
                "candidate": self._public_candidate(),
                "has_update": has_update,
                "task": self._public_task(),
                "history": [self._public_history_row(row) for row in self.state.get("history", [])[-20:]],
            }

    @staticmethod
    def _public_history_row(row: dict[str, Any]) -> dict[str, Any]:
        return {
            key: value for key, value in row.items()
            if key not in {"previous_image", "previous_sandboxd_image", "helper_name", "handoff_file"}
        }

    async def _read_url(self, url: str, *, limit: int = 1_500_000) -> bytes:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != "github.com":
            raise ValueError("更新源不受支持")

        def fetch() -> bytes:
            opener = build_opener(SafeRedirectHandler())
            request = Request(url, headers={"User-Agent": "Gugu-Updater", "Accept": "application/octet-stream"})
            with opener.open(request, timeout=30) as response:
                final_url = urlparse(response.geturl())
                if final_url.scheme != "https" or final_url.hostname not in ALLOWED_REDIRECT_HOSTS:
                    raise ValueError("更新源重定向不受支持")
                data = response.read(limit + 1)
                if len(data) > limit:
                    raise ValueError("更新文件超过大小限制")
                return data

        return await asyncio.to_thread(fetch)

    def _asset_url(self, version: str, name: str) -> str:
        if not VERSION_RE.fullmatch(version) or name != MANIFEST_NAME:
            raise ValueError("更新资源标识无效")
        return f"https://github.com/Coffeiz/Gugu-web/releases/download/{quote(version, safe='v.-+')}/{name}"

    async def _verify_assets(self, manifest_bytes: bytes, *, expected_sha: str | None = None) -> dict[str, Any]:
        digest = hashlib.sha256(manifest_bytes).hexdigest()
        if expected_sha and not secrets.compare_digest(digest, expected_sha):
            raise ValueError("已发布 manifest 与预检摘要不一致")
        try:
            manifest = json.loads(manifest_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Release manifest 格式无效") from exc
        if not isinstance(manifest, dict) or not isinstance(manifest.get("version"), str):
            raise ValueError("Release manifest 格式无效")
        version = manifest["version"]
        if manifest.get("channel") != "stable" or not VERSION_RE.fullmatch(version):
            raise ValueError("Release 不是受支持的 stable 版本")
        schema_version = manifest.get("schema_version")
        if schema_version != 3:
            raise ValueError("Release manifest 版本不受支持；仅接受 v3")
        if not IMAGE_RE.fullmatch(str(manifest.get("app_image") or "")):
            raise ValueError("Release 镜像不在一体化镜像白名单内")
        split_images = manifest.get("split_images")
        if not isinstance(split_images, dict) or set(split_images) != set(SPLIT_IMAGE_PATTERNS):
            raise ValueError("Release 分体镜像组不完整")
        if any(not pattern.fullmatch(str(split_images.get(key) or "")) for key, pattern in SPLIT_IMAGE_PATTERNS.items()):
            raise ValueError("Release 分体镜像不在白名单内")

        asset_dir = self.state_dir / "assets" / version
        asset_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        manifest_path = asset_dir / MANIFEST_NAME
        with manifest_path.open("wb") as stream:
            stream.write(manifest_bytes)
        os.chmod(manifest_path, 0o600)

        # 定位修订（PRD-ADMIN-2 §1.1）：移除签名校验；完整性由 HTTPS 拉取 +
        # manifest sha256 与预检比对、镜像 digest 白名单保障。
        await self._command(["node", str(self.validator), "--schema", str(self.manifest_schema)], timeout=20)
        await self._command(["node", str(self.validator), str(manifest_path)], timeout=20)
        manifest["manifest_sha256"] = digest
        manifest["checked_at"] = _utc_now()
        manifest["_manifest_path"] = str(manifest_path)
        return manifest

    async def _check(self, _params: dict[str, Any]) -> dict[str, Any]:
        try:
            manifest_bytes = await self._read_url(urljoin(self.manifest_latest_url, MANIFEST_NAME))
            try:
                provisional = json.loads(manifest_bytes)
                version = provisional["version"]
            except (TypeError, KeyError, json.JSONDecodeError) as exc:
                raise ValueError("Release manifest 格式无效") from exc
            candidate = await self._verify_assets(manifest_bytes)
        except (OSError, URLError, TimeoutError) as exc:
            raise RuntimeError("无法访问 GitHub Release 更新源") from exc
        current = await self._current_release()
        current_version = current.get("version", "unknown")
        has_update = current_version == "unknown" or _version_key(candidate["version"]) > _version_key(current_version)
        async with self._lock:
            self.state["candidate"] = candidate
            self.state["current"] = current
            self._save()
        return {
            "has_update": has_update,
            "current": current,
            "candidate": self._public_candidate(),
        }

    async def _current_release(self) -> dict[str, Any]:
        if os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "standalone_docker":
            return await self._current_standalone_release()
        config = await self._compose(["config", "--format", "json"])
        if os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "split_compose":
            return await self._current_split_release(config)
        return await self._current_integrated_release(config)

    async def _current_standalone_release(self) -> dict[str, Any]:
        container_id = Path("/etc/hostname").read_text(encoding="utf-8").strip()
        inspected = DockerEngine().inspect_container(container_id)
        snapshot = snapshot_standalone_container(inspected)
        labels = snapshot["config"].get("Labels") or {}
        image = str(snapshot.get("image") or "")
        try:
            info = await self._docker_json(["image", "inspect", str(inspected.get("Image") or "")], timeout=15)
            digest_ref = next((
                self._normalize_digest_ref(ref)
                for ref in info[0].get("RepoDigests", [])
                if self._normalize_digest_ref(ref)
            ), None)
            image = digest_ref or image
        except Exception:
            logger.info("standalone release digest unavailable")
        version = str(labels.get("org.opencontainers.image.version") or self._version_from_ref(image) or "unknown")
        return {
            "version": version, "image": image,
            "image_id": str(inspected.get("Image") or ""),
            "container_name": snapshot["container_name"],
        }

    async def _current_integrated_release(self, config: dict[str, Any]) -> dict[str, Any]:
        app_image = str(config.get("services", {}).get("app", {}).get("image") or "")
        if not _safe_image(app_image):
            # 本地项目的旧 Compose 可用可识别 tag；非白名单镜像禁止更新，不允许 UI 覆盖。
            normalized = app_image.removeprefix("docker.io/")
            if not TAG_IMAGE_RE.fullmatch(normalized):
                raise ValueError("当前 Compose app 镜像不符合更新白名单")
            app_image = normalized
        container_id = (await self._compose_text(["ps", "-q", "app"])).strip().splitlines()
        if not container_id:
            raise RuntimeError("当前一体化 app 容器未运行")
        inspect = await self._docker_json(["inspect", container_id[0]])
        container = inspect[0]
        labels = container.get("Config", {}).get("Labels") or {}
        image_id = str(container.get("Image") or "")
        image_info = await self._docker_json(["image", "inspect", image_id])
        repo_digests = image_info[0].get("RepoDigests") or []
        digest_ref = next((self._normalize_digest_ref(item) for item in repo_digests if self._normalize_digest_ref(item)), None)
        image_ref = digest_ref or app_image
        version = str(labels.get("org.opencontainers.image.version") or self._version_from_ref(app_image) or "unknown")
        sandbox_image = str(config.get("services", {}).get("sandboxd", {}).get("image") or "")
        return {
            "version": version, "image": image_ref, "image_id": image_id,
            "compose_app_image": app_image, "compose_sandboxd_image": sandbox_image,
        }

    async def _current_split_release(self, config: dict[str, Any]) -> dict[str, Any]:
        services = config.get("services", {})
        images: dict[str, str] = {}
        for key, service in (("backend_image", "backend"), ("frontend_image", "frontend")):
            image = str(services.get(service, {}).get("image") or "")
            normalized = image.replace("index.docker.io/", "docker.io/")
            if not (SPLIT_IMAGE_PATTERNS[key].fullmatch(normalized) or SPLIT_TAG_PATTERNS[key].fullmatch(normalized)):
                raise ValueError("当前分体 Compose 镜像不符合更新白名单")
            images[key] = normalized
        containers: dict[str, dict[str, Any]] = {}
        for service in ("backend", "frontend"):
            ids = (await self._compose_text(["ps", "-q", service])).strip().splitlines()
            if not ids:
                raise RuntimeError(f"分体 {service} 容器未运行")
            inspect = (await self._docker_json(["inspect", ids[0]]))[0]
            containers[service] = inspect
        labels = containers["backend"].get("Config", {}).get("Labels") or {}
        version = str(labels.get("org.opencontainers.image.version") or self._version_from_ref(images["backend_image"]) or "unknown")
        backend_id = str(containers["backend"].get("Image") or "")
        backend_info = await self._docker_json(["image", "inspect", backend_id])
        backend_digest = next((self._normalize_split_digest_ref(item, "backend_image") for item in backend_info[0].get("RepoDigests", [])), None)
        frontend_id = str(containers["frontend"].get("Image") or "")
        frontend_info = await self._docker_json(["image", "inspect", frontend_id])
        frontend_digest = next((self._normalize_split_digest_ref(item, "frontend_image") for item in frontend_info[0].get("RepoDigests", [])), None)
        return {
            "version": version,
            "image": backend_digest or images["backend_image"],
            "frontend_image": frontend_digest or images["frontend_image"],
            "image_id": backend_id,
            "compose_backend_image": images["backend_image"],
            "compose_frontend_image": images["frontend_image"],
            "compose_sandboxd_image": str(services.get("sandboxd", {}).get("image") or ""),
        }

    @staticmethod
    def _normalize_split_digest_ref(value: str, key: str) -> str | None:
        normalized = value.replace("index.docker.io/", "docker.io/")
        if normalized.startswith("coffeiz/"):
            normalized = "docker.io/" + normalized
        pattern = SPLIT_IMAGE_PATTERNS[key]
        return normalized if pattern.fullmatch(normalized) else None

    @staticmethod
    def _normalize_digest_ref(value: str) -> str | None:
        value = value.replace("index.docker.io/", "docker.io/")
        if value.startswith("coffeiz/gugu-web@sha256:"):
            value = "docker.io/" + value
        return value if IMAGE_RE.fullmatch(value) else None

    @staticmethod
    def _version_from_ref(value: str) -> str | None:
        tail = value.rsplit(":", 1)[-1]
        return tail if VERSION_RE.fullmatch(tail) else None

    async def _preflight(self, params: dict[str, Any]) -> dict[str, Any]:
        operator = self._validate_operator(params.get("operator"))
        async with self._lock:
            candidate = self.state.get("candidate")
            if not isinstance(candidate, dict):
                raise ValueError("请先检查更新")
            if self._task_status() in ACTIVE:
                raise RuntimeError("已有 Docker 更新任务正在执行")
        current = self.state.get("current") or await self._current_release()
        current_version = current.get("version", "unknown")
        async with self._lock:
            self.state["current"] = current
            self._save()
        if current_version != "unknown" and _version_key(candidate["version"]) <= _version_key(current_version):
            return {"ready": False, "has_update": False, "current": current, "candidate": self._public_candidate(), "checks": []}

        checks = await self._preflight_checks(candidate)
        ready = all(check["ok"] for check in checks)
        result: dict[str, Any] = {
            "ready": ready, "has_update": True, "current": current,
            "candidate": self._public_candidate(), "checks": checks,
        }
        if ready:
            token = secrets.token_urlsafe(48)
            challenge = {
                "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
                "operator": operator,
                "action": "update",
                "version": candidate["version"],
                "manifest_sha256": candidate["manifest_sha256"],
                "expires_at": time.time() + CHALLENGE_TTL_SECONDS,
            }
            async with self._lock:
                self.state["challenges"] = [item for item in self.state.get("challenges", []) if item.get("expires_at", 0) > time.time()]
                self.state["challenges"].append(challenge)
                self._save()
            result["challenge"] = token
            result["challenge_expires_at"] = datetime.fromtimestamp(challenge["expires_at"], timezone.utc).isoformat()
        return result

    def _cosign_command(self, image: str, cache_dir: Path) -> list[str]:
        """构造 verifier 命令；独立成纯方法便于测试断言参数形状。

        verify 子命令没有 referrers 模式开关（v3.1.3 实测：flag 仅 sign 有、
        COSIGN_REGISTRY_REFERRERS_MODE 环境变量不存在），自动探测 referrers API
        并在不支持时回落 legacy tag；发布端已用 --registry-referrers-mode=oci-1-1
        钉死签名形态，验证端按 digest 查询即可命中 referrers artifact。
        """
        return cosign_verify_command(image, cache_dir=cache_dir)

    async def _cosign_run(self, command: list[str]) -> tuple[int | None, str]:
        """运行 verifier 并返回 (returncode, stderr)；不把 stderr 写入可见日志。"""
        process = await asyncio.create_subprocess_exec(
            *command, cwd=self.project_dir, env=os.environ.copy(),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            _stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=COSIGN_VERIFY_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            return None, "timeout"
        return process.returncode, stderr.decode("utf-8", errors="replace")

    async def _verify_signature(self, image: str) -> dict[str, Any]:
        """校验目标镜像的发布签名；fail-closed，任何失败都不得放行更新。

        真实性锚点 = tag 触发的 docker-release.yml 的 GitHub OIDC 身份；
        cosign 自行校验签名 payload 绑定的 digest 与被验镜像一致，无 TOCTOU 窗口。
        """
        if not signature_verification_enabled():
            return {"ok": True, "skipped": True, "detail": "发布签名验证已被管理员禁用（GUGU_UPDATER_SKIP_COSIGN=on）"}
        cache_dir = self.state_dir / COSIGN_CACHE_DIRNAME
        cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            returncode, stderr = await self._cosign_run(self._cosign_command(image, cache_dir))
        except (OSError, RuntimeError) as exc:
            logger.info("cosign verify launcher failed error_type=%s", type(exc).__name__)
            return {"ok": False, "skipped": False, "detail": "签名校验器无法启动，已阻断更新"}
        if returncode == 0:
            return {"ok": True, "skipped": False, "detail": "发布签名校验通过（GitHub Actions 发布身份）"}
        if returncode is None:
            return {"ok": False, "skipped": False, "detail": "签名校验超时，已阻断更新"}
        lowered = stderr.lower()
        if "no signatures found" in lowered or "signature not found" in lowered:
            return {"ok": False, "skipped": False, "detail": "目标镜像没有发布签名，已阻断更新"}
        if "none of the expected identities" in lowered or "no matching" in lowered:
            return {"ok": False, "skipped": False, "detail": "签名身份与官方发布工作流不符，已阻断更新"}
        logger.info("cosign verify failed rc=%s", returncode)
        return {"ok": False, "skipped": False, "detail": "签名校验未通过，已阻断更新"}

    async def _preflight_checks(self, candidate: dict[str, Any]) -> list[dict[str, Any]]:
        if os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "standalone_docker":
            return await self._standalone_preflight_checks(candidate)
        if os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "split_compose":
            return await self._split_preflight_checks(candidate)
        results: list[dict[str, Any]] = []

        def add(key: str, ok: bool, detail: str) -> None:
            results.append({"key": key, "ok": bool(ok), "detail": detail})

        try:
            platform = await self._docker_host_platform()
            add("docker", bool(platform), "Docker daemon 可用" if platform else "宿主机架构不受支持")
        except Exception:
            platform = ""
            add("docker", False, "无法连接 Docker daemon")

        try:
            config = await self._compose(["config", "--format", "json"])
            services = config.get("services", {})
            required = {"app", "postgres", "redis"}
            add("compose", required.issubset(services), "一体化 Compose 服务定义完整" if required.issubset(services) else "Compose 缺少必需服务")
            app_ids = (await self._compose_text(["ps", "-q", "app"])).strip().splitlines()
            add("app", bool(app_ids), "一体化 app 容器正在运行" if app_ids else "一体化 app 容器未运行")
            # 定位修订（§1.1）：更新执行器并入 app 进程；socket 挂载即启用。
            socket_path = Path(os.getenv("GUGU_DOCKER_SOCKET", "/var/run/docker.sock"))
            add("updater", socket_path.exists(), "Docker socket 已挂载，自更新可用" if socket_path.exists() else "未检测到 Docker socket 挂载；此部署未启用一键更新")
            await self._compose_text(["exec", "-T", "postgres", "sh", "-c", 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'])
            await self._compose_text(["exec", "-T", "redis", "sh", "-c", 'if [ -n "$GUGU_REDIS_PASSWORD" ]; then redis-cli -a "$GUGU_REDIS_PASSWORD" ping; else redis-cli ping; fi'])
            add("dependencies", True, "PostgreSQL 和 Redis 健康")
        except Exception:
            app_ids = []
            add("dependencies", False, "Compose、数据库或 Redis 健康检查失败")

        try:
            if not app_ids:
                raise RuntimeError("app 容器未运行")
            container = (await self._docker_json(["inspect", app_ids[0]], timeout=15))[0]
            mounts = {
                mount.get("Destination"): mount
                for mount in container.get("Mounts", [])
                if isinstance(mount, dict)
            }
            storage_ok = all(mounts.get(path, {}).get("RW") is True for path in ("/data", "/config"))
            await self._compose_text(["exec", "-T", "app", "sh", "-c", "test -w /data && test -w /config"], timeout=10)
            add("storage", storage_ok, "用户数据与配置卷均已挂载且可写" if storage_ok else "用户数据或配置卷缺失、只读")
        except Exception:
            add("storage", False, "无法确认用户数据与配置卷的挂载状态")

        try:
            await self._compose_text(["exec", "-T", "app", "python", "-m", "updater.database_check"], timeout=30)
            add("database_migrations", True, "数据库迁移版本与当前应用 head 一致")
        except Exception:
            add("database_migrations", False, "数据库迁移版本未达到当前应用唯一 head")

        backend_env = self.project_dir / "backend/.env"
        config_ok = backend_env.is_file() and not backend_env.is_symlink()
        if config_ok:
            try:
                config_text = backend_env.read_text(encoding="utf-8")
                config_ok = bool(re.search(r"(?m)^\s*ADMIN_PASSWORD\s*=\s*\S", config_text))
            except OSError:
                config_ok = False
        add("configuration", config_ok, "运行配置文件存在" if config_ok else "backend/.env 缺失或未配置管理员密码")

        images = [str(candidate.get("app_image") or "")]
        split_images = candidate.get("split_images")
        if isinstance(split_images, dict):
            images.extend(str(split_images.get(key) or "") for key in SPLIT_IMAGE_PATTERNS)
        shared = await self._shared_release_preflight(candidate, platform, self.project_dir, images)
        free_gib = shared["disk_free_gib"]
        add(
            "disk", shared["disk_ok"],
            f"部署目录所在磁盘剩余 {free_gib} GiB" if shared["disk_ok"]
            else "部署目录所在磁盘空间不足 3 GiB" if free_gib is not None
            else "无法检查部署目录磁盘空间",
        )
        add(
            "architecture", shared["architecture_ok"],
            "镜像架构与宿主机匹配" if shared["architecture_ok"] else "发布镜像不包含宿主机架构",
        )
        # integrity = 运输完整性（manifest 摘要 TOCTOU + namespace/digest 格式）；
        # signature = 真实性（Cosign 验发布工作流身份），失败即 fail-closed。
        add("integrity", True, "manifest 摘要校验与镜像 namespace/digest 格式校验通过")
        signatures_ok = shared["signatures_ok"]
        add(
            "signature", signatures_ok,
            "所有更新产物均通过发布签名校验" if signatures_ok
            else "至少一个更新产物签名无效，已阻断更新",
        )
        if not shared["current_version_known"]:
            add("current_version", False, "无法识别当前镜像版本；请先通过部署脚本完成一次性升级")
            add("minimum_version", False, "当前版本未知，无法验证 manifest 的最低升级版本要求")
        else:
            add("current_version", True, "当前应用版本标签可识别")
            minimum_ok = shared["minimum_version_ok"]
            add("minimum_version", minimum_ok, "当前版本满足最低升级版本要求" if minimum_ok else "当前版本低于最低支持版本，需先按部署文档手动升级")
        return results

    async def _standalone_preflight_checks(self, candidate: dict[str, Any]) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []

        def add(key: str, ok: bool, detail: str) -> None:
            results.append({"key": key, "ok": bool(ok), "detail": detail})

        platform = ""
        try:
            platform = await self._docker_host_platform()
            add("docker", bool(platform), "Docker daemon 可用" if platform else "宿主机架构不受支持")
        except Exception:
            add("docker", False, "无法连接 Docker daemon")

        snapshot = None
        try:
            container_id = Path("/etc/hostname").read_text(encoding="utf-8").strip()
            inspected = DockerEngine().inspect_container(container_id)
            snapshot = snapshot_standalone_container(inspected)
            env = snapshot["config"]["Env"]
            if env.get("DB__HOST", "postgres") not in {"postgres", "localhost", "127.0.0.1"}:
                raise StandaloneConfigError("当前数据库位于容器外，自动备份暂不支持")
            add("container", True, "官方 standalone 容器配置与持久数据挂载符合更新白名单")
            socket_dest = os.getenv("GUGU_DOCKER_SOCKET", "/var/run/docker.sock")
            socket_mount = next((item for item in inspected.get("Mounts", []) if item.get("Destination") == socket_dest and item.get("Type") == "bind"), None)
            data_mount = next((item for item in inspected.get("Mounts", []) if item.get("Destination") == "/data"), None)
            add("updater", bool(socket_mount and data_mount), "Docker socket 与 /data 可供短期 helper 使用" if socket_mount and data_mount else "无法安全挂载 Docker socket 或持久数据到 helper")
            try:
                await self._command(["docker", "exec", container_id, "pg_isready", "-h", "127.0.0.1", "-p", "5432"], timeout=10)
                db_ok = True
            except Exception:
                db_ok = False
            add("database", db_ok, "内嵌 PostgreSQL 正常，可在停止旧容器前备份" if db_ok else "内嵌 PostgreSQL 未就绪，无法验证数据库备份")
        except Exception as exc:
            add("container", False, str(exc) if isinstance(exc, StandaloneConfigError) else "无法安全检查当前 standalone 容器配置")
            add("updater", False, "当前容器无法满足 helper handoff 条件")
            add("database", False, "当前容器无法确认内嵌 PostgreSQL 状态")

        migration_ok = candidate.get("database_migration") is False or candidate.get("rollback_supported") is True
        app_image = str(candidate.get("app_image") or "")
        integrity_ok = bool(IMAGE_RE.fullmatch(app_image))
        shared = await self._shared_release_preflight(
            candidate, platform, Path("/data"), [app_image],
        )
        free_gib = shared["disk_free_gib"]
        add(
            "disk", shared["disk_ok"],
            f"/data 剩余 {free_gib} GiB" if shared["disk_ok"]
            else "/data 空间不足 3 GiB" if free_gib is not None
            else "无法检查 /data 磁盘空间",
        )
        add(
            "architecture", shared["architecture_ok"],
            "镜像架构与宿主机匹配" if shared["architecture_ok"] else "发布镜像不包含宿主机架构",
        )
        add("database_migrations", migration_ok, "发布元数据声明迁移后可回滚" if migration_ok else "该版本包含数据库迁移但未声明兼容回滚，拒绝单容器自动更新")
        add("integrity", integrity_ok, "一体化镜像 digest 白名单校验通过" if integrity_ok else "一体化镜像 digest 无效")
        add("signature", shared["signatures_ok"], "目标镜像发布签名校验通过" if shared["signatures_ok"] else "目标镜像签名无效，已阻断更新")
        add("minimum_version", shared["minimum_version_ok"], "当前版本满足最低升级版本要求" if shared["minimum_version_ok"] else "当前版本未知或低于最低支持版本")
        return results

    async def _split_preflight_checks(self, candidate: dict[str, Any]) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []

        def add(key: str, ok: bool, detail: str) -> None:
            results.append({"key": key, "ok": bool(ok), "detail": detail})

        try:
            platform = await self._docker_host_platform()
            add("docker", bool(platform), "Docker daemon 可用" if platform else "宿主机架构不受支持")
        except Exception:
            platform = ""
            add("docker", False, "无法连接受限 updater 的 Docker daemon")

        service_ids: dict[str, list[str]] = {}
        try:
            config = await self._compose(["config", "--format", "json"])
            services = config.get("services", {})
            required = {"postgres", "redis", "migrate", "backend", "worker", "gateway", "frontend", "nginx"}
            add("compose", required.issubset(services), "分体 Compose 服务定义完整" if required.issubset(services) else "分体 Compose 缺少必需服务")
            for service in ("backend", "worker", "gateway", "frontend", "postgres", "redis"):
                service_ids[service] = (await self._compose_text(["ps", "-q", service])).strip().splitlines()
            all_running = all(service_ids[name] for name in ("backend", "worker", "gateway", "frontend", "postgres", "redis"))
            add("services", all_running, "分体业务与数据库服务均在运行" if all_running else "分体业务或数据库服务未运行")
            await self._compose_text(["exec", "-T", "postgres", "sh", "-c", 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'])
            await self._compose_text(["exec", "-T", "redis", "sh", "-c", 'if [ -n "$GUGU_REDIS_PASSWORD" ]; then redis-cli -a "$GUGU_REDIS_PASSWORD" ping; else redis-cli ping; fi'])
            add("dependencies", True, "PostgreSQL 和 Redis 健康")
        except Exception:
            add("dependencies", False, "Compose、数据库或 Redis 健康检查失败")

        try:
            backend = (await self._docker_json(["inspect", service_ids["backend"][0]]))[0]
            mounts = {item.get("Destination"): item for item in backend.get("Mounts", []) if isinstance(item, dict)}
            storage_ok = mounts.get("/data", {}).get("RW") is True and mounts.get("/config", {}).get("RW") is True
            await self._compose_text(["exec", "-T", "backend", "sh", "-c", "test -w /data && test -w /config"], timeout=10)
            add("storage", storage_ok, "分体用户数据与配置卷均已挂载且可写" if storage_ok else "用户数据或配置卷缺失、只读")
        except Exception:
            add("storage", False, "无法确认分体用户数据与配置卷")

        try:
            await self._compose_text(["exec", "-T", "backend", "python", "-m", "updater.database_check"], timeout=30)
            add("database_migrations", True, "当前数据库迁移状态正常")
        except Exception:
            add("database_migrations", False, "数据库迁移状态异常或检查失败")

        backend_env = self.project_dir / "backend/.env"
        config_ok = backend_env.is_file() and not backend_env.is_symlink()
        if config_ok:
            try:
                config_ok = bool(re.search(r"(?m)^\s*ADMIN_PASSWORD\s*=\s*\S", backend_env.read_text(encoding="utf-8")))
            except OSError:
                config_ok = False
        add("configuration", config_ok, "backend/.env 存在且管理员配置有效" if config_ok else "backend/.env 缺失或管理员密码未设置")

        split_images = candidate.get("split_images")
        valid_split = isinstance(split_images, dict) and all(
            SPLIT_IMAGE_PATTERNS[key].fullmatch(str(split_images.get(key) or ""))
            for key in SPLIT_IMAGE_PATTERNS
        )
        images = [str(candidate.get("app_image") or "")]
        if valid_split:
            images.extend(str(split_images[key]) for key in SPLIT_IMAGE_PATTERNS)
        shared = await self._shared_release_preflight(candidate, platform, self.project_dir, images)
        free_gib = shared["disk_free_gib"]
        add(
            "disk", shared["disk_ok"],
            f"部署目录所在磁盘剩余 {free_gib} GiB" if shared["disk_ok"]
            else "部署目录所在磁盘空间不足 3 GiB" if free_gib is not None
            else "无法检查部署目录磁盘空间",
        )
        add(
            "architecture", shared["architecture_ok"],
            "镜像架构与宿主机匹配" if shared["architecture_ok"] else "发布镜像不包含宿主机架构",
        )
        add("integrity", bool(valid_split), "backend/frontend 固定 digest 白名单校验通过" if valid_split else "backend/frontend 镜像组无效")
        add("signature", shared["signatures_ok"], "所有发布镜像均通过签名校验" if shared["signatures_ok"] else "至少一个发布镜像签名无效，已阻断更新")
        add("minimum_version", shared["minimum_version_ok"], "当前版本满足最低升级版本要求" if shared["minimum_version_ok"] else "当前版本未知或低于最低支持版本")
        return results

    async def _shared_release_preflight(
        self, candidate: dict[str, Any], platform: str, disk_path: Path, images: list[str],
    ) -> dict[str, Any]:
        try:
            free_bytes = shutil.disk_usage(disk_path).free
            disk_ok = free_bytes >= MIN_FREE_BYTES
            disk_free_gib = free_bytes // 1024**3
        except OSError:
            disk_ok = False
            disk_free_gib = None

        current = self.state.get("current") or {}
        current_version = str(current.get("version") or "unknown")
        minimum_version = str(candidate.get("minimum_version") or "")
        minimum_ok = (
            current_version != "unknown"
            and bool(VERSION_RE.fullmatch(minimum_version))
            and _version_key(current_version) >= _version_key(minimum_version)
        )
        signatures = [await self._verify_signature(image) for image in images]
        return {
            "disk_ok": disk_ok,
            "disk_free_gib": disk_free_gib,
            "architecture_ok": platform in candidate.get("architectures", []),
            "signatures_ok": all(item["ok"] for item in signatures),
            "current_version_known": current_version != "unknown",
            "minimum_version_ok": minimum_ok,
        }

    async def _docker_host_platform(self) -> str:
        info = await self._command(
            ["docker", "info", "--format", "{{.Architecture}}"], timeout=12,
        )
        architecture = info.decode().strip()
        if architecture in {"aarch64", "arm64"}:
            return "linux/arm64"
        if architecture in {"x86_64", "amd64"}:
            return "linux/amd64"
        return ""

    async def _start(self, params: dict[str, Any]) -> dict[str, Any]:
        challenge = self._validate_token(params.get("challenge"))
        digest = str(params.get("manifest_sha256") or "")
        operator = self._validate_operator(params.get("operator"))
        async with self._lock:
            candidate = self.state.get("candidate")
            if not isinstance(candidate, dict) or not secrets.compare_digest(candidate.get("manifest_sha256", ""), digest):
                raise ValueError("更新清单已变化，请重新预检")
            self._consume_challenge(challenge, operator, "update", candidate["version"], digest)
            if self._task_status() in ACTIVE:
                raise RuntimeError("已有 Docker 更新任务正在执行")

        checks = await self._preflight_checks(candidate)
        if not all(item["ok"] for item in checks):
            raise RuntimeError("更新预检状态已变化，请重新检查后再试")
        current = await self._current_release()
        current_version = str(current.get("version") or "unknown")
        if current_version == "unknown":
            raise ValueError("无法识别当前版本，请先通过部署脚本完成一次性升级")
        minimum_version = str(candidate.get("minimum_version") or "")
        if _version_key(current_version) < _version_key(minimum_version):
            raise ValueError("当前版本低于最低支持版本，需先按部署文档手动升级")
        if _version_key(candidate["version"]) <= _version_key(current_version):
            raise ValueError("当前版本已达到或高于目标版本，请重新检查更新")
        mode = os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE", "")
        sandbox_state = await self._capture_previous_deployment_state(
            current,
            split_mode=mode == "split_compose",
            standalone_mode=mode == "standalone_docker",
        )

        task = {
            "id": str(uuid.uuid4()), "operation": "update", "version": candidate["version"],
            "manifest_sha256": digest, "app_image": candidate["app_image"],
            "status": "pending", "stage": "pending", "progress": 0,
            "message": "更新任务已排队", "failure_code": None,
            "requested_by": operator, "created_at": _utc_now(), "updated_at": _utc_now(),
            "previous_image": current["image"], "previous_version": current["version"],
            "previous_frontend_image": current.get("frontend_image"),
            "previous_sandboxd_image": sandbox_state["image"] if sandbox_state["running"] else None,
            "sandboxd_was_running": sandbox_state["running"],
            "sandboxd_updated": sandbox_state["tracks_app"],
            "signature_verification": "skipped" if not signature_verification_enabled() else "verified",
            "events": [{"stage": "pending", "at": _utc_now()}],
            "rollback_supported": bool(candidate.get("rollback_supported")),
        }
        async with self._lock:
            if self._task_status() in ACTIVE:
                raise RuntimeError("已有 Docker 更新任务正在执行")
            self.state["task"] = task
            self.state["history"].append(dict(task))
            self.state["history"] = self.state["history"][-20:]
            self._save()
        asyncio.create_task(self._run_update(task["id"], candidate))
        return {"accepted": True, "task": self._public_task()}

    async def _capture_previous_deployment_state(
        self, current: dict[str, Any], *, split_mode: bool, standalone_mode: bool,
    ) -> dict[str, Any]:
        if split_mode:
            self._validate_split_previous_images(current)
            return await self._capture_split_sandbox_state(current)

        if not _safe_image(str(current.get("image") or "")):
            deployment = "standalone" if standalone_mode else "版本"
            raise ValueError(f"无法安全记录当前{deployment}镜像，已拒绝更新")
        if standalone_mode:
            return {"running": False, "image": "", "tracks_app": False}
        return await self._capture_compose_sandbox_state(current)

    @staticmethod
    def _validate_split_previous_images(current: dict[str, Any]) -> None:
        for key, image_key, label in (
            ("backend_image", "image", "backend"),
            ("frontend_image", "frontend_image", "frontend"),
        ):
            image = str(current.get(image_key) or "")
            if not (SPLIT_TAG_PATTERNS[key].fullmatch(image) or SPLIT_IMAGE_PATTERNS[key].fullmatch(image)):
                raise ValueError(f"无法安全记录当前分体 {label} 镜像，已拒绝更新")

    async def _capture_split_sandbox_state(self, current: dict[str, Any]) -> dict[str, Any]:
        ids = (await self._compose_text(["ps", "--status", "running", "-q", "sandboxd"])).strip().splitlines()
        if not ids:
            return {"running": False, "image": "", "tracks_app": False}
        inspected = (await self._docker_json(["inspect", ids[0]]))[0]
        image = str(inspected.get("Config", {}).get("Image") or "")
        running = _safe_image(image) or bool(SPLIT_TAG_PATTERNS["backend_image"].fullmatch(image))
        tracks_app = bool(
            running and current.get("compose_sandboxd_image")
            and current.get("compose_sandboxd_image") == current.get("compose_backend_image")
            and image == current.get("compose_backend_image")
        )
        return {"running": running, "image": image if running else "", "tracks_app": tracks_app}

    async def _capture_compose_sandbox_state(self, current: dict[str, Any]) -> dict[str, Any]:
        ids = (await self._compose_text(["ps", "--status", "running", "-q", "sandboxd"])).strip().splitlines()
        if not ids:
            return {"running": False, "image": "", "tracks_app": False}
        inspected = (await self._docker_json(["inspect", ids[0]]))[0]
        image = str(inspected.get("Config", {}).get("Image") or "")
        running = _safe_image(image)
        tracks_app = bool(
            running and current.get("compose_sandboxd_image")
            and current.get("compose_sandboxd_image") == current.get("compose_app_image")
        )
        return {"running": running, "image": image if running else "", "tracks_app": tracks_app}

    async def _run_update(self, task_id: str, candidate: dict[str, Any]) -> None:
        await asyncio.sleep(3)
        async with self._lock:
            task = self.state.get("task")
            if not task or task.get("id") != task_id:
                return
            task["status"] = "prechecking"
            task["stage"] = "prechecking"
            task["message"] = "正在校验更新环境"
            task["updated_at"] = _utc_now()
            task["events"].append({"stage": "prechecking", "at": _utc_now()})
            self._save()

        if os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "standalone_docker":
            await self._run_standalone_handoff(task_id, candidate)
            return

        temp_dir = Path(tempfile.mkdtemp(prefix="update-", dir=self.state_dir))
        process: asyncio.subprocess.Process | None = None
        stderr_drain: asyncio.Task[bytes] | None = None
        handed_off = False
        try:
            manifest_bytes = await self._read_url(self._asset_url(candidate["version"], MANIFEST_NAME))
            await self._verify_assets(manifest_bytes, expected_sha=candidate["manifest_sha256"])
            backup_root = self.state_dir / "backups"
            backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
            env = os.environ.copy()
            split_mode = os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "split_compose"
            env.update({
                "COMPOSE_PROJECT_DIR": str(self.project_dir),
                "COMPOSE_FILE": str(self.compose_file),
                "BACKUP_ROOT": str(backup_root),
                "GUGU_UPDATER_CODE_DIR": str(self.code_dir),
                "UPDATE_VALIDATOR": str(self.validator),
                "UPDATE_SCHEMA": str(self.manifest_schema),
                # Compose 脚本先记录旧镜像，再从签名 manifest 切换到新 digest。
                "GUGU_WEB_IMAGE": str(self.state["task"]["previous_image"]),
                # 用 manifest 已校验的目标镜像启动 helper；helper 必须包含 handoff 等待逻辑。
                "GUGU_UPDATE_HELPER_IMAGE": str(candidate["app_image"]),
            })
            manifest_path = temp_dir / MANIFEST_NAME
            manifest_path.write_bytes(manifest_bytes)
            os.chmod(manifest_path, 0o600)
            update_script = self.split_compose_update_script if split_mode else self.compose_update_script
            command = ["bash", str(update_script), str(manifest_path)] if split_mode else [
                "bash", str(update_script), "--manifest", str(manifest_path), "--confirm",
            ]
            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=self.project_dir, env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            assert process.stdout is not None and process.stderr is not None
            stderr_drain = asyncio.create_task(process.stderr.read())
            deadline = asyncio.get_running_loop().time() + UPDATE_PROCESS_TIMEOUT_SECONDS
            try:
                while True:
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        raise asyncio.TimeoutError
                    line = await asyncio.wait_for(process.stdout.readline(), timeout=remaining)
                    if not line:
                        break
                    text = line.decode("utf-8", errors="replace").strip()
                    next_stage = next((stage for marker, stage in STAGE_BY_LINE if marker in text), None)
                    if next_stage:
                        await self._set_stage(task_id, next_stage)
                remaining = max(0.1, deadline - asyncio.get_running_loop().time())
                await asyncio.wait_for(process.wait(), timeout=remaining)
                await asyncio.wait_for(stderr_drain, timeout=5)
            except asyncio.TimeoutError:
                await self._terminate_process_group(process)
                if stderr_drain:
                    stderr_drain.cancel()
                raise RuntimeError("Compose 更新任务超时")
            if process.returncode == 75:
                handed_off = True
                await self._set_stage(task_id, RECREATING_PENDING_RESTART)
                Path(f"{manifest_path}.handoff").touch()
                return
            if process.returncode == 76 and split_mode:
                await self._record_current_release(
                    str(self.state["task"].get("previous_version") or "unknown"),
                    str(self.state["task"].get("previous_image") or ""),
                )
                await self._finish_task(
                    task_id, "failed", "update_rolled_back",
                    "更新未完成，已自动恢复上一组业务镜像；数据库未自动回滚。",
                )
                return
            if process.returncode != 0:
                logger.warning("update failed task_id=%s stage=%s reason=compose_exit", task_id, self._task_status())
                await self._finish_task(task_id, "rollback_required", "update_failed", "更新未完成，上一版本已保留；可检查日志或执行回滚。")
                return
            await self._set_stage(task_id, "health_checking")
            healthy = await self._wait_app_healthy()
            if not healthy:
                logger.warning("update failed task_id=%s stage=health_checking reason=health_check_failed", task_id)
                await self._finish_task(task_id, "rollback_required", "health_check_failed", "新版本未通过健康检查；上一版本已保留，可执行回滚。")
                return
            await self._record_current_release(candidate["version"], candidate["app_image"])
            await self._finish_task(task_id, "succeeded", None, "更新完成，应用健康检查通过。")
        except Exception as exc:
            if process is not None and process.returncode is None:
                await self._terminate_process_group(process)
            if stderr_drain and not stderr_drain.done():
                stderr_drain.cancel()
            logger.warning("update failed task_id=%s stage=%s error_type=%s", task_id, self._task_status(), type(exc).__name__)
            await self._finish_task(task_id, "rollback_required", "updater_error", "更新中断；已保留上一版本镜像和备份，请检查更新器日志。")
        finally:
            if not handed_off:
                shutil.rmtree(temp_dir, ignore_errors=True)

    @staticmethod
    def _standalone_host_mount(mount: dict[str, Any], target: str) -> str:
        mount_type = mount.get("Type")
        if mount_type == "bind":
            source = str(mount.get("Source") or "")
            if not source.startswith("/") or any(char in source for char in ",:\n\r"):
                raise StandaloneConfigError("helper 绑定目录无法安全复用")
            return f"type=bind,source={source},target={target}"
        if mount_type == "volume":
            name = str(mount.get("Name") or "")
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name):
                raise StandaloneConfigError("helper 数据卷名称无效")
            return f"type=volume,source={name},target={target}"
        raise StandaloneConfigError("helper 数据挂载类型不受支持")

    async def _run_standalone_handoff(
        self, task_id: str, candidate: dict[str, Any] | None = None,
        *, target_image: str | None = None, target_version: str | None = None,
    ) -> None:
        try:
            if candidate is not None:
                manifest_bytes = await self._read_url(self._asset_url(candidate["version"], MANIFEST_NAME))
                await self._verify_assets(manifest_bytes, expected_sha=candidate["manifest_sha256"])
                target_image = str(candidate["app_image"])
                target_version = str(candidate["version"])
            if not _safe_image(str(target_image or "")) or not VERSION_RE.fullmatch(str(target_version or "")):
                raise ValueError("standalone 更新目标无效")
            if candidate is not None:
                await self._set_stage(task_id, "pulling")
                await self._command(["docker", "pull", str(target_image)], timeout=UPDATE_PROCESS_TIMEOUT_SECONDS)
            await self._set_stage(task_id, "backing_up")
            container_id = Path("/etc/hostname").read_text(encoding="utf-8").strip()
            inspected = await self._docker_json(["inspect", container_id], timeout=15)
            snapshot = snapshot_standalone_container(inspected[0])
            mounts = inspected[0].get("Mounts") or []
            data_mount = next((item for item in mounts if item.get("Destination") == "/data"), None)
            socket_path = os.getenv("GUGU_DOCKER_SOCKET", "/var/run/docker.sock")
            socket_mount = next((item for item in mounts if item.get("Destination") == socket_path and item.get("Type") == "bind"), None)
            if not data_mount or not socket_mount:
                raise StandaloneConfigError("无法确定 helper 的数据目录或 Docker socket")
            data_mount_arg = self._standalone_host_mount(data_mount, "/data")
            socket_source = str(socket_mount.get("Source") or "")
            if not socket_source.startswith("/") or any(char in socket_source for char in ",:\n\r"):
                raise StandaloneConfigError("Docker socket 宿主路径无法安全复用")

            handoff_dir = Path("/data/updater/handoffs") / task_id
            handoff_path = handoff_dir / "handoff.json"
            backup_path = Path("/data/updater/backups") / f"standalone-{task_id}.sql"
            write_sensitive_json(handoff_path, {
                "task_id": task_id, "version": target_version,
                "image": target_image, "snapshot": snapshot,
                "database_backup": str(backup_path),
                # 更新目标已由 updater 验签并拉取；回滚目标由预检确认存在于本机。
                "pull_image": False,
            })

            helper_name = f"gugu-updater-{task_id[:12]}"
            async with self._lock:
                task = self.state.get("task")
                if not isinstance(task, dict) or task.get("id") != task_id:
                    return
                task["helper_name"] = helper_name
                task["handoff_file"] = str(handoff_path)
                task["message"] = "已写入权限受限的更新快照，正在启动独立 helper。"
                task["updated_at"] = _utc_now()
                self._save()

            command = [
                "docker", "run", "--detach", "--name", helper_name,
                "--restart", "on-failure:5",
                "--label", "com.coffeiz.gugu.updater=true",
                "--label", f"com.coffeiz.gugu.updater-task={task_id}",
                "--mount", data_mount_arg,
                "--mount", f"type=bind,source={socket_source},target=/var/run/docker.sock",
                "--env", f"GUGU_UPDATER_HANDOFF_FILE={handoff_path}",
                "--env", "GUGU_UPDATER_STATE_DIR=/data/updater",
                "--env", "GUGU_DOCKER_SOCKET=/var/run/docker.sock",
                "--entrypoint", "python", str(target_image),
                "-m", "updater.standalone_helper",
            ]
            # 先落盘 pending，避免短命 helper 在这里之前完成后被旧进程的阶段写入覆盖。
            await self._set_stage(task_id, RECREATING_PENDING_RESTART)
            await self._command(command, timeout=60)
            await self._follow_standalone_handoff(task_id)
        except Exception as exc:
            # docker run 超时可能发生在 helper 已创建之后；先检查固定 helper 名称，
            # 避免把仍在接管的任务误判失败。
            task = self.state.get("task") or {}
            helper_name = str(task.get("helper_name") or "")
            if helper_name:
                try:
                    found = await self._docker_json(["inspect", helper_name], timeout=10)
                    if found:
                        await self._follow_standalone_handoff(task_id)
                        return
                except Exception:
                    pass
            logger.warning("standalone update handoff failed task_id=%s error_type=%s", task_id, type(exc).__name__)
            await self._finish_task(task_id, "failed", "handoff_failed", "独立 helper 未能启动；原容器未停止，可检查后重试。")

    async def _follow_standalone_handoff(self, task_id: str) -> None:
        """跟随共享状态文件，避免旧 app 进程用内存中的 pending 覆盖 helper 终态。"""
        for _ in range(1800):
            try:
                value = json.loads(self.state_file.read_text(encoding="utf-8"))
                disk_task = value.get("task") if isinstance(value, dict) else None
                if isinstance(disk_task, dict) and disk_task.get("id") == task_id:
                    async with self._lock:
                        self.state = value
                    if disk_task.get("status") in TERMINAL:
                        await self._remove_standalone_helper(str(disk_task.get("helper_name") or ""))
                        return
            except (OSError, json.JSONDecodeError):
                pass
            await asyncio.sleep(1)

    @staticmethod
    async def _terminate_process_group(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), timeout=10)
        except asyncio.TimeoutError:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await process.wait()

    async def _set_stage(self, task_id: str, stage: str) -> None:
        async with self._lock:
            task = self.state.get("task")
            if not task or task.get("id") != task_id:
                return
            task["status"] = stage
            task["stage"] = stage
            task["progress"] = {
                "prechecking": 10, "backing_up": 25, "pulling": 40,
                "migrating": 60, "recreating": 75, "health_checking": 90,
                RECREATING_PENDING_RESTART: 80,
            }.get(stage, task.get("progress", 0))
            task["message"] = self._stage_message(stage)
            task["updated_at"] = _utc_now()
            task["events"].append({"stage": stage, "at": _utc_now()})
            self._save()

    @staticmethod
    def _stage_message(stage: str) -> str:
        return {
            "prechecking": "正在校验更新签名",
            "backing_up": "正在备份配置和数据库",
            "pulling": "正在拉取目标镜像",
            "migrating": "正在迁移用户数据",
            "recreating": "正在重建应用容器",
            RECREATING_PENDING_RESTART: "更新已移交独立 helper，应用即将重启",
            "health_checking": "正在等待健康检查",
            "rolling_back": "正在恢复上一版本",
        }.get(stage, "更新处理中")

    async def _finish_task(self, task_id: str, status: str, failure_code: str | None, message: str) -> None:
        async with self._lock:
            task = self.state.get("task")
            if not task or task.get("id") != task_id:
                return
            task.update({
                "status": status, "stage": status, "progress": 100 if status == "succeeded" else task.get("progress", 0),
                "failure_code": failure_code, "message": message,
                "updated_at": _utc_now(), "completed_at": _utc_now(),
            })
            task["events"].append({"stage": status, "at": _utc_now()})
            self.state["history"][-1] = dict(task)
            self._save()

    async def _wait_app_healthy(self) -> bool:
        for _ in range(30):
            try:
                split_mode = os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "split_compose"
                service = "backend" if split_mode else "app"
                port = "8000" if split_mode else "9595"
                await self._compose_text(
                    ["exec", "-T", service, "curl", "-fsS", f"http://127.0.0.1:{port}/health"],
                    timeout=5,
                )
                await self._compose_text([
                    "exec", "-T", "postgres", "sh", "-c",
                    'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
                ], timeout=5)
                if split_mode:
                    frontend_ids = await self._compose_text(
                        ["ps", "--status", "running", "-q", "frontend"], timeout=5,
                    )
                    if not frontend_ids.strip():
                        raise RuntimeError("frontend is not running")
                return True
            except Exception:
                await asyncio.sleep(2)
        return False

    async def _record_current_release(self, version: str, image: str) -> None:
        current = {"version": version, "image": image}
        try:
            inspected = await self._current_release()
            if inspected.get("version") == version:
                current = inspected
        except Exception as exc:
            logger.info("release state refresh unavailable error_type=%s", type(exc).__name__)
        async with self._lock:
            self.state["current"] = current
            self._save()

    async def _rollback_preflight(self, params: dict[str, Any]) -> dict[str, Any]:
        operator = self._validate_operator(params.get("operator"))
        async with self._lock:
            task = self.state.get("task")
            if not isinstance(task, dict) or task.get("status") not in TERMINAL:
                raise ValueError("当前没有可回滚的完成任务")
            split_mode = os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "split_compose"
            standalone_mode = os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "standalone_docker"
            target = str(task.get("previous_image") or "")
            frontend_target = str(task.get("previous_frontend_image") or "")
            self._validate_rollback_task(task, target, frontend_target, split_mode)
            targets = [target, frontend_target] if split_mode else [target]
            present = await self._rollback_images_present(targets)
            app_defined = await self._rollback_deployment_ready(split_mode, standalone_mode)
            ready = present and app_defined
            result: dict[str, Any] = {
                "ready": ready, "task_id": task["id"], "target_image": target,
                "target_frontend_image": frontend_target if split_mode else None,
                "target_version": task.get("previous_version", "unknown"),
                "detail": "上一版本镜像仍在本机，可安全恢复" if ready else "上一版本镜像不存在或 Compose 服务定义不可用",
            }
            if ready:
                token = secrets.token_urlsafe(48)
                self.state["challenges"].append({
                    "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
                    "operator": operator, "action": "rollback", "version": task["id"],
                    "manifest_sha256": hashlib.sha256(
                        (target + ("\n" + frontend_target if split_mode else "")).encode()
                    ).hexdigest(),
                    "expires_at": time.time() + CHALLENGE_TTL_SECONDS,
                })
                self._save()
                result["challenge"] = token
            return result

    @staticmethod
    def _validate_rollback_task(
        task: dict[str, Any], target: str, frontend_target: str, split_mode: bool,
    ) -> None:
        valid_targets = (
            bool(SPLIT_IMAGE_PATTERNS["backend_image"].fullmatch(target))
            and bool(SPLIT_IMAGE_PATTERNS["frontend_image"].fullmatch(frontend_target))
            if split_mode else _safe_image(target)
        )
        if not task.get("rollback_supported") or not valid_targets:
            raise ValueError("当前任务没有受支持的上一版本镜像")
        if task.get("operation") == "rollback":
            raise ValueError("上一版本已经执行过回滚")

    async def _rollback_images_present(self, images: list[str]) -> bool:
        for image in images:
            try:
                await self._docker_json(["image", "inspect", image], timeout=15)
            except Exception:
                return False
        return True

    async def _rollback_deployment_ready(self, split_mode: bool, standalone_mode: bool) -> bool:
        if standalone_mode:
            try:
                container_id = Path("/etc/hostname").read_text(encoding="utf-8").strip()
                snapshot_standalone_container(DockerEngine().inspect_container(container_id))
                return True
            except Exception:
                return False
        try:
            config = await self._compose(["config", "--format", "json"])
        except Exception:
            return False
        required = {"backend", "frontend"} if split_mode else {"app"}
        return required.issubset(config.get("services") or {})

    async def _rollback(self, params: dict[str, Any]) -> dict[str, Any]:
        token = self._validate_token(params.get("challenge"))
        operator = self._validate_operator(params.get("operator"))
        async with self._lock:
            task = self.state.get("task")
            if not isinstance(task, dict) or task.get("status") not in TERMINAL:
                raise ValueError("当前没有可回滚的完成任务")
            target = str(task.get("previous_image") or "")
            split_mode = os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "split_compose"
            frontend_target = str(task.get("previous_frontend_image") or "")
            challenge_digest = hashlib.sha256(
                (target + ("\n" + frontend_target if split_mode else "")).encode()
            ).hexdigest()
            self._consume_challenge(
                token, operator, "rollback", task["id"], challenge_digest
            )
            if self._task_status() in ACTIVE:
                raise RuntimeError("已有 Docker 更新任务正在执行")
            try:
                current = await self._current_release()
            except Exception:
                # app 已停止（更新中断后的典型状态）时无法探针；当前版本信息直接取自失败的任务，
                # 不让「容器未运行」堵住回滚入口。
                current = {
                    "version": str(task.get("version") or "unknown"),
                    "image": str(task.get("app_image") or task.get("previous_image") or ""),
                }
            rollback_task = {
                "id": str(uuid.uuid4()), "operation": "rollback", "version": str(task.get("previous_version") or "unknown"),
                "status": "pending", "stage": "pending", "progress": 0,
                "message": "回滚任务已排队", "failure_code": None,
                "requested_by": operator, "created_at": _utc_now(), "updated_at": _utc_now(),
                "previous_image": current["image"], "previous_version": current["version"],
                "previous_frontend_image": current.get("frontend_image"),
                "rollback_target_image": target,
                "rollback_target_frontend_image": frontend_target if split_mode else None,
                "rollback_supported": True,
                "sandboxd_was_running": bool(task.get("sandboxd_was_running")),
                "sandboxd_updated": bool(task.get("sandboxd_updated")),
                "events": [{"stage": "pending", "at": _utc_now()}],
            }
            self.state["task"] = rollback_task
            self.state["history"].append(dict(rollback_task))
            self.state["history"] = self.state["history"][-20:]
            self._save()
        asyncio.create_task(self._run_rollback(rollback_task["id"], target))
        return {"accepted": True, "task": self._public_task()}

    async def _run_rollback(self, task_id: str, target_image: str) -> None:
        await asyncio.sleep(3)
        await self._set_stage(task_id, "rolling_back")
        try:
            # 仅恢复本机已存在、且来源为允许仓库的上一版本 digest；不拉取未知 tag。
            task = self.state.get("task")
            task_state = task if isinstance(task, dict) else {}
            restored_version = str(task_state.get("version") or "unknown")
            if os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "standalone_docker":
                await self._run_standalone_handoff(
                    task_id, target_image=target_image, target_version=restored_version,
                )
                return
            if os.getenv("GUGU_UPDATE_DEPLOYMENT_MODE") == "split_compose":
                await self._run_split_rollback(task_id, target_image, task_state, restored_version)
                return
            await self._run_integrated_rollback(task_id, target_image, task_state, restored_version)
        except Exception as exc:
            logger.warning("rollback failed task_id=%s error_type=%s", task_id, type(exc).__name__)
            await self._finish_task(task_id, "rollback_required", "rollback_failed", "回滚未完成；请检查更新器日志和 Compose 服务状态。")

    async def _run_split_rollback(
        self, task_id: str, target_image: str, task_state: dict[str, Any], restored_version: str,
    ) -> None:
        frontend_target = str(task_state.get("rollback_target_frontend_image") or "")
        if not SPLIT_IMAGE_PATTERNS["backend_image"].fullmatch(target_image):
            raise ValueError("回滚 backend 镜像不受支持")
        if not SPLIT_IMAGE_PATTERNS["frontend_image"].fullmatch(frontend_target):
            raise ValueError("回滚 frontend 镜像不受支持")
        await self._docker_json(["image", "inspect", target_image], timeout=15)
        await self._docker_json(["image", "inspect", frontend_target], timeout=15)
        override = self.state_dir / f"rollback-{task_id}.json"
        override.write_text(json.dumps({"services": {
            "migrate": {"image": target_image}, "backend": {"image": target_image},
            "worker": {"image": target_image}, "gateway": {"image": target_image},
            "frontend": {"image": frontend_target},
            **({"sandboxd": {"image": target_image}} if task_state.get("sandboxd_updated") else {}),
        }}), encoding="utf-8")
        os.chmod(override, 0o600)
        try:
            services = ["backend", "worker", "gateway", "frontend"]
            if task_state.get("sandboxd_updated"):
                services.append("sandboxd")
            for service in services:
                await self._compose_text(["stop", service], timeout=45)
            await self._compose_text(
                ["up", "-d", "--no-deps", "--force-recreate", *services],
                timeout=240, compose_files=[self.compose_file, override],
            )
            await self._finish_compose_rollback(task_id, target_image, restored_version)
        finally:
            override.unlink(missing_ok=True)

    async def _run_integrated_rollback(
        self, task_id: str, target_image: str, task_state: dict[str, Any], restored_version: str,
    ) -> None:
        if not _safe_image(target_image):
            raise ValueError("回滚镜像不受支持")
        await self._command(["docker", "image", "inspect", target_image], timeout=15)
        services = ["app"]
        if task_state.get("sandboxd_updated"):
            services.append("sandboxd")
        for service in services:
            await self._compose_text(["stop", service], timeout=45)
        env = os.environ.copy()
        env["GUGU_WEB_IMAGE"] = target_image
        await self._compose_text(
            ["up", "-d", "--no-deps", "--force-recreate", *services], env=env, timeout=180,
        )
        await self._finish_compose_rollback(task_id, target_image, restored_version)

    async def _finish_compose_rollback(self, task_id: str, target_image: str, version: str) -> None:
        if await self._wait_app_healthy():
            await self._record_current_release(version, target_image)
            await self._finish_task(task_id, "succeeded", None, "已恢复上一版本，健康检查通过。")
            return
        await self._finish_task(
            task_id, "rollback_required", "rollback_health_check_failed",
            "回滚后的健康检查未通过；保留当前容器和备份。",
        )

    def _consume_challenge(self, token: str, operator: str, action: str, version: str, digest: str) -> None:
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        now = time.time()
        challenges = self.state.get("challenges", [])
        matched = next((item for item in challenges if secrets.compare_digest(item.get("token_sha256", ""), token_hash)), None)
        self.state["challenges"] = [item for item in challenges if item.get("expires_at", 0) > now and item is not matched]
        if not matched or matched.get("expires_at", 0) <= now:
            self._save()
            raise ValueError("确认已过期，请重新预检")
        if (
            matched.get("operator") != operator or matched.get("action") != action
            or matched.get("version") != version
            or not secrets.compare_digest(str(matched.get("manifest_sha256", "")), digest)
        ):
            self._save()
            raise ValueError("确认与当前更新目标不匹配")
        # challenge 从持久化状态中移除后再继续，one-shot 消费具备原子性。
        self._save()

    @staticmethod
    def _validate_token(value: Any) -> str:
        if not isinstance(value, str) or not 48 <= len(value) <= 128 or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise ValueError("确认令牌格式无效")
        return value

    @staticmethod
    def _validate_operator(value: Any) -> str:
        if not isinstance(value, str) or not value or len(value) > 100:
            raise ValueError("管理员身份无效")
        return value

    async def _compose(self, args: list[str], *, compose_files: list[Path] | None = None) -> dict[str, Any]:
        raw = await self._compose_text(args, compose_files=compose_files)
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError("Compose 配置格式无效")
        return result

    async def _compose_text(
        self, args: list[str], *, env: dict[str, str] | None = None,
        timeout: int = 30, compose_files: list[Path] | None = None,
    ) -> str:
        command = ["docker", "compose", "--project-directory", str(self.project_dir)]
        for compose_file in compose_files or [self.compose_file]:
            command.extend(["-f", str(compose_file)])
        command.extend(["--profile", "sandbox", *args])
        return (await self._command(command, timeout=timeout, env=env)).decode("utf-8", errors="replace")

    async def _docker_json(self, args: list[str], *, timeout: int = 30) -> Any:
        return json.loads((await self._command(["docker", *args], timeout=timeout)).decode("utf-8"))

    async def _command(self, command: list[str], *, timeout: int, env: dict[str, str] | None = None) -> bytes:
        process = await asyncio.create_subprocess_exec(
            *command, cwd=self.project_dir, env=env or os.environ.copy(),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            raise RuntimeError("固定更新命令超时")
        if process.returncode != 0:
            raise RuntimeError("固定更新命令失败")
        return stdout
