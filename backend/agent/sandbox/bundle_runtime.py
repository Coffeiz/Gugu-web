"""一体化镜像内置运行镜像的校验与本地导入。"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import threading
from pathlib import Path
from typing import Callable

from .docker_runtime import docker_environment
from .offline_bundle import (
    BundleManifest,
    BundleManifestError,
    load_bundle_manifest,
    validate_local_image,
)


DEFAULT_BUNDLE_DIRECTORY = Path("/opt/gugu/sandbox-bundle")
_ARCHIVE_NAME = "runtime-images.tar"
_HASH_CHUNK_SIZE = 1024 * 1024


def bundle_directory() -> Path:
    return Path(os.environ.get("GUGU_SANDBOX_BUNDLE_DIR", str(DEFAULT_BUNDLE_DIRECTORY)))


class EmbeddedBundleRuntime:
    """校验 app 镜像携带的 bundle，并只通过 docker load 导入本地归档。"""

    def __init__(
        self,
        directory: str | Path | None = None,
        *,
        docker_path: str | None = None,
        runner: Callable = subprocess.run,
    ):
        self.directory = Path(directory) if directory is not None else bundle_directory()
        self.docker_path = docker_path or shutil.which("docker")
        self.docker_env = docker_environment()
        self.docker_env.setdefault("DOCKER_HOST", "unix:///var/run/docker.sock")
        self.runner = runner
        self._lock = threading.RLock()
        self._manifest: BundleManifest | None = None
        self._bundle_fingerprint: tuple[int, ...] | None = None

    def load_verified_manifest(self) -> BundleManifest:
        manifest_path = self.directory / "manifest.json"
        archive_path = self.directory / _ARCHIVE_NAME
        try:
            if not stat.S_ISREG(manifest_path.lstat().st_mode):
                raise BundleManifestError("内置沙盒 bundle manifest 不是普通文件")
            if not stat.S_ISREG(archive_path.lstat().st_mode):
                raise BundleManifestError("内置沙盒运行镜像归档不是普通文件")
            manifest_stat = manifest_path.stat()
            archive_stat = archive_path.stat()
        except OSError as exc:
            raise BundleManifestError("内置沙盒 bundle 文件缺失或不可读") from exc

        fingerprint = (
            manifest_stat.st_ino,
            manifest_stat.st_size,
            manifest_stat.st_mtime_ns,
            archive_stat.st_ino,
            archive_stat.st_size,
            archive_stat.st_mtime_ns,
        )
        with self._lock:
            if self._manifest is not None and self._bundle_fingerprint == fingerprint:
                return self._manifest

            manifest = load_bundle_manifest(manifest_path)
            if manifest.schema_version != 2 or not manifest.archive_sha256:
                raise BundleManifestError("内置沙盒 bundle manifest 版本不受支持")
            if self._sha256(archive_path) != manifest.archive_sha256:
                raise BundleManifestError("内置沙盒运行镜像归档摘要不匹配")
            self._manifest = manifest
            self._bundle_fingerprint = fingerprint
            return manifest

    def ensure_images(self, *, timeout_seconds: float = 600.0) -> BundleManifest:
        """检查两个固定角色；缺少时只从已验摘要的本地归档导入。"""
        with self._lock:
            manifest = self.load_verified_manifest()
            if not self.docker_path:
                raise BundleManifestError("Docker CLI 不可用，内置沙盒镜像未就绪")

            daemon = self._run(("info",), timeout_seconds=10)
            if daemon.returncode != 0:
                raise BundleManifestError("Docker daemon 不可用，内置沙盒镜像未就绪")

            inspected = {image.role: self._inspect_image_id(image) for image in manifest.images}
            mismatched = [
                image for image in manifest.images
                if inspected[image.role] is not None and inspected[image.role] != image.image_id
            ]
            if mismatched:
                raise BundleManifestError("Docker daemon 中的内置沙盒镜像 ID 与 manifest 不匹配")

            if any(value is None for value in inspected.values()):
                archive_path = self.directory / _ARCHIVE_NAME
                loaded = self._run(("load", "--input", str(archive_path)), timeout_seconds=timeout_seconds)
                if loaded.returncode != 0:
                    raise BundleManifestError("无法从内置归档导入沙盒运行镜像")
                for image in manifest.images:
                    if self._inspect_image_id(image) != image.image_id:
                        raise BundleManifestError("导入后的沙盒镜像 ID 与 manifest 不匹配")
            return manifest

    def _run(self, args: tuple[str, ...], *, timeout_seconds: float):
        try:
            return self.runner(
                [self.docker_path, *args],
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                env=self.docker_env,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise BundleManifestError("Docker 沙盒运行镜像操作失败") from exc

    def _inspect_image_id(self, image) -> str | None:
        result = self._run(("image", "inspect", image.name), timeout_seconds=10)
        if result.returncode != 0:
            return None
        try:
            payload = json.loads(result.stdout)
        except (TypeError, ValueError) as exc:
            raise BundleManifestError("Docker 镜像 inspect 响应无效") from exc
        if isinstance(payload, dict):
            payload = [payload]
        if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
            raise BundleManifestError("Docker 镜像 inspect 响应无效")
        validate_local_image(
            image.name,
            image.digest,
            result.stdout,
            expected_image_id=image.image_id,
        )
        image_id = payload[0].get("Id")
        return image_id if isinstance(image_id, str) else None

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        try:
            with path.open("rb") as archive:
                while chunk := archive.read(_HASH_CHUNK_SIZE):
                    digest.update(chunk)
        except OSError as exc:
            raise BundleManifestError("无法读取内置沙盒运行镜像归档") from exc
        return "sha256:" + digest.hexdigest()
