#!/usr/bin/env python3
"""验证 bundle 组装镜像只新增一层且保留 app 配置。"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
import uuid
from typing import Callable


_BUNDLE_SMOKE = (
    "import json; from pathlib import Path; "
    "from agent.sandbox.bundle_runtime import EmbeddedBundleRuntime; "
    "m = EmbeddedBundleRuntime().load_verified_manifest(); "
    "assert m.schema_version == 2; "
    "assert {i.role for i in m.images} == {'sandbox', 'egress-proxy'}; "
    "raw = json.loads(Path('/opt/gugu/sandbox-bundle/manifest.json').read_text()); "
    "print(json.dumps({'images': [{'name': i.name, 'digest': i.digest, 'image_id': i.image_id, 'role': i.role} for i in m.images], 'source_revision': raw.get('source_revision')}))"
)

_BUNDLE_DIRECTORY = "/opt/gugu/sandbox-bundle"


class ImageVerificationError(ValueError):
    """候选 app 镜像不符合轻量组装契约。"""


def _inspect(image: str, docker: str, run: Callable) -> dict:
    result = run(
        [docker, "image", "inspect", image],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ImageVerificationError(f"无法检查 app 镜像：{image}")
    try:
        payload = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ImageVerificationError("Docker image inspect 响应无效") from exc
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        raise ImageVerificationError("Docker image inspect 响应无效")
    return payload[0]


def _docker_call(docker: str, args: list[str], run: Callable):
    return run(
        [docker, *args],
        capture_output=True,
        text=True,
        check=False,
        timeout=900,
    )


def _candidate_images(candidate_image: str, docker: str, run: Callable) -> tuple[list[dict], str | None]:
    smoke = _docker_call(
        docker,
        ["run", "--rm", "--network", "none", "--read-only", "--entrypoint", "python3",
         candidate_image, "-c", _BUNDLE_SMOKE],
        run,
    )
    if smoke.returncode != 0:
        raise ImageVerificationError("候选 app 内的 bundle 摘要校验失败")
    try:
        payload = json.loads(smoke.stdout)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ImageVerificationError("候选 app bundle smoke 输出无效") from exc
    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("images"), list)
        or (payload.get("source_revision") is not None and not isinstance(payload.get("source_revision"), str))
    ):
        raise ImageVerificationError("候选 app bundle smoke 输出无效")
    images = payload["images"]
    if (
        not isinstance(images, list)
        or any(not isinstance(image, dict) or not isinstance(image.get("role"), str) for image in images)
        or {image["role"] for image in images} != {"sandbox", "egress-proxy"}
    ):
        raise ImageVerificationError("候选 app bundle smoke 未返回完整镜像清单")
    return images, payload.get("source_revision")


def _load_and_verify_images(archive_path: str, images: list[dict], docker: str, run: Callable) -> None:
    loaded = _docker_call(docker, ["load", "--input", archive_path], run)
    if loaded.returncode != 0:
        raise ImageVerificationError("无法从候选 app bundle 导入运行镜像")

    for image in images:
        if (
            not isinstance(image.get("name"), str)
            or not isinstance(image.get("digest"), str)
            or not isinstance(image.get("image_id"), str)
        ):
            raise ImageVerificationError("候选 app bundle 镜像信息无效")
        inspected = _docker_call(docker, ["image", "inspect", image["name"]], run)
        if inspected.returncode != 0:
            raise ImageVerificationError("bundle 导入后运行镜像不可用")
        try:
            payload = json.loads(inspected.stdout)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ImageVerificationError("bundle 导入后的镜像信息无效") from exc
        if isinstance(payload, dict):
            payload = [payload]
        if (
            not isinstance(payload, list)
            or len(payload) != 1
            or not isinstance(payload[0], dict)
        ):
            raise ImageVerificationError("bundle 导入后的镜像信息无效")

        local_image = payload[0]
        repo_digests = local_image.get("RepoDigests") or []
        matches_digest = (
            isinstance(repo_digests, list)
            and any(
                isinstance(repo_digest, str)
                and repo_digest.endswith("@" + image["digest"])
                for repo_digest in repo_digests
            )
        )
        local_image_id = local_image.get("Id")
        matches_image_id = (
            isinstance(local_image_id, str)
            and local_image_id in {image["digest"], image["image_id"]}
        )
        if not (matches_digest or matches_image_id):
            raise ImageVerificationError("bundle 导入后的镜像 digest 与 manifest 不一致")


def _run_offline_shell(image: str, docker: str, run: Callable) -> None:
    result = _docker_call(
        docker,
        ["run", "--rm", "--network", "none", "--read-only", "--cap-drop=ALL",
         "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=256m", "--cpus=1",
         "--entrypoint", "/bin/sh", image, "-lc", "printf shell-smoke-ok"],
        run,
    )
    if result.returncode != 0 or result.stdout.strip() != "shell-smoke-ok":
        raise ImageVerificationError("内置沙箱离线 Shell smoke 失败")


def _run_bundle_smoke(
    candidate_image: str,
    docker: str,
    run: Callable,
    expected_source_revision: str | None,
) -> None:
    container_name = f"gugu-candidate-verify-{uuid.uuid4().hex}"
    created = _docker_call(docker, ["create", "--name", container_name, candidate_image], run)
    if created.returncode != 0:
        raise ImageVerificationError("无法创建候选 app 临时容器")
    try:
        with tempfile.TemporaryDirectory(prefix="gugu-candidate-bundle-") as temporary_directory:
            archive_path = f"{temporary_directory}/runtime-images.tar"
            copied = _docker_call(
                docker,
                ["cp", f"{container_name}:{_BUNDLE_DIRECTORY}/runtime-images.tar", archive_path],
                run,
            )
            if copied.returncode != 0:
                raise ImageVerificationError("无法从候选 app 提取内置 runtime bundle")
            images, source_revision = _candidate_images(candidate_image, docker, run)
            if expected_source_revision is not None and source_revision != expected_source_revision:
                raise ImageVerificationError("候选 app 内置 Sandbox bundle 不属于本次源码提交")
            _load_and_verify_images(archive_path, images, docker, run)
            sandbox_image = next(image["name"] for image in images if image["role"] == "sandbox")
            _run_offline_shell(sandbox_image, docker, run)
    finally:
        _docker_call(docker, ["rm", container_name], run)


def verify_embedded_app_image(
    base_image: str,
    candidate_image: str,
    *,
    expected_source_revision: str | None = None,
    run: Callable = subprocess.run,
) -> None:
    docker = shutil.which("docker")
    if docker is None:
        raise ImageVerificationError("未找到 Docker CLI")
    base = _inspect(base_image, docker, run)
    candidate = _inspect(candidate_image, docker, run)

    for field in ("Os", "Architecture", "Variant"):
        if base.get(field) != candidate.get(field):
            raise ImageVerificationError(f"组装改变了 app 镜像平台字段：{field}")
    if not isinstance(base.get("Config"), dict) or base["Config"] != candidate.get("Config"):
        raise ImageVerificationError("组装改变了 app 镜像 Config（环境、入口、labels 等）")

    base_rootfs = base.get("RootFS")
    candidate_rootfs = candidate.get("RootFS")
    base_layers = base_rootfs.get("Layers") if isinstance(base_rootfs, dict) else None
    candidate_layers = candidate_rootfs.get("Layers") if isinstance(candidate_rootfs, dict) else None
    if (
        not isinstance(base_layers, list)
        or not isinstance(candidate_layers, list)
        or candidate_layers[:-1] != base_layers
        or len(candidate_layers) != len(base_layers) + 1
    ):
        raise ImageVerificationError("候选 app 必须保留原镜像层并且只追加一个 bundle 层")

    try:
        _run_bundle_smoke(candidate_image, docker, run, expected_source_revision)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ImageVerificationError("候选 app 内的离线沙箱 Shell smoke 失败") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="bundle 组装前的 app 镜像引用")
    parser.add_argument("--candidate", required=True, help="组装后的候选 app 镜像引用")
    parser.add_argument("--expected-source-revision", help="要求 bundle 绑定到此源码提交 SHA")
    args = parser.parse_args(argv)
    try:
        verify_embedded_app_image(
            args.base,
            args.candidate,
            expected_source_revision=args.expected_source_revision,
        )
    except ImageVerificationError as exc:
        parser.exit(1, f"错误：{exc}\n")
    print("候选 app 镜像配置、平台、bundle 与离线沙箱 Shell smoke 校验通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
