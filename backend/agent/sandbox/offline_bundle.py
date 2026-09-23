"""离线沙盒 bundle manifest 的解析与本地镜像校验。"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class BundleManifestError(ValueError):
    """bundle manifest 无效或本地镜像与 manifest 不一致。"""


@dataclass(frozen=True)
class BundleImage:
    name: str
    digest: str
    image_id: str | None = None


@dataclass(frozen=True)
class BundleManifest:
    schema_version: int
    images: tuple[BundleImage, ...]

    def image_digest(self, image: str) -> str:
        for item in self.images:
            if item.name == image:
                return item.digest
        raise BundleManifestError(f"bundle 未声明镜像：{image}")

    def image(self, image: str) -> BundleImage:
        for item in self.images:
            if item.name == image:
                return item
        raise BundleManifestError(f"bundle 未声明镜像：{image}")


def _require_digest(value: Any) -> str:
    if not isinstance(value, str) or not _DIGEST_RE.fullmatch(value):
        raise BundleManifestError("bundle 镜像 digest 无效")
    return value


def load_bundle_manifest(path: Path) -> BundleManifest:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BundleManifestError(f"无法读取 bundle manifest：{path}") from exc
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise BundleManifestError("bundle manifest schema_version 无效")
    raw_images = payload.get("images")
    if not isinstance(raw_images, list) or not raw_images:
        raise BundleManifestError("bundle manifest 未声明镜像")
    images: list[BundleImage] = []
    names: set[str] = set()
    for raw in raw_images:
        if not isinstance(raw, dict) or not isinstance(raw.get("name"), str) or not raw["name"].strip():
            raise BundleManifestError("bundle 镜像名称无效")
        name = raw["name"].strip()
        if name in names:
            raise BundleManifestError(f"bundle 存在重复镜像：{name}")
        names.add(name)
        image_id = raw.get("image_id")
        if image_id is not None and (not isinstance(image_id, str) or not _DIGEST_RE.fullmatch(image_id)):
            raise BundleManifestError("bundle 镜像 image_id 无效")
        images.append(BundleImage(name=name, digest=_require_digest(raw.get("digest")), image_id=image_id))
    return BundleManifest(schema_version=1, images=tuple(images))


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
    matches_image_id = bool(expected_image_id) and any(
        isinstance(value, dict) and value.get("Id") == expected_image_id for value in repo_digests
    ) if isinstance(repo_digests, list) else False
    if not (matches_digest or matches_image_id):
        raise BundleManifestError(f"镜像 digest 不匹配：{image}")
