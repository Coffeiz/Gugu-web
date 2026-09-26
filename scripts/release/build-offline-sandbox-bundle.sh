#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "用法：$0 --output <bundle.tar> --manifest <manifest.json> [--image <image>]..." >&2
}

output=
manifest=
images=()
while (($#)); do
  case "$1" in
    --output)
      (($# >= 2)) || { usage; exit 2; }
      output=$2
      shift 2
      ;;
    --manifest)
      (($# >= 2)) || { usage; exit 2; }
      manifest=$2
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

if [[ -z "$output" || -z "$manifest" ]]; then
  usage
  exit 2
fi
if ((${#images[@]} == 0)); then
  images=(
    "${GUGU_WEB_IMAGE:-coffeiz/gugu-web:latest}"
    "${GUGU_SANDBOX_IMAGE:-coffeiz/gugu-sandbox:latest}"
    "${GUGU_EGRESS_PROXY_IMAGE:-ubuntu/squid:latest}"
    "${GUGU_SEARCH_IMAGE:-searxng/searxng:latest}"
  )
fi

command -v docker >/dev/null || { echo '未找到 Docker CLI' >&2; exit 1; }
command -v python3 >/dev/null || { echo '未找到 Python 3' >&2; exit 1; }

hash_image() {
  if command -v sha256sum >/dev/null; then
    sha256sum | cut -c1-16
  else
    shasum -a 256 | cut -c1-16
  fi
}

mkdir -p "$(dirname "$output")" "$(dirname "$manifest")"
records=$(mktemp)
trap 'rm -f "$records" "$records."*' EXIT

for image in "${images[@]}"; do
  inspect_json=$(docker image inspect "$image" 2>/dev/null) || {
    echo "本地缺少镜像：$image；请先 docker pull 或 docker load" >&2
    exit 1
  }
  inspect_path="$records.$(printf '%s' "$image" | hash_image)"
  printf '%s\n' "$inspect_json" > "$inspect_path"
  printf '%s\t%s\n' "$image" "$inspect_path" >> "$records"
done

docker save -o "$output" "${images[@]}"

python3 - "$records" "$manifest" "$output" <<'PY'
import json
import sys
import tarfile
from pathlib import Path

records_path = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
bundle_path = Path(sys.argv[3])
saved_manifest = json.loads(
    tarfile.open(bundle_path, "r").extractfile("manifest.json").read()
)

config_by_tag = {
    tag: "sha256:" + Path(entry["Config"]).name.removesuffix(".json")
    for entry in saved_manifest
    for tag in entry.get("RepoTags") or []
}

records = []
for line in records_path.read_text(encoding="utf-8").splitlines():
    image, inspect_path = line.split("\t", 1)
    payload = json.loads(Path(inspect_path).read_text(encoding="utf-8"))[0]
    repo_digests = payload.get("RepoDigests") or []
    image_id = payload.get("Id")
    digest = next((value.rsplit("@", 1)[1] for value in repo_digests if "@" in value), None)
    # docker save/load 后实际的本地 image ID 取自 tar 内的 Config 文件，
    # 不一定等于构建机上的 docker image inspect .Id（尤其是 BuildKit 镜像）。
    if not digest:
        digest = config_by_tag.get(image)
        if not isinstance(digest, str):
            raise SystemExit(f"tar 中没有找到镜像配置 digest，不能生成可验证 bundle：{image}")
    image_id = config_by_tag.get(image, image_id)
    records.append({"name": image, "digest": digest, "image_id": image_id})

manifest_path.write_text(
    json.dumps({"schema_version": 1, "images": records}, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY

printf 'bundle 已生成：%s\nmanifest 已生成：%s\n' "$output" "$manifest"
