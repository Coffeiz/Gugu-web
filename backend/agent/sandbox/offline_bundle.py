"""离线沙盒 bundle manifest 的解析与本地镜像校验。"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_BUNDLE_ROLES = frozenset({"sandbox", "egress-proxy"})


class BundleManifestError(ValueError):
    """bundle manifest 无效或本地镜像与 manifest 不一致。"""


@dataclass(frozen=True)
class BundleImage:
    name: str
    digest: str
    image_id: str | None = None
    role: str | None = None


@dataclass(frozen=True)
class BundleManifest:
    schema_version: int
    images: tuple[BundleImage, ...]
    archive_sha256: str | None = None

    def image_digest(self, image: str) -> str:
        return self.image(image).digest

    def image(self, image: str) -> BundleImage:
        return self._find_image(name=image)

    def image_for_role(self, role: str) -> BundleImage:
        return self._find_image(role=role)

    def _find_image(self, *, name: str | None = None, role: str | None = None) -> BundleImage:
        for item in self.images:
            if (name is not None and item.name == name) or (role is not None and item.role == role):
                return item
        if role is not None:
            raise BundleManifestError(f"bundle 未声明运行角色：{role}")
        if name is not None:
            raise BundleManifestError(f"bundle 未声明镜像：{name}")
        raise BundleManifestError(f"bundle 未声明运行角色：{role}")


def _require_digest(value: Any) -> str:
    if not isinstance(value, str) or not _DIGEST_RE.fullmatch(value):
        raise BundleManifestError("bundle 镜像 digest 无效")
    return value


def _parse_manifest_image(
    raw: Any,
    schema_version: int,
    names: set[str],
    roles: set[str],
) -> BundleImage:
    if not isinstance(raw, dict) or not isinstance(raw.get("name"), str) or not raw["name"].strip():
        raise BundleManifestError("bundle 镜像名称无效")
    name = raw["name"].strip()
    if name in names:
        raise BundleManifestError(f"bundle 存在重复镜像：{name}")
    names.add(name)
    image_id = raw.get("image_id")
    if image_id is not None and (not isinstance(image_id, str) or not _DIGEST_RE.fullmatch(image_id)):
        raise BundleManifestError("bundle 镜像 image_id 无效")
    role = raw.get("role")
    if schema_version == 2:
        if not isinstance(role, str) or role not in _BUNDLE_ROLES or role in roles:
            raise BundleManifestError("bundle 运行角色缺失、无效或重复")
        if image_id is None:
            raise BundleManifestError("bundle 镜像 image_id 缺失")
        roles.add(role)
    elif role is not None:
        raise BundleManifestError("schema v1 不支持运行角色")
    return BundleImage(
        name=name,
        digest=_require_digest(raw.get("digest")),
        image_id=image_id,
        role=role,
    )


def _parse_manifest_images(raw_images: list, schema_version: int) -> tuple[BundleImage, ...]:
    names: set[str] = set()
    roles: set[str] = set()
    images = tuple(
        _parse_manifest_image(raw, schema_version, names, roles)
        for raw in raw_images
    )
    if schema_version == 2 and roles != _BUNDLE_ROLES:
        raise BundleManifestError("bundle 必须同时包含 sandbox 与 egress-proxy 镜像")
    return images


def load_bundle_manifest(path: Path) -> BundleManifest:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BundleManifestError(f"无法读取 bundle manifest：{path}") from exc
    if (
        not isinstance(payload, dict)
        or type(payload.get("schema_version")) is not int
        or payload.get("schema_version") not in {1, 2}
    ):
        raise BundleManifestError("bundle manifest schema_version 无效")
    schema_version = payload["schema_version"]
    archive_sha256 = None
    if schema_version == 2:
        archive_sha256 = payload.get("archive_sha256")
        if not isinstance(archive_sha256, str) or not _DIGEST_RE.fullmatch(archive_sha256):
            raise BundleManifestError("bundle 归档摘要无效")
    raw_images = payload.get("images")
    if not isinstance(raw_images, list) or not raw_images:
        raise BundleManifestError("bundle manifest 未声明镜像")
    return BundleManifest(
        schema_version=schema_version,
        images=_parse_manifest_images(raw_images, schema_version),
        archive_sha256=archive_sha256,
    )


def validate_local_image(
    image: str,
    expected_digest: str,
    inspect_json: str,
    *,
    expected_image_id: str | None = None,
) -> None:
    """校验 Docker image inspect 的 RepoDigests 或导入后的 image ID。"""
    expected = _require_digest(expected_digest)
    try:
        repo_digests = json.loads(inspect_json)
    except json.JSONDecodeError as exc:
        raise BundleManifestError("本地镜像 inspect 结果不是有效 JSON") from exc
    if isinstance(repo_digests, dict):
        repo_digests = [repo_digests]
    matches_digest = any(
        isinstance(value, dict)
        and any(isinstance(item, str) and item.endswith("@" + expected) for item in value.get("RepoDigests", []))
        for value in repo_digests
    ) if isinstance(repo_digests, list) else False
    accepted_image_ids = {expected}
    if expected_image_id:
        accepted_image_ids.add(expected_image_id)
    matches_image_id = any(
        isinstance(value, dict) and value.get("Id") in accepted_image_ids for value in repo_digests
    ) if isinstance(repo_digests, list) else False
    if not (matches_digest or matches_image_id):
        raise BundleManifestError(f"镜像 digest 不匹配：{image}")
