"""不依赖宿主 Docker Socket 的一体化应用包更新器。"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from updater.app_bundle_runtime import (
    DATA_ROOT,
    IMAGE_APP_ROOT,
    PENDING_FILE,
    PREVIOUS_FILE,
    AppBundleError,
    activate_installed_release,
    current_app_info,
    install_archive,
    rollback_pending_app,
    supports_app_bundle_updates,
)
from updater.daemon import (
    ALLOWED_REDIRECT_HOSTS,
    CHALLENGE_TTL_SECONDS,
    VERSION_RE,
    _utc_now,
    _version_key,
)
from updater.sandbox_signature import COSIGN_IDENTITY_REGEXP, COSIGN_OIDC_ISSUER


logger = logging.getLogger("gugu.updater.app_bundle")
MANIFEST_NAME = "update-manifest.json"
MAX_MANIFEST_BYTES = 1_500_000
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_SIGNATURE_BYTES = 2_000_000
APP_IMAGE_RE = re.compile(r"^(?:docker\.io|ghcr\.io)/coffeiz/gugu-web@sha256:[0-9a-f]{64}$")
SPLIT_IMAGE_RES = {
    "backend_image": re.compile(r"^(?:docker\.io|ghcr\.io)/coffeiz/gugu-web-backend@sha256:[0-9a-f]{64}$"),
    "frontend_image": re.compile(r"^(?:docker\.io|ghcr\.io)/coffeiz/gugu-web-frontend@sha256:[0-9a-f]{64}$"),
}


class _SafeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urlparse(newurl)
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_REDIRECT_HOSTS:
            raise URLError("redirect outside allowlist")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class AppBundleUpdater:
    def __init__(self, *, state_dir: Path | None = None) -> None:
        self.state_dir = state_dir or (Path(os.getenv("GUGU_UPDATER_STATE_DIR", "/data/updater")) / "app-bundle")
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_file = self.state_dir / "state.json"
        self._lock = asyncio.Lock()
        self.state = self._read_state()

    def _read_state(self) -> dict[str, Any]:
        if not self.state_file.exists():
            return {"schema": 1, "candidate": None, "task": None, "history": [], "challenges": []}
        try:
            state = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise AppBundleError("应用更新状态损坏，拒绝覆盖") from exc
        if not isinstance(state, dict) or state.get("schema") != 1:
            raise AppBundleError("应用更新状态格式无效")
        state.setdefault("candidate", None)
        state.setdefault("task", None)
        state.setdefault("history", [])
        state.setdefault("challenges", [])
        return state

    def _save(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.state_file.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(self.state, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.state_file)

    @staticmethod
    def _current() -> dict[str, str]:
        info = current_app_info()
        return {"version": info["version"], "runtime_contract": info["runtime_contract"]}

    @staticmethod
    def _is_newer(candidate: str, current: str) -> bool:
        try:
            return _version_key(candidate) > _version_key(current)
        except (ValueError, AppBundleError):
            # 旧镜像没有版本元数据时允许进入预检，由最低版本/contract 项明确阻断。
            return current == "unknown"

    @staticmethod
    def _public_candidate(value: Any) -> dict[str, Any] | None:
        if not isinstance(value, dict):
            return None
        fields = (
            "version", "channel", "minimum_version", "architectures", "database_migration",
            "release_notes_url", "rollback_supported", "git_sha", "published_at",
            "manifest_sha256", "runtime_contract", "archive_size",
        )
        return {key: value[key] for key in fields if key in value}

    async def dispatch(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        handlers = {
            "status": self.status,
            "check": self.check,
            "preflight": self.preflight,
            "start": self.start,
            "rollback_preflight": self.rollback_preflight,
            "rollback": self.rollback,
        }
        handler = handlers.get(method)
        if handler is None:
            raise ValueError("不支持的应用更新动作")
        return await handler(params)

    def _read_url(self, url: str, limit: int) -> bytes:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_REDIRECT_HOSTS:
            raise AppBundleError("应用更新源不受支持")
        opener = build_opener(_SafeRedirectHandler())
        request = Request(url, headers={"User-Agent": "Gugu-App-Updater", "Accept": "application/octet-stream"})
        with opener.open(request, timeout=30) as response:
            final = urlparse(response.geturl())
            if final.scheme != "https" or final.hostname not in ALLOWED_REDIRECT_HOSTS:
                raise AppBundleError("应用更新源重定向不受支持")
            payload = response.read(limit + 1)
        if len(payload) > limit:
            raise AppBundleError("应用更新资源超过大小限制")
        return payload

    def _download_url(self, url: str, target: Path, limit: int) -> int:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_REDIRECT_HOSTS:
            raise AppBundleError("应用更新源不受支持")
        opener = build_opener(_SafeRedirectHandler())
        request = Request(url, headers={"User-Agent": "Gugu-App-Updater", "Accept": "application/octet-stream"})
        total = 0
        with opener.open(request, timeout=60) as response, target.open("wb") as output:
            final = urlparse(response.geturl())
            if final.scheme != "https" or final.hostname not in ALLOWED_REDIRECT_HOSTS:
                raise AppBundleError("应用更新源重定向不受支持")
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > limit:
                    raise AppBundleError("应用更新资源超过大小限制")
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        return total

    @staticmethod
    def _release_asset(version: str, name: str) -> str:
        if not VERSION_RE.fullmatch(version) or not re.fullmatch(r"gugu-app-[A-Za-z0-9.+-]+\.(?:tar\.gz|sigstore\.json)", name):
            raise AppBundleError("应用更新资源标识无效")
        return f"https://github.com/Coffeiz/Gugu-web/releases/download/{quote(version, safe='v.-+')}/{name}"

    def _validate_manifest(self, payload: bytes) -> dict[str, Any]:
        try:
            manifest = json.loads(payload)
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise AppBundleError("Release 更新清单格式无效") from exc
        if not isinstance(manifest, dict) or manifest.get("schema_version") != 3:
            raise AppBundleError("Release 更新清单版本不受支持")
        allowed_fields = {
            "schema_version", "version", "channel", "minimum_version", "app_image", "split_images",
            "architectures", "database_migration", "release_notes_url", "rollback_supported",
            "git_sha", "published_at", "app_bundle",
        }
        required_fields = allowed_fields - {"git_sha", "published_at"}
        if not required_fields.issubset(manifest) or set(manifest) - allowed_fields:
            raise AppBundleError("Release 更新清单字段不完整或包含未知字段")
        version = manifest.get("version")
        bundle = manifest.get("app_bundle")
        if manifest.get("channel") != "stable" or not isinstance(version, str) or not VERSION_RE.fullmatch(version):
            raise AppBundleError("Release 版本或渠道不受支持")
        if not isinstance(manifest.get("minimum_version"), str) or not VERSION_RE.fullmatch(manifest["minimum_version"]):
            raise AppBundleError("Release 最低版本声明无效")
        if _version_key(manifest["minimum_version"]) > _version_key(version):
            raise AppBundleError("Release 最低版本不能高于目标版本")
        if not APP_IMAGE_RE.fullmatch(str(manifest.get("app_image") or "")):
            raise AppBundleError("Release app 镜像不在官方 digest 白名单内")
        split_images = manifest.get("split_images")
        if not isinstance(split_images, dict) or set(split_images) != set(SPLIT_IMAGE_RES):
            raise AppBundleError("Release split 镜像组不完整")
        if any(not pattern.fullmatch(str(split_images.get(key) or "")) for key, pattern in SPLIT_IMAGE_RES.items()):
            raise AppBundleError("Release split 镜像不在官方 digest 白名单内")
        if not isinstance(manifest.get("architectures"), list) or "linux/amd64" not in manifest["architectures"]:
            raise AppBundleError("Release 未发布当前平台架构")
        if not isinstance(manifest.get("database_migration"), bool) or not isinstance(manifest.get("rollback_supported"), bool):
            raise AppBundleError("Release 数据迁移或回滚声明无效")
        if manifest.get("release_notes_url") != f"https://github.com/Coffeiz/Gugu-web/releases/tag/{version}":
            raise AppBundleError("Release 说明链接无效")
        if "git_sha" in manifest and (not isinstance(manifest["git_sha"], str) or not re.fullmatch(r"[0-9a-f]{40}", manifest["git_sha"])):
            raise AppBundleError("Release git_sha 格式无效")
        if "published_at" in manifest and (not isinstance(manifest["published_at"], str) or not manifest["published_at"]):
            raise AppBundleError("Release 发布时间无效")
        if not isinstance(bundle, dict):
            raise AppBundleError("此 Release 未发布单容器应用包")
        archive_name = bundle.get("archive")
        signature_name = bundle.get("signature_bundle")
        digest = bundle.get("sha256")
        runtime_contract = bundle.get("runtime_contract")
        archive_size = bundle.get("size")
        unpacked_size = bundle.get("unpacked_size")
        if archive_name != f"gugu-app-{version}.tar.gz" or signature_name != f"gugu-app-{version}.sigstore.json":
            raise AppBundleError("应用包发布资源名称不匹配")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise AppBundleError("应用包摘要格式无效")
        if not isinstance(runtime_contract, str) or not re.fullmatch(r"[a-zA-Z0-9._-]{1,64}", runtime_contract):
            raise AppBundleError("应用包 runtime contract 无效")
        if not isinstance(archive_size, int) or isinstance(archive_size, bool) or not 0 < archive_size <= MAX_ARCHIVE_BYTES:
            raise AppBundleError("应用包大小声明无效")
        if not isinstance(unpacked_size, int) or isinstance(unpacked_size, bool) or not 0 < unpacked_size <= 1024 * 1024 * 1024:
            raise AppBundleError("应用包解压大小声明无效")
        if set(bundle) != {"archive", "signature_bundle", "sha256", "runtime_contract", "size", "unpacked_size"}:
            raise AppBundleError("应用包清单字段不完整或包含未知字段")
        result = dict(manifest)
        result["app_bundle"] = dict(bundle)
        result["manifest_sha256"] = hashlib.sha256(payload).hexdigest()
        result["archive_size"] = archive_size
        result["checked_at"] = _utc_now()
        return result

    async def status(self, _params: dict[str, Any]) -> dict[str, Any]:
        if not supports_app_bundle_updates():
            return self._deployment(False, "app_bundle_unavailable", "当前容器未完成应用包运行目录初始化；请由 Docker 管理器更新整镜像。")
        await self._finish_restarted_task_if_ready()
        current = self._current()
        candidate = self.state.get("candidate")
        task = self.state.get("task")
        return {
            **self._deployment(True, "ready", "此单容器可在线更新 Gugu 应用包；基础镜像由 NAS 的 Docker 管理器更新。"),
            "current": current,
            "candidate": self._public_candidate(candidate),
            "has_update": bool(isinstance(candidate, dict) and self._is_newer(candidate["version"], current["version"])),
            "task": self._public_task(task),
            "history": [self._public_task(row) for row in self.state["history"][-20:]],
        }

    @staticmethod
    def _deployment(enabled: bool, reason_code: str, reason: str) -> dict[str, Any]:
        return {
            "mode": "standalone_app_bundle", "enabled": enabled,
            "capability": "one_click" if enabled else "manual",
            "reason_code": reason_code, "reason": reason,
        }

    async def check(self, _params: dict[str, Any]) -> dict[str, Any]:
        try:
            payload = await asyncio.to_thread(
                self._read_url,
                "https://github.com/Coffeiz/Gugu-web/releases/latest/download/" + MANIFEST_NAME,
                MAX_MANIFEST_BYTES,
            )
        except (OSError, TimeoutError) as exc:
            raise RuntimeError("无法访问 GitHub Release 更新源") from exc
        candidate = self._validate_manifest(payload)
        current = self._current()
        async with self._lock:
            self.state["candidate"] = candidate
            self._save()
        return {
            "has_update": self._is_newer(candidate["version"], current["version"]),
            "current": current,
            "candidate": self._public_candidate(candidate),
        }

    async def preflight(self, params: dict[str, Any]) -> dict[str, Any]:
        candidate = self.state.get("candidate")
        if not isinstance(candidate, dict):
            raise AppBundleError("请先检查应用更新")
        current = self._current()
        bundle = candidate["app_bundle"]
        try:
            minimum_ok = _version_key(current["version"]) >= _version_key(candidate["minimum_version"])
        except (ValueError, AppBundleError):
            minimum_ok = False
        has_update = self._is_newer(candidate["version"], current["version"])
        checks = [
            {"key": "minimum_version", "ok": minimum_ok,
             "detail": "当前版本满足升级要求" if minimum_ok else f"此更新要求先升级到 {candidate['minimum_version']} 或更高版本"},
            {"key": "runtime_contract", "ok": bundle["runtime_contract"] == current["runtime_contract"],
             "detail": "当前镜像运行时与应用包兼容" if bundle["runtime_contract"] == current["runtime_contract"] else "运行时不兼容，请先由 NAS Docker 管理器更新整镜像"},
            {"key": "persistent_app_dir", "ok": supports_app_bundle_updates(), "detail": "持久化应用目录已就绪"},
            {"key": "disk", "ok": shutil.disk_usage(DATA_ROOT).free >= bundle["size"] + bundle["unpacked_size"] + 64 * 1024 * 1024, "detail": "检查应用包暂存空间"},
            {"key": "integrity", "ok": True, "detail": "Release 清单摘要已固定；下载后将验证 Cosign 签名与文件摘要"},
        ]
        ready = all(item["ok"] for item in checks) and has_update
        result: dict[str, Any] = {
            "ready": ready, "has_update": has_update,
            "candidate": self._public_candidate(candidate), "current": current, "checks": checks,
        }
        if ready:
            token = secrets.token_urlsafe(48)
            challenge = {
                "sha256": hashlib.sha256(token.encode()).hexdigest(),
                "operator": self._operator(params.get("operator")),
                "version": candidate["version"],
                "manifest_sha256": candidate["manifest_sha256"],
                "expires_at": time.time() + CHALLENGE_TTL_SECONDS,
            }
            self.state["challenges"] = [item for item in self.state["challenges"] if item.get("expires_at", 0) > time.time()]
            self.state["challenges"].append(challenge)
            self._save()
            result["challenge"] = token
            result["challenge_expires_at"] = datetime.fromtimestamp(challenge["expires_at"], timezone.utc).isoformat()
        return result

    async def start(self, params: dict[str, Any]) -> dict[str, Any]:
        candidate = self.state.get("candidate")
        if not isinstance(candidate, dict):
            raise AppBundleError("更新清单已失效，请重新检查")
        digest = str(params.get("manifest_sha256") or "")
        if not hmac.compare_digest(digest, candidate["manifest_sha256"]):
            raise AppBundleError("更新清单已变化，请重新预检")
        operator = self._operator(params.get("operator"))
        token = str(params.get("challenge") or "")
        token_digest = hashlib.sha256(token.encode()).hexdigest()
        match = next((item for item in self.state["challenges"] if hmac.compare_digest(item.get("sha256", ""), token_digest)), None)
        if not match or match.get("operator") != operator or match.get("version") != candidate["version"] or match.get("manifest_sha256") != digest:
            raise AppBundleError("更新确认已失效，请重新预检")
        if match.get("expires_at", 0) <= time.time():
            raise AppBundleError("更新确认已过期，请重新预检")
        if self.state.get("task", {}).get("status") in {"pending", "downloading", "verifying", "installing", "restarting", "health_checking", "rolling_back"}:
            raise AppBundleError("已有应用更新任务正在执行")
        current = self._current()
        task = {
            "id": str(uuid.uuid4()), "operation": "update", "version": candidate["version"],
            "previous_version": current["version"], "status": "pending", "stage": "pending",
            "progress": 0, "message": "应用包更新已排队", "requested_by": operator,
            "created_at": _utc_now(), "updated_at": _utc_now(), "events": [],
            "rollback_supported": True,
        }
        self.state["challenges"].remove(match)
        self.state["task"] = task
        self.state["history"].append(dict(task))
        self.state["history"] = self.state["history"][-20:]
        self._save()
        asyncio.create_task(self._run_update(task["id"], dict(candidate)))
        return {"accepted": True, "task": self._public_task(task)}

    async def _run_update(self, task_id: str, candidate: dict[str, Any]) -> None:
        temp_dir = Path(tempfile.mkdtemp(prefix="app-bundle-", dir=self.state_dir))
        activated = False
        try:
            await self._set_task(task_id, "downloading", "downloading", 15, "正在下载已签名的应用包")
            bundle = candidate["app_bundle"]
            if bundle["runtime_contract"] != self._current()["runtime_contract"]:
                raise AppBundleError("应用包与当前镜像运行时不兼容")
            archive = temp_dir / bundle["archive"]
            signature = temp_dir / bundle["signature_bundle"]
            archive_size = await asyncio.to_thread(self._download_url, self._release_asset(candidate["version"], bundle["archive"]), archive, MAX_ARCHIVE_BYTES)
            await asyncio.to_thread(self._download_url, self._release_asset(candidate["version"], bundle["signature_bundle"]), signature, MAX_SIGNATURE_BYTES)
            if archive_size != bundle["size"]:
                raise AppBundleError("应用包大小与清单声明不一致")
            await self._set_task(task_id, "verifying", "verifying", 35, "正在验证应用包签名和摘要")
            await asyncio.to_thread(self._verify_signature, archive, signature)
            await self._set_task(task_id, "installing", "installing", 60, "签名通过，正在安全暂存应用文件")
            installed = await asyncio.to_thread(
                install_archive, archive, expected_sha256=bundle["sha256"],
                version=candidate["version"], runtime_contract=bundle["runtime_contract"],
            )
            self.state["previous_version"] = self._current()["version"]
            self._save()
            activated = True
            await asyncio.to_thread(activate_installed_release, installed)
            await self._set_task(task_id, "restarting", "restarting", 80, "应用文件已原子切换，正在重启容器内服务")
            await self._signal_restart()
        except Exception as exc:
            if activated:
                try:
                    await asyncio.to_thread(rollback_pending_app)
                except Exception as rollback_exc:
                    logger.error("application bundle rollback failed task_id=%s error_type=%s", task_id, type(rollback_exc).__name__)
            logger.warning("application bundle update failed task_id=%s error_type=%s", task_id, type(exc).__name__)
            await self._set_task(task_id, "failed", "failed", 100, "应用包更新失败，当前版本保持不变", type(exc).__name__)
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    @staticmethod
    def _verify_signature(archive: Path, signature: Path) -> None:
        cosign = shutil.which("cosign")
        if not cosign:
            raise AppBundleError("镜像缺少 Cosign 验签程序，已阻止应用包更新")
        result = subprocess.run(
            [cosign, "verify-blob", "--bundle", str(signature),
             "--certificate-identity-regexp", COSIGN_IDENTITY_REGEXP,
             "--certificate-oidc-issuer", COSIGN_OIDC_ISSUER, str(archive)],
            capture_output=True, text=True, timeout=300, check=False,
        )
        if result.returncode != 0:
            raise AppBundleError("应用包发布签名校验失败")

    async def _set_task(self, task_id: str, status: str, stage: str, progress: int, message: str, failure_code: str | None = None) -> None:
        async with self._lock:
            task = self.state.get("task")
            if not isinstance(task, dict) or task.get("id") != task_id:
                return
            task.update({"status": status, "stage": stage, "progress": progress, "message": message,
                         "failure_code": failure_code, "updated_at": _utc_now()})
            task.setdefault("events", []).append({"stage": stage, "at": _utc_now()})
            self._replace_history(task)
            self._save()

    async def _finish_restarted_task_if_ready(self) -> None:
        task = self.state.get("task")
        if not isinstance(task, dict) or task.get("status") not in {"restarting", "health_checking"}:
            return
        try:
            current = self._current()
        except AppBundleError:
            return
        if current["version"] != task.get("version"):
            if not PENDING_FILE.exists():
                task.update({"status": "failed", "stage": "failed", "progress": 100,
                             "message": "新应用未通过健康检查，已恢复上一应用代码版本。",
                             "failure_code": "health_check_failed", "updated_at": _utc_now(),
                             "completed_at": _utc_now()})
                self._replace_history(task)
                self._save()
            return
        if PENDING_FILE.exists():
            return
        task.update({"status": "succeeded", "stage": "succeeded", "progress": 100,
                     "message": "应用包更新完成，容器内服务健康检查通过。",
                     "updated_at": _utc_now(), "completed_at": _utc_now(), "rollback_available": True})
        self._replace_history(task)
        self._save()

    def _replace_history(self, task: dict[str, Any]) -> None:
        for index, row in enumerate(self.state["history"]):
            if isinstance(row, dict) and row.get("id") == task.get("id"):
                self.state["history"][index] = dict(task)
                break

    @staticmethod
    def _operator(value: Any) -> str:
        operator = str(value or "").strip()
        if not operator or len(operator) > 100:
            raise ValueError("操作者标识无效")
        return operator

    @staticmethod
    def _public_task(value: Any) -> dict[str, Any] | None:
        if not isinstance(value, dict):
            return None
        return {key: item for key, item in value.items() if key not in {"manifest_sha256", "archive_path"}}

    async def rollback_preflight(self, params: dict[str, Any]) -> dict[str, Any]:
        try:
            previous = json.loads(PREVIOUS_FILE.read_text(encoding="utf-8"))
            previous_path = Path(str(previous["path"])).resolve(strict=True)
            current_info = self._current()
            trusted_releases = (DATA_ROOT / "releases").resolve()
            trusted_image = IMAGE_APP_ROOT.resolve()
            ready = (
                previous_path.is_dir()
                and (previous_path == trusted_image or previous_path.parent == trusted_releases)
                and previous.get("version") == self.state.get("previous_version")
                and previous.get("version") != current_info["version"]
            )
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            previous = None
            previous_path = None
            ready = False
        result = {"ready": ready, "target_version": self.state.get("previous_version", ""),
                  "detail": "可恢复上一应用代码版本；数据库迁移不会回滚。" if ready else "没有可用的上一应用代码版本。"}
        if ready:
            token = secrets.token_urlsafe(48)
            self.state["rollback_challenge"] = {
                "sha256": hashlib.sha256(token.encode()).hexdigest(),
                "operator": self._operator(params.get("operator")),
                "expires_at": time.time() + CHALLENGE_TTL_SECONDS,
            }
            self._save()
            result["challenge"] = token
        return result

    async def rollback(self, params: dict[str, Any]) -> dict[str, Any]:
        challenge = self.state.get("rollback_challenge")
        token_hash = hashlib.sha256(str(params.get("challenge") or "").encode()).hexdigest()
        operator = self._operator(params.get("operator"))
        if not isinstance(challenge, dict) or not hmac.compare_digest(challenge.get("sha256", ""), token_hash):
            raise AppBundleError("应用回滚确认已失效")
        if challenge.get("operator") != operator or challenge.get("expires_at", 0) <= time.time():
            raise AppBundleError("应用回滚确认已过期或操作者不匹配")
        target_version = str(self.state.get("previous_version") or "")
        previous = json.loads(PREVIOUS_FILE.read_text(encoding="utf-8"))
        if previous.get("version") != target_version:
            raise AppBundleError("上一应用版本记录与回滚目标不匹配")
        target = Path(str(previous["path"])).resolve(strict=True)
        current_version = self._current()["version"]
        info = await asyncio.to_thread(activate_installed_release, target)
        task = {
            "id": str(uuid.uuid4()), "operation": "rollback", "version": info["version"],
            "status": "restarting", "stage": "restarting", "progress": 80,
            "message": "正在恢复上一应用代码版本", "requested_by": operator,
            "created_at": _utc_now(), "updated_at": _utc_now(), "events": [],
            "rollback_supported": True, "rollback_available": False,
        }
        self.state["task"] = task
        self.state["history"].append(dict(task))
        self.state["history"] = self.state["history"][-20:]
        self.state["previous_version"] = current_version
        self.state.pop("rollback_challenge", None)
        self._save()
        asyncio.create_task(self._signal_restart())
        return {"accepted": True, "task": self._public_task(task)}

    async def _signal_restart(self) -> None:
        await asyncio.sleep(2)
        import signal

        os.kill(1, signal.SIGHUP)
