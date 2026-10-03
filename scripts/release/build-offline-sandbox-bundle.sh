#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "用法：$0 --output <bundle.tar> [--image <image>]..." >&2
}

output=
images=()
while (($#)); do
  case "$1" in
    --output)
      (($# >= 2)) || { usage; exit 2; }
      output=$2
      shift 2
      ;;
    --image)
      (($# >= 2)) || { usage; exit 2; }
      images+=("$2")
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$output" ]]; then
  usage
  exit 2
fi
if ((${#images[@]} == 0)); then
  images=(
    "${GUGU_WEB_IMAGE:-coffeiz/gugu-web:latest}"
    "${GUGU_SEARCH_IMAGE:-searxng/searxng:latest}"
  )
fi

command -v docker >/dev/null || { echo '未找到 Docker CLI' >&2; exit 1; }
mkdir -p "$(dirname "$output")"

for image in "${images[@]}"; do
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "本地缺少镜像：$image；请先 docker pull 或 docker load" >&2
    exit 1
  }
done

docker save -o "$output" "${images[@]}"
printf '离线 Compose 镜像包已生成：%s\n' "$output"
