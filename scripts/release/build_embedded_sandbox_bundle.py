#!/usr/bin/env python3
"""从已经构建、验证的本地镜像生成 embedded runtime bundle。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable


_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class BundleBuildError(ValueError):
    """不能从指定的已验证本地镜像构建可校验 bundle。"""


@dataclass(frozen=True)
class BundleImageSpec:
    role: str
    name: str
    digest: str


@dataclass(frozen=True)
class BundleBuildSpec:
    output: Path
    manifest_path: Path
    images: tuple[BundleImageSpec, ...]
    source_revision: str | None = None


def _inspect_image(image: str, digest: str, docker: str, run: Callable) -> None:
    if not _DIGEST_RE.fullmatch(digest):
        raise BundleBuildError(f"镜像 digest 无效：{image}")
    result = run(
        [docker, "image", "inspect", image],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise BundleBuildError(f"本地缺少待打包镜像：{image}")
    try:
        payload = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as exc:
        raise BundleBuildError(f"Docker inspect 响应无效：{image}") from exc
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        raise BundleBuildError(f"Docker inspect 响应无效：{image}")
    image_info = payload[0]
    if not isinstance(image_info.get("Id"), str) or not _DIGEST_RE.fullmatch(image_info["Id"]):
        raise BundleBuildError(f"本地镜像 ID 无效：{image}")
    repo_digests = image_info.get("RepoDigests") or []
    if not isinstance(repo_digests, list) or any(not isinstance(item, str) for item in repo_digests):
        raise BundleBuildError(f"本地镜像 RepoDigest 无效：{image}")
    matches_repo_digest = any(item.endswith("@" + digest) for item in repo_digests)
    if not matches_repo_digest and image_info["Id"] != digest:
        raise BundleBuildError(f"本地镜像摘要与 RepoDigest/image ID 不匹配：{image}")


def _archive_record(archive_manifest: list, image: BundleImageSpec) -> dict:
    matches = [
        record for record in archive_manifest
        if (
            isinstance(record, dict)
            and isinstance(record.get("RepoTags"), list)
            and image.name in record["RepoTags"]
        )
    ]
    if len(matches) != 1:
        raise BundleBuildError(f"Docker save 归档未唯一包含镜像：{image.name}")
    return matches[0]


def _archive_path(value: object, *, image: BundleImageSpec, kind: str) -> str:
    if not isinstance(value, str) or not value:
        raise BundleBuildError(f"Docker save 镜像 {kind} 路径无效：{image.name}")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or not path.parts
        or any(part in {"", ".", ".."} for part in path.parts)
        or path.as_posix() != value
    ):
        raise BundleBuildError(f"Docker save 镜像 {kind} 路径无效：{image.name}")
    return value


def _archive_file(archive: tarfile.TarFile, members: dict[str, tarfile.TarInfo], path: str, image: BundleImageSpec, kind: str):
    member = members.get(path)
    if member is None or not member.isfile():
        raise BundleBuildError(f"Docker save 镜像 {kind} 缺失：{image.name}")
    file = archive.extractfile(member)
    if file is None:
        raise BundleBuildError(f"Docker save 镜像 {kind} 缺失：{image.name}")
    return file


def _archive_image_id(archive: tarfile.TarFile, members: dict[str, tarfile.TarInfo], record: dict, image: BundleImageSpec) -> str:
    config = _archive_path(record.get("Config"), image=image, kind="config")
    config_file = _archive_file(archive, members, config, image, "config")
    with config_file:
        image_id = "sha256:" + hashlib.sha256(config_file.read()).hexdigest()

    layers = record.get("Layers")
    if not isinstance(layers, list):
        raise BundleBuildError(f"Docker save 镜像 layers 无效：{image.name}")
    for layer in layers:
        layer_path = _archive_path(layer, image=image, kind="layer")
        _archive_file(archive, members, layer_path, image, "layer")
    return image_id


def _archive_image_ids(archive_path: Path, images: tuple[BundleImageSpec, ...]) -> dict[str, str]:
    try:
        with tarfile.open(archive_path, "r") as archive:
            members = {member.name: member for member in archive.getmembers()}
            manifest_file = archive.extractfile("manifest.json")
            if manifest_file is None:
                raise BundleBuildError("Docker save 归档缺少 manifest.json")
            with manifest_file:
                archive_manifest = json.loads(manifest_file.read())
            if not isinstance(archive_manifest, list):
                raise BundleBuildError("Docker save manifest 格式无效")

            return {
                image.name: _archive_image_id(
                    archive,
                    members,
                    _archive_record(archive_manifest, image),
                    image,
                )
                for image in images
            }
    except (OSError, KeyError, tarfile.TarError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BundleBuildError("Docker save 归档无效") from exc


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as archive:
        while chunk := archive.read(1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _temporary_path(destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    os.close(descriptor)
    return Path(name)


def build_bundle(
    spec: BundleBuildSpec,
    *,
    run: Callable = subprocess.run,
) -> None:
    output = spec.output
    manifest_path = spec.manifest_path
    if output.resolve() == manifest_path.resolve():
        raise BundleBuildError("bundle 归档与 manifest 不能使用同一路径")
    docker = shutil.which("docker")
    if docker is None:
        raise BundleBuildError("未找到 Docker CLI")
    images = spec.images
    if (
        tuple(image.role for image in images) != ("sandbox", "egress-proxy")
        or any(not image.name.strip() for image in images)
        or len({image.name for image in images}) != len(images)
    ):
        raise BundleBuildError("bundle 镜像引用无效或重复")
    if spec.source_revision is not None and not re.fullmatch(r"[0-9a-f]{40,64}", spec.source_revision):
        raise BundleBuildError("bundle 源码提交 SHA 无效")

    for image in images:
        _inspect_image(image.name, image.digest, docker, run)

    archive_tmp = _temporary_path(output)
    manifest_tmp = _temporary_path(manifest_path)
    try:
        result = run(
            [docker, "save", "--output", str(archive_tmp), *(image.name for image in images)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise BundleBuildError("Docker 无法导出 embedded runtime 镜像")
        image_ids = _archive_image_ids(archive_tmp, images)
        payload = {
            "schema_version": 2,
            "archive_sha256": _sha256(archive_tmp),
            **({"source_revision": spec.source_revision} if spec.source_revision else {}),
            "images": [
                {
                    "role": image.role,
                    "name": image.name,
                    "digest": image.digest,
                    "image_id": image_ids[image.name],
                }
                for image in images
            ],
        }
        manifest_tmp.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(archive_tmp, output)
        os.replace(manifest_tmp, manifest_path)
    except OSError as exc:
        raise BundleBuildError("无法写入 embedded runtime bundle") from exc
    finally:
        archive_tmp.unlink(missing_ok=True)
        manifest_tmp.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--sandbox-image", required=True)
    parser.add_argument("--sandbox-digest", required=True)
    parser.add_argument("--egress-proxy-image", required=True)
    parser.add_argument("--egress-proxy-digest", required=True)
    parser.add_argument("--source-revision")
    args = parser.parse_args(argv)
    try:
        build_bundle(
            BundleBuildSpec(
                output=args.output,
                manifest_path=args.manifest,
                images=(
                    BundleImageSpec("sandbox", args.sandbox_image, args.sandbox_digest),
                    BundleImageSpec("egress-proxy", args.egress_proxy_image, args.egress_proxy_digest),
                ),
                source_revision=args.source_revision,
            ),
        )
    except BundleBuildError as exc:
        parser.exit(1, f"错误：{exc}\n")
    print(f"embedded runtime bundle 已生成：{args.output}")
    print(f"embedded runtime manifest 已生成：{args.manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
