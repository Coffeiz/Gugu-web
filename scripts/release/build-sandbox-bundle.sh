#!/bin/sh
# 为本地构建一体化 Dockerfile 准备随镜像交付的 Sandbox 执行镜像。
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
BUNDLE_DIR="$REPO_ROOT/docker/sandbox/bundle"
IMAGE_REF=coffeiz/gugu-sandbox:bundled
TEMP_ARCHIVE="$BUNDLE_DIR/sandbox-image.tar.gz.tmp"

mkdir -p "$BUNDLE_DIR"
docker build --platform linux/amd64 -f "$REPO_ROOT/docker/sandbox/Dockerfile" \
    -t "$IMAGE_REF" "$REPO_ROOT/docker/sandbox"
docker image inspect --format '{{.Id}}' "$IMAGE_REF" > "$BUNDLE_DIR/image-id.tmp"
grep -Eq '^sha256:[0-9a-f]{64}$' "$BUNDLE_DIR/image-id.tmp"
docker save "$IMAGE_REF" | gzip -1 > "$TEMP_ARCHIVE"
gzip -t "$TEMP_ARCHIVE"
[ -s "$TEMP_ARCHIVE" ]
mv "$TEMP_ARCHIVE" "$BUNDLE_DIR/sandbox-image.tar.gz"
mv "$BUNDLE_DIR/image-id.tmp" "$BUNDLE_DIR/image-id"
echo "本地 Sandbox bundle 已准备：$BUNDLE_DIR"
