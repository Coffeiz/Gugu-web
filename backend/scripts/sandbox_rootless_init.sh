#!/bin/sh
# 沙盒环境一次性引导（compose sandbox-bootstrap 服务执行，幂等可重复运行）。
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
EGRESS_NETWORK="${SANDBOX__EGRESS_NETWORK_NAME:-gugu-sandbox-egress}"
EGRESS_PROXY_URL="${SANDBOX__EGRESS_PROXY_URL:-http://egress-proxy:3128}"
PROXY_IMAGE="${GUGU_EGRESS_PROXY_IMAGE:-ubuntu/squid:latest}"
SQUID_CONF="${SQUID_CONF_PATH:-/config/squid/egress.conf}"

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
    else
        echo "直接拉取镜像 $ref"
        $RD pull "$ref"
    fi
}

# 1) egress 内部网络
$RD network inspect "$EGRESS_NETWORK" >/dev/null 2>&1 ||
    $RD network create --internal "$EGRESS_NETWORK"

# 2) squid 代理容器（已存在则不动；compose rootful 部署的 egress-proxy 也命中此分支）
proxy_host="${EGRESS_PROXY_URL#*://}"
proxy_host="${proxy_host%%:*}"
if ! $RD container inspect "$proxy_host" >/dev/null 2>&1; then
    load_image_if_missing "$PROXY_IMAGE"
    $RD run -d --name "$proxy_host" --network "$EGRESS_NETWORK" \
        --restart unless-stopped \
        -v "$SQUID_CONF:/etc/squid/squid.conf:ro" "$PROXY_IMAGE"
    # squid 自己要走默认桥出网；沙盒侧仍只见内部网络。
    $RD network connect bridge "$proxy_host" || true
fi

# 3) 沙盒基础镜像（配置校验用 tag@digest 引用，必须能被 inspect 到）
ref="$SANDBOX_IMAGE"
[ -n "$SANDBOX_IMAGE_DIGEST" ] && ref="$SANDBOX_IMAGE@$SANDBOX_IMAGE_DIGEST"
load_image_if_missing "$ref"

echo "沙盒环境就绪：网络 $EGRESS_NETWORK、代理 $proxy_host、镜像 $ref"
