"""Cosign 发布身份与沙盒镜像签名校验。"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


COSIGN_VERIFIER_IMAGE = (
    "ghcr.io/sigstore/cosign/cosign@sha256:"
    "9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8"
)
COSIGN_IDENTITY_REGEXP = (
    r"^https://github\.com/Coffeiz/Gugu-web/\.github/workflows/docker-release\.yml@refs/tags/v.*$"
)
COSIGN_OIDC_ISSUER = "https://token.actions.githubusercontent.com"
COSIGN_VERIFY_TIMEOUT_SECONDS = 300
SANDBOX_IMAGE_RE = re.compile(
    r"^(?:(?:docker\.io|index\.docker\.io|ghcr\.io)/)?coffeiz/gugu-sandbox"
    r"(?::[A-Za-z0-9_.-]{1,128})?@sha256:[0-9a-f]{64}$"
)


def cosign_verify_command(
    image: str,
    *,
    docker_socket: str | None = None,
    cache_dir: Path | None = None,
) -> list[str]:
    """构造使用固定 verifier 和 GitHub Actions 发布身份的验签命令。"""
    command = ["docker"]
    if docker_socket:
        command.extend(["-H", f"unix://{docker_socket}"])
    command.extend(["run", "--rm"])
    if cache_dir is not None:
        command.extend(["-v", f"{cache_dir}:/root/.sigstore"])
    command.extend([
        COSIGN_VERIFIER_IMAGE,
        "verify",
        "--certificate-identity-regexp", COSIGN_IDENTITY_REGEXP,
        "--certificate-oidc-issuer", COSIGN_OIDC_ISSUER,
        image,
    ])
    return command


def verify_sandbox_image_signature(image: str, docker_socket: str) -> bool:
    """验证官方 sandbox 镜像 digest 的签名；不能确定真实性时一律失败。"""
    if not SANDBOX_IMAGE_RE.fullmatch(image):
        raise ValueError("只允许验证官方沙盒镜像的固定 digest")

    command = cosign_verify_command(image, docker_socket=docker_socket)
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=COSIGN_VERIFY_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("Cosign 验签器无法运行或超时") from exc
    if result.returncode != 0:
        raise RuntimeError(f"Cosign 签名验证失败（exit={result.returncode}）")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="验证 Gugu 官方沙盒镜像签名")
    parser.add_argument("--image", required=True)
    parser.add_argument("--docker-socket", required=True)
    args = parser.parse_args()
    try:
        verify_sandbox_image_signature(args.image, args.docker_socket)
    except (RuntimeError, ValueError) as exc:
        print(f"沙盒镜像验签失败：{exc}", file=sys.stderr)
        return 1
    print("沙盒镜像发布签名验证通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
