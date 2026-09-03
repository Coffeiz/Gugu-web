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
    if ! $RD create --name "$proxy_host" --network "$EGRESS_NETWORK" \
            --restart unless-stopped "$PROXY_IMAGE" \
            || ! $RD cp "$SQUID_CONF" "$proxy_host:/etc/squid/squid.conf" \
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

# 3) 沙盒基础镜像（配置校验用 tag@digest 引用，必须能被 inspect 到）
ref="$SANDBOX_IMAGE"
[ -n "$SANDBOX_IMAGE_DIGEST" ] && ref="$SANDBOX_IMAGE@$SANDBOX_IMAGE_DIGEST"
load_image_if_missing "$ref"

echo "沙盒环境就绪：网络 $EGRESS_NETWORK、代理 $proxy_host、镜像 $ref"
