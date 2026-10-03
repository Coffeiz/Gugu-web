#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat >&2 <<'EOF'
用法：build-bundled-app-image.sh --base-image <app基础镜像> --candidate-image <最终镜像标签> --bundle-dir <bundle目录> [--archive <输出.tar>] [--expected-source-revision <完整SHA>]

先组装并验证带沙盒的最终 app 镜像；可选导出未压缩 Docker archive。
EOF
    exit 2
}

base_image=""
candidate_image=""
bundle_dir=""
archive=""
expected_source_revision=""

while (($#)); do
    case "$1" in
        --base-image) (($# >= 2)) || usage; base_image="$2"; shift 2 ;;
        --candidate-image) (($# >= 2)) || usage; candidate_image="$2"; shift 2 ;;
        --bundle-dir) (($# >= 2)) || usage; bundle_dir="$2"; shift 2 ;;
        --archive) (($# >= 2)) || usage; archive="$2"; shift 2 ;;
        --expected-source-revision) (($# >= 2)) || usage; expected_source_revision="$2"; shift 2 ;;
        *) usage ;;
    esac
done

[[ -n "$base_image" && -n "$candidate_image" && -n "$bundle_dir" ]] || usage
[[ "$base_image" != "$candidate_image" ]] || {
    echo "基础镜像和最终镜像标签不能相同" >&2
    exit 2
}
if [[ -n "$expected_source_revision" && ! "$expected_source_revision" =~ ^[0-9a-f]{40,64}$ ]]; then
    echo "源码提交 SHA 必须是 40–64 位小写十六进制" >&2
    exit 2
fi
[[ -f "$bundle_dir/runtime-images.tar" && -f "$bundle_dir/manifest.json" ]] || {
    echo "bundle 目录必须同时包含 runtime-images.tar 和 manifest.json" >&2
    exit 1
}
if [[ -n "$archive" ]]; then
    [[ "$archive" == *.tar ]] || {
        echo "Docker archive 必须为未压缩的 .tar" >&2
        exit 2
    }
    [[ ! -e "$archive" ]] || {
        echo "输出文件已存在；请使用新的文件名：$archive" >&2
        exit 1
    }
fi
docker image inspect "$base_image" >/dev/null
if docker image inspect "$candidate_image" >/dev/null 2>&1; then
    echo "最终镜像标签已存在；请使用新的标签：$candidate_image" >&2
    exit 1
fi

docker build --platform linux/amd64 \
    --file Dockerfile.sandbox-bundle \
    --build-arg "APP_IMAGE=$base_image" \
    --tag "$candidate_image" \
    "$bundle_dir"

verify_args=(
    python3 scripts/release/verify_embedded_app_image.py
    --base "$base_image"
    --candidate "$candidate_image"
)
if [[ -n "$expected_source_revision" ]]; then
    verify_args+=(--expected-source-revision "$expected_source_revision")
fi
"${verify_args[@]}"

if [[ -n "$archive" ]]; then
    mkdir -p "$(dirname "$archive")"
    archive_tmp="${archive}.tmp.$$"
    [[ ! -e "$archive_tmp" ]] || {
        echo "临时输出文件已存在；请先检查后使用新名称：$archive_tmp" >&2
        exit 1
    }
    trap 'rm -f "$archive_tmp"' EXIT
    docker save --output "$archive_tmp" "$candidate_image"
    tar -tf "$archive_tmp" >/dev/null
    mv -- "$archive_tmp" "$archive"
    trap - EXIT
    sha256sum "$archive"
    ls -lh "$archive"
fi
