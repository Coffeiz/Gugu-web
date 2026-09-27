#!/usr/bin/env python3
"""验证 bundle 组装镜像只新增一层且保留 app 配置。"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from typing import Callable


_BUNDLE_SMOKE = (
    "from agent.sandbox.bundle_runtime import EmbeddedBundleRuntime; "
    "m = EmbeddedBundleRuntime().load_verified_manifest(); "
    "assert m.schema_version == 2; "
    "assert {i.role for i in m.images} == {'sandbox', 'egress-proxy'}; "
    "print('内置 runtime bundle 校验通过')"
)


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


def verify_embedded_app_image(base_image: str, candidate_image: str, *, run: Callable = subprocess.run) -> None:
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
        smoke = run(
            [
                docker, "run", "--rm", "--network", "none", "--read-only",
                "--entrypoint", "python3", candidate_image, "-c", _BUNDLE_SMOKE,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ImageVerificationError("候选 app 内的 bundle smoke 失败") from exc
    if smoke.returncode != 0:
        raise ImageVerificationError("候选 app 内的 bundle smoke 失败")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="bundle 组装前的 app 镜像引用")
    parser.add_argument("--candidate", required=True, help="组装后的候选 app 镜像引用")
    args = parser.parse_args(argv)
    try:
        verify_embedded_app_image(args.base, args.candidate)
    except ImageVerificationError as exc:
        parser.exit(1, f"错误：{exc}\n")
    print("候选 app 镜像配置、平台与内置 bundle 校验通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
