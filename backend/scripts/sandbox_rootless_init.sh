#!/bin/sh
# 沙盒运行环境初始化（由 sandboxd 启动前执行，幂等可重复运行）。
#
# 背景：沙盒容器由 backend 通过 docker.sock 作为兄弟容器启动，它们运行在
# GUGU_DOCKER_SOCKET 指向的 daemon 上——生产常用 rootless docker，而 compose
# 自己的资源（网络、容器）建在执行 compose 的 daemon 上，两者不互通。此脚本
# 确保目标 daemon 上存在沙盒所需的三样东西：
#   1. egress 内部网络（gugu-sandbox-egress）
#   2. squid 代理容器（egress-proxy，双网络：内部网给沙盒、bridge 给自己出网）
#   3. 沙盒基础镜像（sandboxd 以 --pull=never 启动，镜像必须提前就位）
# rootful 单 daemon 部署下各项已由 compose 提供，这里自然全部跳过。
set -eu

RD_SOCKET="${GUGU_ROOTLESS_DOCKER_SOCKET:-/run/gugu/docker.sock}"
RD="docker -H unix://$RD_SOCKET"
SOURCE_SOCKET=/var/run/docker.sock
SOURCE="docker -H unix://$SOURCE_SOCKET"
SANDBOX_IMAGE="${SANDBOX__IMAGE:-debian:bookworm-slim}"
SANDBOX_IMAGE_DIGEST="${SANDBOX__IMAGE_DIGEST:-}"
SANDBOX_IMAGE_DIGEST_FILE="${GUGU_SANDBOX_IMAGE_DIGEST_FILE:-/run/gugu/sandbox-image-digest}"
SANDBOX_OFFLINE="${GUGU_SANDBOX_OFFLINE:-0}"
BUNDLE_MANIFEST="${GUGU_SANDBOX_BUNDLE_MANIFEST:-/config/sandbox-bundle-manifest.json}"
EGRESS_NETWORK="${SANDBOX__EGRESS_NETWORK_NAME:-gugu-sandbox-egress}"
EGRESS_PROXY_URL="${SANDBOX__EGRESS_PROXY_URL:-http://egress-proxy:3128}"
PROXY_IMAGE="${GUGU_EGRESS_PROXY_IMAGE:-ubuntu/squid:latest}"
USERS_ROOT="${GUGU_DATA_DIR:-/data}/users"

# sandboxd 会在 app 完成启动前先校验并准备执行环境；不能依赖 app 的 lifespan
# 事后创建工作区，否则 allowed_root 的 strict resolve 会让 sandboxd 直接退出。
mkdir -p "$USERS_ROOT"

if ! $RD info >/dev/null 2>&1; then
    echo "沙盒 docker daemon 不可达：$RD_SOCKET" >&2
    exit 1
fi

load_image_if_missing() {
    ref="$1"
    $RD image inspect "$ref" >/dev/null 2>&1 && return 0
    # rootless daemon 常无法直连 registry，优先从宿主 daemon 搬运。
    if [ -S "$SOURCE_SOCKET" ] && $SOURCE image inspect "$ref" >/dev/null 2>&1; then
        echo "从宿主 daemon 搬运镜像 $ref"
        $SOURCE save "$ref" | $RD load
    elif [ "$SANDBOX_OFFLINE" = 1 ]; then
        echo "离线模式禁止拉取：目标 daemon 缺少镜像 $ref，且源 daemon 也没有可搬运镜像" >&2
        exit 1
    else
        echo "直接拉取镜像 $ref"
        $RD pull "$ref"
    fi
}

write_squid_config() {
    path="$1"
    cat > "$path" <<'SQUID_CONF'
http_port 3128
cache deny all
acl SSL_ports port 443
acl Safe_ports port 80 443
acl CONNECT method CONNECT
acl private_dst dst 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 0.0.0.0/8
acl private_dst6 dst ::1/128 fc00::/7 fe80::/10
http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access deny private_dst
http_access deny private_dst6
http_access allow all
via off
forwarded_for delete
request_header_access X-Forwarded-For deny all
request_header_access Via deny all
SQUID_CONF
}

# 1) egress 内部网络
$RD network inspect "$EGRESS_NETWORK" >/dev/null 2>&1 ||
    $RD network create --internal "$EGRESS_NETWORK"

# 2) squid 代理容器。判定顺序：
#    a) compose 管理的代理——容器名带项目前缀（如 gugu-egress-proxy-1），
#       按名字 inspect 找不到，必须用 com.docker.compose.service 标签找；
#    b) 本脚本此前自建的 egress-proxy（inspect 到但没在跑就补启动，避免
#       上次 start 失败留下停止容器导致代理缺席）。
#    两者都不存在才自行创建；创建中途失败必须清掉半成品容器，否则下次
#    inspect 命中直接跳过，代理永远起不来。
proxy_host="${EGRESS_PROXY_URL#*://}"
proxy_host="${proxy_host%%:*}"
proxy_running() {
    $RD container inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q true
}
existing_proxy="$($RD ps -a --filter 'label=com.docker.compose.service=egress-proxy' --format '{{.Names}}' | head -n 1)"
[ -n "$existing_proxy" ] || existing_proxy="$proxy_host"
if ! $RD container inspect "$existing_proxy" >/dev/null 2>&1; then
    load_image_if_missing "$PROXY_IMAGE"
    # 不能用 -v 挂 $SQUID_CONF：bind source 由目标 daemon（rootless）在其宿主机视角解析，
    # 看不到 bootstrap 容器里的 gugu_config 卷路径。docker cp 的源由 CLI（即本容器）解析，
    # 先 create 再拷配置再 start，配置就能真正进到目标 daemon 管理的容器里。
    proxy_config="/tmp/gugu-squid.conf.$$"
    trap 'rm -f "$inspect_file" "$proxy_config"' EXIT
    write_squid_config "$proxy_config"
    if ! $RD create --name "$proxy_host" --network "$EGRESS_NETWORK" \
            --restart unless-stopped "$PROXY_IMAGE" \
            || ! $RD cp "$proxy_config" "$proxy_host:/etc/squid/squid.conf" \
            || ! $RD start "$proxy_host"; then
        echo "代理容器创建失败，清理半成品 $proxy_host" >&2
        $RD rm -f "$proxy_host" >/dev/null 2>&1 || true
        exit 1
    fi
    # squid 自己要走默认桥出网；沙盒侧仍只见内部网络。
    $RD network connect bridge "$proxy_host" || true
elif ! proxy_running "$existing_proxy"; then
    echo "代理容器 $existing_proxy 存在但未运行，重新启动"
    $RD start "$existing_proxy"
fi

# 3) 沙盒执行镜像。默认 Compose 从 registry 拉取 latest，并立即解析为不可变 digest；
#    后续 sandboxd 始终使用该 digest，而不是可变 tag。显式提供 sha256 digest 时沿用固定引用。
ref="$SANDBOX_IMAGE"
if [ "$SANDBOX_OFFLINE" = 1 ]; then
    if [ ! -r "$BUNDLE_MANIFEST" ]; then
        echo "离线模式禁止拉取：找不到 bundle manifest $BUNDLE_MANIFEST，请重新导入完整镜像包" >&2
        exit 1
    fi
    inspect_file="/tmp/gugu-sandbox-inspect.$$"
    trap 'rm -f "$inspect_file"' EXIT
    if ! $RD image inspect "$SANDBOX_IMAGE" > "$inspect_file" 2>/dev/null; then
        echo "离线模式禁止拉取：沙盒镜像 $SANDBOX_IMAGE 未加载到当前 Docker daemon" >&2
        exit 1
    fi
    bundle_values="$(PYTHONPATH=/app python - "$BUNDLE_MANIFEST" "$SANDBOX_IMAGE" "$inspect_file" <<'PY'
import json
import sys
from pathlib import Path

from agent.sandbox.offline_bundle import load_bundle_manifest, validate_local_image

manifest = load_bundle_manifest(Path(sys.argv[1]))
image = manifest.image(sys.argv[2])
validate_local_image(sys.argv[2], image.digest, Path(sys.argv[3]).read_text(), expected_image_id=image.image_id)
print(image.digest)
PY
)" || {
        echo "离线模式镜像校验失败：$SANDBOX_IMAGE" >&2
        exit 1
    }
    mkdir -p "$(dirname "$SANDBOX_IMAGE_DIGEST_FILE")"
    printf '%s\n' "$bundle_values" > "$SANDBOX_IMAGE_DIGEST_FILE"
    ref="$SANDBOX_IMAGE"
elif [ "$SANDBOX_IMAGE_DIGEST" = resolved ]; then
    # 清掉上次成功留下的标记；本次下载或验签失败时，不允许继续使用旧状态假装已就绪。
    rm -f "$SANDBOX_IMAGE_DIGEST_FILE"
    $RD pull "$SANDBOX_IMAGE"
    repo_digests="$($RD image inspect --format '{{json .RepoDigests}}' "$SANDBOX_IMAGE")"
    resolved_digest="$(printf '%s' "$repo_digests" | python -c '
import json, re, sys
image = sys.argv[1]
slash, colon = image.rfind("/"), image.rfind(":")
repo = image[:colon] if colon > slash else image
repo = repo.removeprefix("docker.io/")
try:
    values = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError):
    values = []
for value in values if isinstance(values, list) else []:
    name, separator, digest = value.partition("@")
    name = name.removeprefix("docker.io/")
    if separator and name == repo and re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        print(digest)
        break
' "$SANDBOX_IMAGE")"
    case "$resolved_digest" in
        sha256:????????????????????????????????????????????????????????????????) ;;
        *) echo "无法从已拉取的沙盒镜像解析有效 RepoDigest" >&2; exit 1 ;;
    esac
    case "${resolved_digest#sha256:}" in
        *[!0-9a-f]*) echo "沙盒镜像 RepoDigest 格式无效" >&2; exit 1 ;;
    esac
    ref="$SANDBOX_IMAGE@$resolved_digest"
    PYTHONPATH="/app${PYTHONPATH:+:$PYTHONPATH}" \
        python -m updater.sandbox_signature \
            --image "$ref" --docker-socket "$RD_SOCKET"
    mkdir -p "$(dirname "$SANDBOX_IMAGE_DIGEST_FILE")"
    temporary_digest_file="${SANDBOX_IMAGE_DIGEST_FILE}.tmp.$$"
    printf '%s\n' "$resolved_digest" > "$temporary_digest_file"
    chmod 644 "$temporary_digest_file"
    mv -f "$temporary_digest_file" "$SANDBOX_IMAGE_DIGEST_FILE"
elif [ "$SANDBOX_IMAGE_DIGEST" = local ]; then
    # 本地 tar 导入模式：只使用当前 daemon 中已有的 tag，禁止拼接 digest
    # 或访问 registry，适用于 FNOS/NAS 等无外网环境的验收部署。
    if ! $RD image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
        echo "本地模式禁止拉取：沙盒镜像 $SANDBOX_IMAGE 未加载到当前 Docker daemon" >&2
        exit 1
    fi
    ref="$SANDBOX_IMAGE"
else
    [ -n "$SANDBOX_IMAGE_DIGEST" ] && ref="$SANDBOX_IMAGE@$SANDBOX_IMAGE_DIGEST"
    load_image_if_missing "$ref"
fi

# 目标 daemon 启动的沙盒容器使用独立 UID；文件库目录由业务容器创建时通常是
# 755/660，必须在同一条 Compose bootstrap 链中统一补上映射组 ACL。该步骤幂等，
# 也会验证真实沙盒 UID 能创建并删除文件，避免“挂载 RW 但首次写入才失败”。
PYTHONPATH="/app${PYTHONPATH:+:$PYTHONPATH}" \
    python /usr/local/bin/prepare_rootless_storage.py "$USERS_ROOT" \
    --docker-socket "$RD_SOCKET" --image "$ref" --probe

echo "沙盒环境就绪：网络 $EGRESS_NETWORK、代理 $proxy_host、镜像 $ref"
